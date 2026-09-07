/**
 * One canonical origin, in the viewer (issue #26, decision #103).
 *
 * An instance may answer on several hostnames — the `*.workers.dev` URL is
 * always there, a custom domain arrives later — but only one of them is the
 * instance's name on the web. A readable GET on an alias is therefore moved to
 * the canonical origin BEFORE the drop is read, so a drop is never served
 * twice on two origins.
 *
 * The origins come from `system/config.json` through a memo (`createOriginsMemo`)
 * rather than an R2 GET per request: they are instance identity, only `init`
 * writes them, and `init` always redeploys.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createOriginsMemo } from "../src/canonical.js";
import { DEV_HOOKS } from "../src/dev/enabled-hooks.js";
import type { Drop } from "../src/domain/meta.js";
import { createApp } from "../src/index.js";
import { INITIAL_POLICY } from "../src/policy/defaults.js";
import { CONFIG_KEY } from "../src/storage/keys.js";
import { harness, ORIGIN, USER_KEY } from "./app-harness.js";
import type { Harness } from "./app-harness.js";
import { memoryBucket } from "./memory-bucket.js";

const CANONICAL = "https://canonical.example";
/** The origin the harness publishes on; it becomes the alias below. */
const ALIAS = ORIGIN;
/** A Route the operator added that config never heard of. */
const UNKNOWN = "https://stray.example";

let h: Harness;
let slug: string;

beforeEach(async () => {
  h = await harness();
  const response = await h.json(
    "/_api/v1/drops",
    "POST",
    { files: [{ path: "a.txt", text: "x" }, { path: "b.txt", text: "y" }] },
    { key: USER_KEY },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  slug = (await h.body<Drop>(response)).slug;
  // Only now is this origin an alias: the drop was published under it as the
  // canonical one, exactly as `contract-tests/connect.test.ts` swaps the config.
  h.bucket.seed(
    CONFIG_KEY,
    JSON.stringify({ ...INITIAL_POLICY, canonical_url: CANONICAL, alias_origins: [ALIAS] }),
  );
  h.bucket.log.length = 0;
});

/** A fresh app per call, the way `app-harness` does, but on any origin. */
const on = (origin: string, path: string, init: RequestInit = {}) =>
  createApp(DEV_HOOKS).fetch(new Request(`${origin}${path}`, init), h.env);

describe("a viewer request on an alias origin", () => {
  it("is moved to the canonical origin, permanently", async () => {
    const response = await on(ALIAS, `/${slug}/`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${CANONICAL}/${slug}/`);
  });

  it("keeps the path and the query", async () => {
    const response = await on(ALIAS, `/${slug}/b.txt?download=1`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${CANONICAL}/${slug}/b.txt?download=1`);
  });

  it("moves the trailing-slash form in ONE hop, not two", async () => {
    const response = await on(ALIAS, `/${slug}`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${CANONICAL}/${slug}/`);
  });

  it("carries the same headers every viewer response carries", async () => {
    const response = await on(ALIAS, `/${slug}/`);
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("reads no drop: the move happens before the slug pointer is touched", async () => {
    await on(ALIAS, `/${slug}/`);
    expect(h.bucket.log.filter((entry) => entry.startsWith("get slugs/"))).toEqual([]);
    expect(h.bucket.log.filter((entry) => entry.startsWith("get drops/"))).toEqual([]);
  });

  it("does not move a POST: a replayed unlock must not land on another origin", async () => {
    const response = await on(ALIAS, `/${slug}/`, { method: "POST", body: "password=x" });
    expect(response.status).not.toBe(301);
  });
});

describe("a viewer request that is already canonical", () => {
  it("is served", async () => {
    const response = await on(CANONICAL, `/${slug}/b.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("y");
  });
});

describe("a viewer request on a hostname config never heard of", () => {
  /**
   * A Route the operator added for a hostname that is in neither
   * `canonical_url` nor `alias_origins`. It is served, never redirected:
   * config drift must not lock a visitor out of a drop.
   */
  it("is served, not redirected", async () => {
    const response = await on(UNKNOWN, `/${slug}/b.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("y");
  });
});

describe("the control plane on an alias origin", () => {
  it("is answered where it was addressed: an API client was given that origin", async () => {
    expect((await on(ALIAS, "/_api/v1/health")).status).toBe(200);
    expect((await on(ALIAS, "/_skill.md")).status).toBe(200);
  });

  /**
   * The OAuth endpoints already moved before this slice did (`oauth/routes.ts`
   * has called `aliasRedirect` since #12): the issuer, the resource and the
   * discovery documents all name the canonical origin, so a browser client
   * that started on an alias would be arguing with them. Pinned here so the
   * viewer's rule and this one are read side by side.
   */
  it("still moves the OAuth documents, which must agree with the issuer", async () => {
    const response = await on(ALIAS, "/.well-known/oauth-authorization-server");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      `${CANONICAL}/.well-known/oauth-authorization-server`,
    );
  });

  it("still moves /_connect, which is a page a person reads", async () => {
    const response = await on(ALIAS, "/_connect");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(`${CANONICAL}/_connect`);
  });
});

describe("createOriginsMemo", () => {
  const seeded = () => {
    const bucket = memoryBucket();
    bucket.seed(
      CONFIG_KEY,
      JSON.stringify({ canonical_url: CANONICAL, alias_origins: [ALIAS], instance_name: "acme" }),
    );
    return bucket;
  };
  const reads = (bucket: ReturnType<typeof seeded>) =>
    bucket.log.filter((entry) => entry === `get ${CONFIG_KEY}`).length;

  it("reads the config once and answers from the memo inside the TTL", async () => {
    const bucket = seeded();
    let clock = 1_000;
    const origins = createOriginsMemo(() => clock);

    const first = await origins(bucket, `${ALIAS}/x/`, 60_000);
    expect(first).toEqual({
      canonicalUrl: CANONICAL,
      aliasOrigins: [ALIAS],
      instanceName: "acme",
    });
    clock += 59_999;
    expect(await origins(bucket, `${ALIAS}/x/`, 60_000)).toEqual(first);
    expect(reads(bucket)).toBe(1);
  });

  it("reads again once the TTL has passed", async () => {
    const bucket = seeded();
    let clock = 1_000;
    const origins = createOriginsMemo(() => clock);
    await origins(bucket, `${ALIAS}/x/`, 60_000);
    clock += 60_000;
    await origins(bucket, `${ALIAS}/x/`, 60_000);
    expect(reads(bucket)).toBe(2);
  });

  it("reads every time at TTL 0, which is what the dev build asks for", async () => {
    const bucket = seeded();
    const origins = createOriginsMemo(() => 1_000);
    await origins(bucket, `${ALIAS}/x/`, 0);
    await origins(bucket, `${ALIAS}/x/`, 0);
    expect(reads(bucket)).toBe(2);
  });

  it("falls back to the request's own origin when there is no config at all", async () => {
    const bucket = memoryBucket();
    const origins = createOriginsMemo(() => 1_000);
    expect(await origins(bucket, `${UNKNOWN}/x/`, 60_000)).toEqual({
      canonicalUrl: UNKNOWN,
      aliasOrigins: [],
      instanceName: "main",
    });
  });
});
