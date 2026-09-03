import { beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/auth/key.js";
import type { Env } from "../src/bindings.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY, POLICY_CEILINGS } from "../src/policy/defaults.js";
import { CONFIG_KEY, keyHashKey, keyRecordKey } from "../src/storage/keys.js";
import { memoryBucket } from "./memory-bucket.js";
import type { MemoryBucket } from "./memory-bucket.js";

/**
 * `config get|set` (AGENTS.md, "Instance policy").
 *
 * Two layers: DEFAULTS fill in what a caller omits, RULES are enforced
 * whatever the caller sends. `config set` is prospective — it changes what
 * future calls resolve to and never rewrites a drop that already exists — and
 * the response says so, because an operator who tightens expiry will otherwise
 * assume old drops moved with it.
 */
const ADMIN_KEY = "a".repeat(64);
const USER_KEY = "b".repeat(64);

let bucket: MemoryBucket;
let env: Env;

async function seedKey(key: string, id: string, label: string, scope: "admin" | "user") {
  const hash = await hashKey(key);
  bucket.seed(keyHashKey(hash), JSON.stringify({ id }));
  bucket.seed(
    keyRecordKey(id),
    JSON.stringify({ id, label, scope, hash, created: "2026-09-01T00:00:00Z" }),
  );
}

beforeEach(async () => {
  bucket = memoryBucket();
  bucket.seed(
    CONFIG_KEY,
    JSON.stringify({
      ...INITIAL_POLICY,
      canonical_url: "https://drops.test",
      alias_origins: [],
      instance_name: "acme",
    }),
  );
  await seedKey(ADMIN_KEY, "admin", "admin", "admin");
  await seedKey(USER_KEY, "id-anna", "anna", "user");
  env = { BUCKET: bucket, OAUTH_KV: {} as never, HMAC_SECRET: "s".repeat(32) };
});

async function call(path: string, init: RequestInit = {}, key = ADMIN_KEY): Promise<Response> {
  return createApp().fetch(
    new Request(`https://drops.test${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    }),
    env,
  );
}

const patch = (body: unknown, key = ADMIN_KEY) =>
  call("/_api/v1/config", { method: "PATCH", body: JSON.stringify(body) }, key);

async function errorOf(response: Response): Promise<{ status: number; code: string }> {
  const body = (await response.json()) as { error: { code: string } };
  return { status: response.status, code: body.error.code };
}

type ConfigBody = {
  policy: typeof INITIAL_POLICY;
  canonical_url: string;
  alias_origins: string[];
  instance_name: string;
  note?: string;
};

describe("config get", () => {
  it("returns the whole policy plus the instance's identity", async () => {
    const response = await call("/_api/v1/config");
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConfigBody;

    expect(body.policy).toEqual(INITIAL_POLICY);
    expect(body.canonical_url).toBe("https://drops.test");
    expect(body.instance_name).toBe("acme");
  });

  it("needs the admin key", async () => {
    expect(await errorOf(await call("/_api/v1/config", {}, USER_KEY))).toEqual({
      status: 403,
      code: "FORBIDDEN_SCOPE",
    });
  });
});

describe("config set", () => {
  it("changes only the fields given and returns the whole policy", async () => {
    const response = await patch({ expiry: { max: "90d" } });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as ConfigBody;

    expect(body.policy.expiry.max).toBe("90d");
    expect(body.policy.expiry.default).toBe(INITIAL_POLICY.expiry.default);
    expect(body.policy.max_request_bytes).toBe(INITIAL_POLICY.max_request_bytes);
  });

  it("says in the response that the change is prospective", async () => {
    const body = (await (await patch({ noindex: { forced: true } })).json()) as ConfigBody;
    expect(body.note ?? "").toMatch(/future calls/i);
  });

  it("persists, so the next call resolves against the new policy", async () => {
    expect((await patch({ expiry: { default: "1d", max: "2d", allow_never: false } })).status).toBe(200);
    const body = (await (await call("/_api/v1/config")).json()) as ConfigBody;
    expect(body.policy.expiry).toEqual({ default: "1d", max: "2d", allow_never: false });
  });

  it("refuses a max the current default would already break", async () => {
    // The default is "30d"; lowering the max alone would leave every omitted
    // `expires` resolving to a value the same policy forbids.
    expect(await errorOf(await patch({ expiry: { max: "2d" } }))).toEqual({
      status: 400,
      code: "POLICY_VIOLATION",
    });
  });

  it("enforces the new rule on the very next publish", async () => {
    expect((await patch({ expiry: { default: "1d", max: "2d" } })).status).toBe(200);

    const response = await call("/_api/v1/drops", {
      method: "POST",
      body: JSON.stringify({ files: [{ path: "a.txt", text: "x" }], expires: "30d" }),
    });
    expect(await errorOf(response)).toEqual({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("refuses an unknown policy key rather than storing it", async () => {
    expect(await errorOf(await patch({ max_drops: 5 }))).toEqual({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("refuses to move the instance's identity, which init owns", async () => {
    for (const body of [
      { canonical_url: "https://elsewhere.test" },
      { instance_name: "other" },
      { alias_origins: ["https://x.test"] },
    ]) {
      expect(await errorOf(await patch(body))).toEqual({ status: 400, code: "INVALID_INPUT" });
    }
  });

  it("refuses a value above the hard ceiling", async () => {
    expect(
      await errorOf(await patch({ max_request_bytes: POLICY_CEILINGS.max_request_bytes + 1 })),
    ).toEqual({ status: 400, code: "POLICY_VIOLATION" });

    expect(
      await errorOf(await patch({ max_file_bytes: POLICY_CEILINGS.max_file_bytes + 1 })),
    ).toEqual({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("refuses a PBKDF2 count the runtime will not run", async () => {
    expect(
      await errorOf(await patch({ pbkdf2_iterations: POLICY_CEILINGS.pbkdf2_iterations + 1 })),
    ).toEqual({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("accepts a PBKDF2 count inside the ceiling", async () => {
    const body = (await (await patch({ pbkdf2_iterations: 50_000 })).json()) as ConfigBody;
    expect(body.policy.pbkdf2_iterations).toBe(50_000);
  });

  it("refuses a cron budget above the subrequest limit", async () => {
    expect(
      await errorOf(await patch({ cron_ops_budget: POLICY_CEILINGS.cron_ops_budget + 1 })),
    ).toEqual({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("refuses an expiry spelling nothing can resolve", async () => {
    expect(await errorOf(await patch({ expiry: { max: "soon" } }))).toEqual({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("refuses a default expiry the new max forbids", async () => {
    expect(await errorOf(await patch({ expiry: { default: "90d", max: "30d" } }))).toEqual({
      status: 400,
      code: "POLICY_VIOLATION",
    });
  });

  it("refuses never as a default when never is not allowed", async () => {
    expect(
      await errorOf(await patch({ expiry: { default: "never", allow_never: false } })),
    ).toEqual({ status: 400, code: "POLICY_VIOLATION" });
  });

  it("refuses a password default shorter than the minimum", async () => {
    expect(await errorOf(await patch({ password: { default: "short" } }))).toEqual({
      status: 400,
      code: "POLICY_VIOLATION",
    });
  });

  it("accepts generate and null as password defaults", async () => {
    expect((await patch({ password: { default: "generate", required: true } })).status).toBe(200);
    expect((await patch({ password: { default: null, required: false } })).status).toBe(200);
  });

  it("refuses an auto_index v1 does not serve", async () => {
    expect(await errorOf(await patch({ auto_index: "gallery" }))).toEqual({
      status: 400,
      code: "POLICY_VIOLATION",
    });
  });

  it("refuses a non-integer byte limit", async () => {
    expect(await errorOf(await patch({ max_request_bytes: 1.5 }))).toEqual({
      status: 400,
      code: "INVALID_INPUT",
    });
  });

  it("refuses an empty patch, which would be a write for nothing", async () => {
    expect(await errorOf(await patch({}))).toEqual({ status: 400, code: "INVALID_INPUT" });
  });

  it("needs the admin key", async () => {
    expect(await errorOf(await patch({ expiry: { max: "90d" } }, USER_KEY))).toEqual({
      status: 403,
      code: "FORBIDDEN_SCOPE",
    });
  });

  it("writes the config as one object, keeping the instance identity intact", async () => {
    await patch({ expiry: { max: "90d" } });
    const stored = JSON.parse(bucket.read(CONFIG_KEY)!) as Record<string, unknown>;

    expect(stored.canonical_url).toBe("https://drops.test");
    expect(stored.instance_name).toBe("acme");
    expect((stored.expiry as { max: string }).max).toBe("90d");
  });
});
