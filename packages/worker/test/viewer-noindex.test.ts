/**
 * `X-Robots-Tag` and the drop's own `noindex` (docs/spec-v1.md, story 45:
 * "every response to carry `X-Robots-Tag: noindex, nofollow` WHEN `noindex` is
 * on"; issue #24, finding 17).
 *
 * On by default, and forced on when policy says so — but a drop published with
 * `noindex: false` is a drop the operator wants indexed, and a header set
 * unconditionally made that field mean nothing. The control plane is not a
 * drop and keeps the header always: `/_api`, `/_skill.md`, `/_connect` and the
 * 404 page have no `noindex` field to consult.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Drop } from "../src/domain/meta.js";
import { harness, USER_KEY } from "./app-harness.js";
import type { Harness } from "./app-harness.js";

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

const publish = async (body: Record<string, unknown>): Promise<Drop> => {
  const response = await h.json("/_api/v1/drops", "POST", body, { key: USER_KEY });
  expect(response.status, await response.clone().text()).toBe(201);
  return h.body<Drop>(response);
};

const robots = (response: Response) => response.headers.get("x-robots-tag");

describe("the viewer's X-Robots-Tag", () => {
  it("is set on a noindex drop, on the file and on the auto-index", async () => {
    const drop = await publish({
      files: [{ path: "a.txt", text: "x" }, { path: "b.txt", text: "y" }],
      noindex: true,
    });
    expect(robots(await h.call(`/${drop.slug}/`, {}, null))).toBe("noindex, nofollow");
    expect(robots(await h.call(`/${drop.slug}/a.txt`, {}, null))).toBe("noindex, nofollow");
  });

  it("is absent on a drop published with noindex: false", async () => {
    const drop = await publish({
      files: [{ path: "a.txt", text: "x" }, { path: "b.txt", text: "y" }],
      noindex: false,
    });
    expect(drop.noindex).toBe(false);
    expect(robots(await h.call(`/${drop.slug}/`, {}, null))).toBeNull();
    expect(robots(await h.call(`/${drop.slug}/a.txt`, {}, null))).toBeNull();
  });

  /**
   * `/{slug}` → `/{slug}/` is answered without reading anything: it is a
   * rewrite of the path, not an answer about a drop. It keeps the blanket
   * header, and a crawler follows it to the response that decides properly.
   * Loading `meta.json` to word a 301 would cost two R2 reads per hit.
   */
  it("keeps the header on the trailing-slash redirect, which reads no drop", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "x" }], noindex: false });
    const response = await h.call(`/${drop.slug}`, {}, null);
    expect(response.status).toBe(301);
    expect(robots(response)).toBe("noindex, nofollow");
  });

  it("comes back when an update turns noindex on again", async () => {
    const drop = await publish({ files: [{ path: "a.txt", text: "x" }], noindex: false });
    await h.json(`/_api/v1/drops/${drop.slug}`, "PATCH", { noindex: true }, { key: USER_KEY });
    expect(robots(await h.call(`/${drop.slug}/`, {}, null))).toBe("noindex, nofollow");
  });

  it("is set on every control-plane response, which has no drop to ask", async () => {
    expect(robots(await h.call("/_skill.md", {}, null))).toBe("noindex, nofollow");
    expect(robots(await h.call("/_connect", {}, null))).toBe("noindex, nofollow");
    expect(robots(await h.call("/_api/v1/health", {}, null))).toBe("noindex, nofollow");
    expect(robots(await h.call("/nothing-here/", {}, null))).toBe("noindex, nofollow");
  });

  it("stays on when the instance forces noindex, whatever the drop asked", async () => {
    h = await harness({ noindex: { default: true, forced: true } });
    const drop = await publish({ files: [{ path: "a.txt", text: "x" }], noindex: false });
    expect(drop.noindex).toBe(true);
    expect(robots(await h.call(`/${drop.slug}/`, {}, null))).toBe("noindex, nofollow");
  });
});
