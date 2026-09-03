import { inject } from "vitest";
import { BASE_URL } from "./base-url.js";

/**
 * The authenticated HTTP client every contract test calls the deployed dev
 * Worker through. The admin key comes from `global-setup.ts`, which mints one
 * per run and writes its records through the R2 API — the same three keys
 * `init` writes before a first deploy.
 */
export const adminKey = (): string => inject("adminKey");

export type Json = Record<string, unknown>;

export function api(path: string, init: RequestInit = {}, key?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  const bearer = key === undefined ? adminKey() : key;
  if (bearer !== "") headers.set("authorization", `Bearer ${bearer}`);
  return fetch(`${BASE_URL}${path}`, { cache: "no-store", ...init, headers });
}

/** A JSON call: the body serialised, the content type set. */
export function apiJson(
  path: string,
  method: string,
  body: unknown,
  key?: string,
): Promise<Response> {
  return api(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    key,
  );
}

export async function errorOf(
  response: Response,
): Promise<{ status: number; code: string; body: Json }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code, body: body as unknown as Json };
}

/** Mint a `user`-scope key through the real `user add`, and return it. */
export async function addUser(label: string): Promise<{ key: string; id: string }> {
  const response = await apiJson("/_api/v1/users", "POST", { label });
  if (response.status !== 201) {
    throw new Error(`user add ${label} failed: ${response.status} ${await response.text()}`);
  }
  const result = (await response.json()) as { key: string; user: { id: string } };
  return { key: result.key, id: result.user.id };
}
