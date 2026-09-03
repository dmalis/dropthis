/**
 * The HTTP client: one registry operation in, the instance's answer out.
 *
 * It knows nothing about any operation. The registry entry says the method,
 * the path (with its `:params`) and which inputs travel in the query; the rest
 * of the input is the JSON body. A non-2xx answer with the frozen error object
 * becomes a `CliError` carrying the instance's own remediation; anything that
 * is not JSON — a captive portal, a wrong URL, a proxy page — is `INTERNAL`
 * with what was actually received, so an agent is never left parsing HTML.
 */
import { openAsBlob } from "node:fs";
import type { Operation } from "../../../worker/src/registry/index.js";
import { CliError, isErrorObject } from "./errors.js";
import type { LocalFile } from "./files.js";

export type Instance = { url: string; key: string };

export type Answer<T = unknown> = { status: number; value: T };

type FetchLike = typeof fetch;

export class ApiClient {
  constructor(
    readonly instance: Instance,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async call<T = unknown>(op: Operation<never>, input: Record<string, unknown>): Promise<Answer<T>> {
    const remaining: Record<string, unknown> = { ...input };

    let path = op.path;
    for (const name of op.params ?? []) {
      path = path.replace(`:${name}`, encodeURIComponent(String(remaining[name] ?? "")));
      delete remaining[name];
    }

    const url = new URL(`${this.instance.url}/_api/v1${path}`);
    for (const name of op.query ?? []) {
      const value = remaining[name];
      delete remaining[name];
      if (value === undefined) continue;
      url.searchParams.set(name, String(value));
    }

    const withBody = op.method === "POST" || op.method === "PATCH" || op.method === "PUT";
    const headers: Record<string, string> = { authorization: `Bearer ${this.instance.key}` };
    if (withBody) headers["content-type"] = "application/json";

    return this.send<T>(url.toString(), {
      method: op.method,
      headers,
      ...(withBody ? { body: JSON.stringify(remaining) } : {}),
    });
  }

  /** A staged blob PUT: the URL carries its own credential, the file streams from disk. */
  async putBlob(url: string, file: LocalFile): Promise<Answer> {
    const body = await openAsBlob(file.file);
    return this.send(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
  }

  private async send<T>(url: string, init: RequestInit): Promise<Answer<T>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      throw new CliError(
        "INTERNAL",
        `Could not reach ${this.instance.url}: ${cause ?? (error as Error).message}.`,
        "Check DROPTHIS_URL (or the instance's url in instances.json) and the network, then retry.",
        true,
      );
    }

    if (response.status === 204) return { status: 204, value: null as T };

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CliError(
        "INTERNAL",
        `${this.instance.url} answered ${response.status} with ${describeBody(response, text)}, not JSON.`,
        "Check that DROPTHIS_URL points at a dropthis instance.",
        false,
      );
    }

    if (response.ok) return { status: response.status, value: parsed as T };

    const wire = (parsed as { error?: unknown }).error;
    if (isErrorObject(wire)) {
      throw new CliError(wire.code, wire.message, wire.remediation, wire.retryable);
    }
    throw new CliError(
      "INTERNAL",
      `${this.instance.url} answered ${response.status} without the dropthis error object.`,
      "Check that DROPTHIS_URL points at a dropthis instance.",
      false,
    );
  }
}

function describeBody(response: Response, text: string): string {
  const type = response.headers.get("content-type");
  if (type !== null) return type.split(";")[0]!.trim();
  return text.length === 0 ? "an empty body" : `${text.length} bytes of text`;
}
