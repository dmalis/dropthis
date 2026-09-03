/**
 * The viewer: what a visitor's browser gets at `/<slug>/…`.
 *
 * It reads the slug pointer and `meta.json` on EVERY request — both uncached,
 * because R2 is strongly consistent and the alternative is serving a drop that
 * was updated or expired a second ago. Only after that may a path be resolved
 * through the manifest.
 *
 * The serving matrix (docs/spec-v1.md):
 *   single-file drop   the file at `/<slug>/` and at `/<slug>/<path>`
 *   folder drop        `/<slug>/` from `index.html`, else the generated list
 *   `/<slug>/<dir>/`   `<dir>/index.html`, else 404
 *   anything missing   404
 */
import { Hono } from "hono";
import type { Env } from "./bindings.js";
import type { DevHooks } from "./dev/hooks.js";
import { dropState } from "./domain/expiry.js";
import type { DropMeta } from "./domain/meta.js";
import { isSlug } from "./domain/slug.js";
import { decodeRequestPath, encodePathForUrl } from "./domain/url-path.js";
import { loadDrop } from "./operations/get.js";
import { VIEWER_CACHE_CONTROL, serveBlob } from "./serve.js";
import { blobKey } from "./storage/keys.js";

export function viewerRoutes(hooks: DevHooks) {
  const viewer = new Hono<{ Bindings: Env }>();

  viewer.get("/:slug", (c) => {
    // A drop is a directory: `/<slug>` redirects to `/<slug>/` so that relative
    // links inside a published page resolve against the drop, not the root.
    const slug = c.req.param("slug");
    if (!isSlug(slug)) return c.notFound();
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}/${url.search}`, 301);
  });

  viewer.get("/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    if (!isSlug(slug)) return c.notFound();

    const loaded = await loadDrop(c.env.BUCKET, slug);
    if (loaded === null) return c.notFound();

    // Expiry is checked before anything is resolved: an expired drop tells the
    // visitor it is gone, and never which paths it had.
    const state = dropState(loaded.meta.expires_at, hooks.now(c.env));
    if (state !== "live") return gonePage(c.req.url);

    const url = new URL(c.req.url);
    const encoded = url.pathname.slice(`/${slug}/`.length);
    const download = url.searchParams.get("download") === "1";

    const target = resolveViewerPath(loaded.meta, encoded);
    if (target === null) return c.notFound();
    if (target.kind === "index") {
      return autoIndexPage(loaded.meta, target.prefix);
    }

    const entry = loaded.meta.manifest[target.path]!;
    return serveBlob(c.env.BUCKET, blobKey(loaded.dropId, entry.sha256), entry, {
      range: c.req.header("Range"),
      disposition: download ? "attachment" : "inline",
      filename: target.path.slice(target.path.lastIndexOf("/") + 1),
    });
  });

  return viewer;
}

type ViewerTarget = { kind: "file"; path: string } | { kind: "index"; prefix: string };

/**
 * Which manifest entry (or generated page) a request path names.
 *
 * The single-file rule is the one piece that is not a lookup: a drop of exactly
 * one file serves it at the drop root, whatever the file is called, so
 * publishing one PDF gives a URL that opens the PDF.
 */
export function resolveViewerPath(meta: DropMeta, encoded: string): ViewerTarget | null {
  const paths = Object.keys(meta.manifest);

  if (encoded === "") {
    if (paths.length === 1) return { kind: "file", path: paths[0]! };
    if (meta.manifest["index.html"] !== undefined) return { kind: "file", path: "index.html" };
    return { kind: "index", prefix: "" };
  }

  if (encoded.endsWith("/")) {
    const prefix = decodeRequestPath(encoded.slice(0, -1));
    if (prefix === null) return null;
    const index = `${prefix}/index.html`;
    if (meta.manifest[index] !== undefined) return { kind: "file", path: index };
    return null;
  }

  const path = decodeRequestPath(encoded);
  if (path === null) return null;
  if (meta.manifest[path] !== undefined) return { kind: "file", path };
  return null;
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": VIEWER_CACHE_CONTROL,
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * `auto_index: list` — the whole of it. A folder with no `index.html` is still
 * useful without a repair call, and a plain list is the only shape that needs
 * no design decision.
 */
function autoIndexPage(meta: DropMeta, prefix: string): Response {
  const title = meta.title ?? meta.slug;
  const rows = Object.keys(meta.manifest)
    .filter((path) => path.startsWith(prefix))
    .map(
      (path) =>
        `      <li><a href="${escapeHtml(encodePathForUrl(path))}">${escapeHtml(path)}</a></li>`,
    )
    .join("\n");

  return htmlResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <ul>
${rows}
    </ul>
  </body>
</html>
`,
    200,
  );
}

/** An expired drop: gone to the public, revivable by its owner inside grace. */
function gonePage(_url: string): Response {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Expired</title>
  </head>
  <body>
    <h1>Expired</h1>
    <p>This drop has expired.</p>
  </body>
</html>
`,
    410,
  );
}
