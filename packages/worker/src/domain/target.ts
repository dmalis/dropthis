/**
 * Targets: how `get`, `update` and `delete` accept "the drop" from an agent
 * (docs/spec-v1.md, "Canonical origin").
 *
 * An agent that made a drop five days ago remembers a URL, not a slug, so both
 * are accepted. A URL from a DIFFERENT instance is the interesting case: it is
 * `WRONG_INSTANCE`, not `NOT_FOUND`, because the drop exists — the agent is
 * simply talking to the wrong Worker, and that is a fixable mistake.
 *
 * This lives here, not in a route handler, because the CLI and the MCP layer
 * resolve the target before the REST call ever happens.
 */
import { isSlug } from "./slug.js";

export type InstanceOrigins = {
  /** The origin every generated drop URL uses. */
  canonicalUrl: string;
  /** Origins that answer for this instance but redirect to the canonical one. */
  aliasOrigins: readonly string[];
};

export class TargetError extends Error {
  readonly code: "INVALID_INPUT" | "WRONG_INSTANCE";

  constructor(code: "INVALID_INPUT" | "WRONG_INSTANCE", message: string) {
    super(message);
    this.name = "TargetError";
    this.code = code;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function resolveTarget(target: string, origins: InstanceOrigins): string {
  if (isSlug(target)) return target;

  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    throw new TargetError(
      "INVALID_INPUT",
      `${JSON.stringify(target)} is neither a 10-character slug nor a URL.`,
    );
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new TargetError("INVALID_INPUT", `${JSON.stringify(target)} is not a valid URL.`);
  }

  // A non-web scheme is a malformed target, never another instance: telling the
  // agent to "send this URL to the instance that published it" would be wrong.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TargetError("INVALID_INPUT", `${url.protocol} is not an http(s) drop URL.`);
  }

  const known = new Set(
    [origins.canonicalUrl, ...origins.aliasOrigins]
      .map(originOf)
      .filter((origin): origin is string => origin !== null),
  );
  if (!known.has(url.origin)) {
    throw new TargetError(
      "WRONG_INSTANCE",
      `${url.origin} is not this instance; this one publishes at ${origins.canonicalUrl}.`,
    );
  }

  const slug = url.pathname.split("/")[1] ?? "";
  if (!isSlug(slug)) {
    throw new TargetError("INVALID_INPUT", `${target} does not name a drop on this instance.`);
  }
  return slug;
}

/** The canonical URL of a drop — the one string `publish` hands back. */
export function dropUrl(slug: string, canonicalUrl: string): string {
  return `${canonicalUrl.replace(/\/+$/, "")}/${slug}/`;
}
