import { describe, expect, it } from "vitest";
import { BASE_URL } from "./base-url.js";
import { api, apiJson, errorOf } from "./client.js";
import type { Json } from "./client.js";

/**
 * The caller-chosen slug (issue #18, decision #94), replayed against the
 * deployed dev Worker.
 *
 * The claim on `slugs/<slug>` is a conditional write against real R2, and this
 * file is where that is proven: a second call for the same slug must fail
 * WITHOUT touching the drop that holds it — not "probably", and not according
 * to Miniflare, which has shipped reversed conditional-write logic.
 *
 * Each test names its own slug so the file can be re-run against a bucket that
 * still holds the last run's drops.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const slugFor = (what: string) => `ct-${what}-${RUN}`;

const publish = (body: unknown) =>
  apiJson("/_api/v1/drops", "POST", body);

async function publishOk(body: unknown): Promise<Json> {
  const response = await publish(body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Json;
}

const page = (text: string) => [{ path: "index.html", text }];

const r2Get = async (key: string): Promise<{ found: boolean; body?: string }> =>
  (await apiJson("/_dev/r2/get", "POST", { key })).json() as Promise<{
    found: boolean;
    body?: string;
  }>;

describe("publish with a chosen slug", () => {
  it("puts the drop at the chosen path and serves it there", async () => {
    const slug = slugFor("happy");
    const drop = await publishOk({ files: page("<h1>campaign</h1>"), title: "Campaign", slug });

    expect(drop.slug).toBe(slug);
    expect(drop.url).toBe(`${BASE_URL}/${slug}/`);

    const served = await fetch(drop.url as string, { cache: "no-store" });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("<h1>campaign</h1>");

    // `get` and `delete` accept it as a target: one predicate, not two (#94a).
    const read = await api(`/_api/v1/drops/${slug}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Json).slug).toBe(slug);
  });

  it("normalizes the chosen slug before it is claimed", async () => {
    const slug = slugFor("norm");
    const drop = await publishOk({ files: page("x"), slug: `  ${slug.toUpperCase()} ` });
    expect(drop.slug).toBe(slug);
  });

  it("appears in list with its own slug and URL", async () => {
    const slug = slugFor("listed");
    await publishOk({ files: page("x"), title: `Listed ${RUN}`, slug });

    const response = await api(`/_api/v1/drops?limit=100&q=${encodeURIComponent(`Listed ${RUN}`)}`);
    expect(response.status).toBe(200);
    const drops = ((await response.json()) as { drops: Json[] }).drops;
    const found = drops.find((entry) => entry.slug === slug);
    expect(found, `list did not carry ${slug}`).toBeDefined();
    expect(found!.url).toBe(`${BASE_URL}/${slug}/`);
  });

  it("refuses a second drop on the same slug and leaves the first one whole", async () => {
    const slug = slugFor("taken");
    const first = await publishOk({ files: page("<h1>first</h1>"), title: "First", slug });

    const second = await publish({ files: page("<h1>second</h1>"), title: "Second", slug });
    const error = await errorOf(second);
    expect(error.status).toBe(409);
    expect(error.code).toBe("SLUG_TAKEN");
    expect((error.body.error as Json).retryable).toBe(false);
    expect((error.body.error as Json).remediation).toContain("update");

    // The pointer still names the FIRST drop, and the first drop still serves
    // its own bytes: nothing of the losing call reached it.
    const pointer = await r2Get(`slugs/${slug}`);
    expect(pointer.found).toBe(true);
    const read = await api(`/_api/v1/drops/${slug}`);
    expect(((await read.json()) as Json).title).toBe("First");
    expect(await (await fetch(first.url as string, { cache: "no-store" })).text()).toBe(
      "<h1>first</h1>",
    );
  });

  it("frees the slug when the drop is deleted", async () => {
    const slug = slugFor("reuse");
    await publishOk({ files: page("<h1>old</h1>"), slug });

    const deleted = await api(`/_api/v1/drops/${slug}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await r2Get(`slugs/${slug}`)).found).toBe(false);

    const again = await publishOk({ files: page("<h1>new</h1>"), slug });
    expect(again.slug).toBe(slug);
    expect(await (await fetch(again.url as string, { cache: "no-store" })).text()).toBe(
      "<h1>new</h1>",
    );
  });

  it.each(["_api", "_oauth", "_connect", ".well-known", "ab", "-lead", "no_underscores", "UPPER CASE"])(
    "refuses %s as INVALID_INPUT",
    async (slug) => {
      const error = await errorOf(await publish({ files: page("x"), slug }));
      expect(error.status).toBe(400);
      expect(error.code).toBe("INVALID_INPUT");
    },
  );

  it("cannot shadow the control plane even when the slug is chosen", async () => {
    // The refusal above is the first line; this is the second: whatever a slug
    // spells, `/_api/...` is answered by the API and never by the viewer.
    const response = await api("/_api/v1/health", {}, "");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("a chosen slug under an idempotency key", () => {
  it("converges: the same key and payload returns the same drop", async () => {
    const slug = slugFor("idem");
    const body = {
      files: page("<h1>once</h1>"),
      title: "Once",
      slug,
      idempotency_key: `vanity-${RUN}`,
    };

    const first = await publishOk(body);
    const second = await publish(body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as Json).slug).toBe(first.slug);
  });

  it("is IDEMPOTENCY_MISMATCH when the same key asks for a different slug", async () => {
    const key = `vanity-mismatch-${RUN}`;
    await publishOk({ files: page("x"), slug: slugFor("idem-a"), idempotency_key: key });

    const error = await errorOf(
      await publish({ files: page("x"), slug: slugFor("idem-b"), idempotency_key: key }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_MISMATCH");
  });
});
