import { serve } from "@hono/node-server";
import { Hono } from "hono";

/**
 * A stand-in for the slice of the Cloudflare v4 API that `scripts/deploy-dev.mjs`
 * uses: token verify, workers.dev subdomain, R2 bucket list/create and KV
 * namespace list/create. It answers with Cloudflare's JSON envelope and its
 * pagination rules (R2: `per_page` + `start_after`; KV: `page` + `per_page`),
 * and it records every request so a test can assert that no create happened.
 */
export type FakeState = {
  token: string;
  accountId: string;
  subdomain: string;
  buckets: string[];
  namespaces: Array<{ id: string; title: string }>;
  perPage: number;
  calls: Array<{ method: string; path: string; query: Record<string, string> }>;
};

export type FakeOptions = {
  token?: string;
  accountId?: string;
  subdomain?: string;
  buckets?: string[];
  namespaces?: Array<{ id: string; title: string }>;
  /** Page size the fake enforces regardless of what the client asks for. */
  perPage?: number;
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
    perPage: options.perPage ?? 20,
    calls: [],
  };

  const app = new Hono();

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
    return c.json(ok({ subdomain: state.subdomain }));
  });

  // R2 buckets are ordered lexicographically and paged with `start_after`.
  app.get("/client/v4/accounts/:accountId/r2/buckets", (c) => {
    if (c.req.param("accountId") !== state.accountId) {
      return c.json(fail(7003, "Could not route to account"), 404);
    }
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
