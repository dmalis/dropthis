import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * A stand-in for the slice of the Cloudflare v4 API that `scripts/deploy-dev.mjs`
 * uses: token verify, workers.dev subdomain, R2 bucket list/create and KV
 * namespace list/create. It answers with Cloudflare's JSON envelope and its
 * pagination rules (R2: `per_page` + `start_after`; KV: `page` + `per_page`),
 * and it records every request so a test can assert that no create happened.
 */
/** The permission scopes the fake understands, named as the dashboard would. */
export type FakeScope = "r2" | "kv" | "workers";

/** A deployed Worker script, as the fake remembers it. */
export type FakeScript = {
  name: string;
  secrets: string[];
  bindings: Array<Record<string, unknown>>;
};

export type FakeZone = { id: string; name: string; account: { id: string } };
export type FakeDnsRecord = { id: string; zoneId: string; name: string; type: string };
export type FakeWorkerDomain = { id: string; hostname: string; service: string; zone_id: string };

export type FakeState = {
  token: string;
  accountId: string;
  subdomain: string;
  buckets: string[];
  namespaces: Array<{ id: string; title: string }>;
  /** bucket name -> object key -> stored body (as raw bytes + content type) */
  objects: Map<string, Map<string, { body: Uint8Array; contentType: string }>>;
  lifecycleRules: Map<string, unknown[]>;
  /** script name -> what a deploy left behind (secrets and bindings). */
  scripts: Map<string, FakeScript>;
  zones: FakeZone[];
  dnsRecords: FakeDnsRecord[];
  workerDomains: FakeWorkerDomain[];
  accounts: Array<{ id: string; name: string }>;
  /** Scopes the token does NOT have — used to test named-permission preflight. */
  missingScopes: FakeScope[];
  /** false simulates the account never having enabled the R2 subscription (10042). */
  r2SubscriptionEnabled: boolean;
  perPage: number;
  calls: Array<{ method: string; path: string; query: Record<string, string> }>;
};

export type FakeOptions = {
  token?: string;
  accountId?: string;
  subdomain?: string;
  buckets?: string[];
  namespaces?: Array<{ id: string; title: string }>;
  accounts?: Array<{ id: string; name: string }>;
  missingScopes?: FakeScope[];
  r2SubscriptionEnabled?: boolean;
  zones?: FakeZone[];
  dnsRecords?: FakeDnsRecord[];
  /** Page size the fake enforces regardless of what the client asks for. */
  perPage?: number;
  /**
   * Called when a stub wrangler reports a deploy. A test uses it to hand the
   * bucket it just wrote to an already-running instance, which is the only
   * way to have a localhost URL BEFORE the deploy that fills the bucket.
   */
  onDeploy?: (script: FakeScript) => Promise<void> | void;
};

type Envelope<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
  result: T;
  result_info?: Record<string, unknown>;
};

const ok = <T>(result: T, resultInfo?: Record<string, unknown>): Envelope<T> => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...(resultInfo ? { result_info: resultInfo } : {}),
});

const fail = (code: number, message: string): Envelope<null> => ({
  success: false,
  errors: [{ code, message }],
  messages: [],
  result: null,
});

