/**
 * The instance-name normalization, in one function (AGENTS.md, "Multi-client
 * hosting": `init --name <name>` derives every resource from the NORMALISED
 * name, `[a-z0-9-]`, 3–30).
 *
 * The name is not decoration: it becomes the Worker `dropthis-<name>`, the
 * bucket `dropthis-<name>-drops`, the KV namespace `dropthis-<name>-oauth`,
 * the key of the instance in `~/.config/dropthis/instances.json`, and a
 * DIRECTORY under the operator's config home that holds the rendered wrangler
 * config and, for the seconds a deploy lasts, the secrets file. So a raw value
 * reaching any of those is both a resource-name error and a path traversal —
 * `--name ../../x` writes outside the config home.
 *
 * Normalisation mirrors `normalizeLabel`: NFKC, lowercase, trim, whitespace to
 * `-`; `_` too, because an operator who types `client_x` means `client-x` and
 * R2 bucket names hold no underscore. What survives must be ASCII a-z0-9-,
 * 3 to 30 characters, starting and ending alphanumeric.
 */
export const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export class InstanceNameError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "InstanceNameError";
  }
}

export function normalizeInstanceName(raw: string): string {
  const normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/gu, "-");

  if (!INSTANCE_NAME_PATTERN.test(normalized)) {
    throw new InstanceNameError(
      `An instance name is 3 to 30 characters of a-z, 0-9 and -, starting and ending with a letter or digit; ` +
        `${JSON.stringify(raw)} normalizes to ${JSON.stringify(normalized)}.`,
    );
  }
  return normalized;
}