export function createFakeCloudflare(options: FakeOptions = {}) {
  const state: FakeState = {
    token: options.token ?? "fake-token",
    accountId: options.accountId ?? "fake-account-id",
    subdomain: options.subdomain ?? "fake-subdomain",
    buckets: [...(options.buckets ?? [])],
    namespaces: [...(options.namespaces ?? [])],
    objects: new Map(),
    lifecycleRules: new Map(),
    scripts: new Map(),
    zones: [...(options.zones ?? [])],
    dnsRecords: [...(options.dnsRecords ?? [])],
    workerDomains: [],
    accounts: options.accounts ?? [{ id: options.accountId ?? "fake-account-id", name: "Fake Account" }],
    missingScopes: [...(options.missingScopes ?? [])],
    r2SubscriptionEnabled: options.r2SubscriptionEnabled ?? true,
    perPage: options.perPage ?? 20,
    calls: [],
  };

  const app = new Hono();

  /** Returns a 403 envelope when the fake's token lacks `scope`, else undefined. */
  const requireScope = (scope: FakeScope) =>
    state.missingScopes.includes(scope)
      ? fail(10000, `Authentication error: missing permission for ${scope}`)
      : undefined;

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    state.calls.push({
      method: c.req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    if (url.pathname.startsWith("/__")) return next();
    if (c.req.header("authorization") !== `Bearer ${state.token}`) {
      return c.json(fail(9109, "Invalid access token"), 401);
    }
    return next();
  });

  app.get("/__calls", (c) => c.json(state.calls));

  app.get("/client/v4/user/tokens/verify", (c) =>
    c.json(ok({ id: "fake-token-id", status: "active" })),
  );

  app.get("/client/v4/accounts/:accountId/workers/subdomain", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const forbidden = requireScope("workers");
    if (forbidden) return c.json(forbidden, 403);
    return c.json(ok({ subdomain: state.subdomain }));
  });

  // R2 buckets are ordered lexicographically and paged with `start_after`.
  app.get("/client/v4/accounts/:accountId/r2/buckets", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    if (!state.r2SubscriptionEnabled) {
      return c.json(fail(10042, "The R2 subscription for this account has not been enabled"), 403);
    }
    const forbidden = requireScope("r2");
    if (forbidden) return c.json(forbidden, 403);
    const startAfter = c.req.query("start_after");
    const sorted = [...state.buckets].sort();
    const page = sorted
      .filter((name) => (startAfter === undefined ? true : name > startAfter))
      .slice(0, state.perPage)
      .map((name) => ({ name, creation_date: "2026-01-01T00:00:00.000Z" }));
    return c.json(ok({ buckets: page }));
  });

  app.post("/client/v4/accounts/:accountId/r2/buckets", async (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    if (!state.r2SubscriptionEnabled) {
      return c.json(fail(10042, "The R2 subscription for this account has not been enabled"), 403);
    }
    const forbidden = requireScope("r2");
    if (forbidden) return c.json(forbidden, 403);
    const body = (await c.req.json()) as { name?: string };
    const name = body.name;
    if (typeof name !== "string" || name.length === 0) {
      return c.json(fail(10040, "Invalid bucket name"), 400);
    }
    if (state.buckets.includes(name)) {
      return c.json(fail(10004, "The bucket you tried to create already exists"), 400);
    }
    state.buckets.push(name);
    return c.json(ok({ name, creation_date: "2026-01-01T00:00:00.000Z" }));
  });

  // KV namespaces use 1-based `page` + `per_page` with a `result_info` envelope.
  app.get("/client/v4/accounts/:accountId/storage/kv/namespaces", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const forbidden = requireScope("kv");
    if (forbidden) return c.json(forbidden, 403);
    const page = Number(c.req.query("page") ?? "1");
    const start = (page - 1) * state.perPage;
    const slice = state.namespaces.slice(start, start + state.perPage);
    return c.json(
      ok(slice, {
        page,
        per_page: state.perPage,
        count: slice.length,
        total_count: state.namespaces.length,
      }),
    );
  });

  app.post("/client/v4/accounts/:accountId/storage/kv/namespaces", async (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const body = (await c.req.json()) as { title?: string };
    const title = body.title;
    if (typeof title !== "string" || title.length === 0) {
      return c.json(fail(10001, "Invalid namespace title"), 400);
    }
    if (state.namespaces.some((n) => n.title === title)) {
      return c.json(fail(10014, "A namespace with this account ID and title already exists"), 400);
    }
    const namespace = {
      id: `kv-id-${state.namespaces.length + 1}`.padEnd(32, "0"),
      title,
    };
    state.namespaces.push(namespace);
    return c.json(ok(namespace));
  });

  // R2 object read/write: PUT/GET on the account's per-bucket object store.
  // Real Cloudflare returns raw bytes on a successful GET (not the JSON
  // envelope) and 404 with the usual envelope when the key is missing.
  app.put("/client/v4/accounts/:accountId/r2/buckets/:bucketName/objects/:key{.+}", async (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const bucketName = c.req.param("bucketName");
    if (!state.buckets.includes(bucketName)) {
      return c.json(fail(10006, "The specified bucket does not exist"), 404);
    }
    const key = c.req.param("key");
    const body = new Uint8Array(await c.req.arrayBuffer());
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    let bucket = state.objects.get(bucketName);
    if (!bucket) {
      bucket = new Map();
      state.objects.set(bucketName, bucket);
    }
    bucket.set(key, { body, contentType });
    return c.json(ok({ key, etag: `fake-etag-${key}`, size: String(body.length), uploaded: "2026-01-01T00:00:00.000Z" }));
  });

  app.get("/client/v4/accounts/:accountId/r2/buckets/:bucketName/objects/:key{.+}", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const bucketName = c.req.param("bucketName");
    const key = c.req.param("key");
    const object = state.objects.get(bucketName)?.get(key);
    if (!object) return c.json(fail(10007, "The specified key does not exist"), 404);
    return new Response(object.body, { status: 200, headers: { "content-type": object.contentType } });
  });

  app.delete("/client/v4/accounts/:accountId/r2/buckets/:bucketName/objects/:key{.+}", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const bucketName = c.req.param("bucketName");
    const key = c.req.param("key");
    state.objects.get(bucketName)?.delete(key);
    return c.json(ok({ key }));
  });

  // R2 lifecycle rules: the fake just stores and echoes what was set.
  app.put("/client/v4/accounts/:accountId/r2/buckets/:bucketName/lifecycle", async (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const bucketName = c.req.param("bucketName");
    const body = (await c.req.json()) as { rules?: unknown[] };
    state.lifecycleRules.set(bucketName, body.rules ?? []);
    return c.json(ok({}));
  });

  app.get("/client/v4/accounts/:accountId/r2/buckets/:bucketName/lifecycle", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const bucketName = c.req.param("bucketName");
    return c.json(ok({ rules: state.lifecycleRules.get(bucketName) ?? [] }));
  });

  // Account listing: used by the installer to pin an account or refuse to
  // guess between several.
  app.get("/client/v4/accounts", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const perPage = Number(c.req.query("per_page") ?? String(state.perPage));
    const start = (page - 1) * perPage;
    const slice = state.accounts.slice(start, start + perPage);
    return c.json(
      ok(slice, { page, per_page: perPage, count: slice.length, total_count: state.accounts.length }),
    );
  });


  /**
   * A deploy, as the fake sees it: `wrangler deploy` is never run here, so the
   * stub deploy (in-process or a spawned stub binary) POSTs what it uploaded.
   * That is what makes `worker secrets` and `kv_bound` answerable offline.
   */
  app.post("/__deploy", async (c) => {
    const body = (await c.req.json()) as {
      name?: string;
      secrets?: string[];
      bindings?: Array<Record<string, unknown>>;
    };
    const name = body.name ?? "";
    const existing = state.scripts.get(name);
    state.scripts.set(name, {
      name,
      // A deploy without a secrets file keeps the secrets the script already
      // has: that is exactly what Cloudflare does, and the rule the rerun
      // depends on (a re-shipped HMAC_SECRET would invalidate every cookie).
      secrets: [...new Set([...(existing?.secrets ?? []), ...(body.secrets ?? [])])],
      bindings: body.bindings ?? existing?.bindings ?? [],
    });
    await options.onDeploy?.(state.scripts.get(name)!);
    return c.json(ok({ name }));
  });

  app.get("/client/v4/accounts/:accountId/workers/scripts/:scriptName/secrets", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const script = state.scripts.get(c.req.param("scriptName"));
    if (!script) return c.json(fail(10007, "workers.api.error.script_not_found"), 404);
    return c.json(ok(script.secrets.map((name) => ({ name, type: "secret_text" }))));
  });

  // The metadata a deploy wrote (bindings, compatibility date). NOT
  // `/script-settings`, which is logpush and tags.
  app.get("/client/v4/accounts/:accountId/workers/scripts/:scriptName/settings", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const script = state.scripts.get(c.req.param("scriptName"));
    if (!script) return c.json(fail(10007, "workers.api.error.script_not_found"), 404);
    return c.json(ok({ bindings: script.bindings }));
  });

  // Zones the token can see, for the longest-suffix match `--domain` needs.
  app.get("/client/v4/zones", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const perPage = Number(c.req.query("per_page") ?? String(state.perPage));
    const start = (page - 1) * perPage;
    const slice = state.zones.slice(start, start + perPage);
    return c.json(
      ok(slice, { page, per_page: perPage, count: slice.length, total_count: state.zones.length }),
    );
  });

  app.get("/client/v4/zones/:zoneId/dns_records", (c) => {
    const zoneId = c.req.param("zoneId");
    // The SDK sends the exact-name filter as `name.exact` (its `Name` filter
    // object); a bare `name` is what a hand-written call would send.
    const name = c.req.query("name.exact") ?? c.req.query("name");
    const matching = state.dnsRecords.filter(
      (record) => record.zoneId === zoneId && (name === undefined || record.name === name),
    );
    return c.json(
      ok(matching.map(({ id, name: recordName, type }) => ({ id, name: recordName, type })), {
        page: 1,
        per_page: state.perPage,
        count: matching.length,
        total_count: matching.length,
      }),
    );
  });

  app.get("/client/v4/accounts/:accountId/workers/domains", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const hostname = c.req.query("hostname");
    const matching = state.workerDomains.filter(
      (domain) => hostname === undefined || domain.hostname === hostname,
    );
    return c.json(ok(matching));
  });

  app.put("/client/v4/accounts/:accountId/workers/domains", async (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
    const forbidden = requireScope("workers");
    if (forbidden) return c.json(forbidden, 403);
    const body = (await c.req.json()) as { hostname?: string; service?: string; zone_id?: string };
    const hostname = body.hostname ?? "";
    const existing = state.workerDomains.find((domain) => domain.hostname === hostname);
    if (existing) return c.json(ok(existing));
    const domain = {
      id: `domain-${state.workerDomains.length + 1}`,
      hostname,
      service: body.service ?? "",
      zone_id: body.zone_id ?? "",
    };
    state.workerDomains.push(domain);
    return c.json(ok(domain));
  });

  app.all("*", (c) => c.json(fail(7000, "No route for that URI"), 404));

  return { app, state };
}

/** Starts the fake on an ephemeral port and returns its base URL. */
export async function startFakeCloudflare(options: FakeOptions = {}) {
  const { app, state } = createFakeCloudflare(options);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake-cloudflare did not bind a TCP port");
  }
  return {
    state,
    origin: `http://127.0.0.1:${address.port}`,
    apiBase: `http://127.0.0.1:${address.port}/client/v4`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
