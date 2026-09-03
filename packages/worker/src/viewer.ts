/**
 * The viewer: what a visitor's browser gets at `/<slug>/…`.
 *
 * It reads the slug pointer and `meta.json` on EVERY request — both uncached,
 * because R2 is strongly consistent and the alternative is serving a drop that
 * was updated or expired a second ago. Only after that may a path be resolved
 * through the manifest.
 *
 * A protected drop adds one gate between the expiry check and the manifest:
 * the unlock cookie, verified against the CURRENT nonce in `meta.json`, so a
 * password change locks every open browser out on its very next request. The
 * agent's own `get` never passes through here and never needs the password.
 *
 * The serving matrix (docs/spec-v1.md):
 *   single-file drop   the file at `/<slug>/` and at `/<slug>/<path>`
 *   folder drop        `/<slug>/` from `index.html`, else the generated list
 *   `/<slug>/<dir>/`   `<dir>/index.html`, else 404
 *   anything missing   404
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./bindings.js";
import type { DevHooks } from "./dev/hooks.js";
import { dropState } from "./domain/expiry.js";
import type { DropMeta } from "./domain/meta.js";
import { storedPassword, verifyPassword } from "./domain/password.js";
import type { PasswordRecord } from "./domain/password.js";
import { isSlug } from "./domain/slug.js";
import { decodeRequestPath, encodePathForUrl } from "./domain/url-path.js";
import { loadDrop } from "./operations/get.js";
import type { LoadedDrop } from "./operations/get.js";
import { VIEWER_CACHE_CONTROL, serveBlob } from "./serve.js";
import { blobKey } from "./storage/keys.js";
import { unlockPage } from "./viewer/unlock-page.js";
import {
  UNLOCK_COOKIE,
  cookieExpiry,
  readCookie,
  setCookieHeader,
  signUnlock,
  verifyUnlock,
} from "./viewer/unlock-cookie.js";

/** A typed password is short; anything larger than this is not one. */
const MAX_UNLOCK_BODY_BYTES = 4096;

export function viewerRoutes(hooks: DevHooks) {
  const viewer = new Hono<{ Bindings: Env }>();

  viewer.get("/:slug", (c, next) => {
    // A drop is a directory: `/<slug>` redirects to `/<slug>/` so that relative
    // links inside a published page resolve against the drop, not the root.
    const slug = c.req.param("slug");
    if (!isSlug(slug)) return next();
    const url = new URL(c.req.url);
    return c.redirect(`${url.pathname}/${url.search}`, 301);
  });

  /**
   * The unlock form's POST target is the very path the visitor asked for, so
   * unlocking lands them where they were going rather than at the drop root.
   */
  viewer.post("/:slug/*", async (c, next) => {
    const gate = await openGate(c, hooks);
    if (gate.kind === "not_a_drop") return next();
    if (gate.kind === "response") return gate.response;
    // Nothing to unlock: a 404 rather than a 405, so an open drop never
    // advertises an endpoint it does not have.
    if (gate.kind !== "locked") return c.notFound();

    const password = await readPassword(c.req.raw);
    if (password === null || !(await verifyPassword(gate.password, password))) {
      return lockedPage(gate.loaded.meta, true);
    }

    const secret = c.env.HMAC_SECRET;
    if (typeof secret !== "string" || secret.length === 0) return noSecretPage();

    const url = new URL(c.req.url);
    const expiresAt = cookieExpiry(hooks.now(c.env, c.req.raw), gate.loaded.meta.expires_at);
    const token = await signUnlock(secret, {
      slug: gate.loaded.meta.slug,
      nonce: gate.password.nonce,
      expiresAt,
    });

    return new Response(null, {
      status: 303,
      headers: {
        Location: `${url.pathname}${url.search}`,
        "Set-Cookie": setCookieHeader(gate.loaded.meta.slug, token, expiresAt),
        "Cache-Control": VIEWER_CACHE_CONTROL,
      },
    });
  });

  viewer.get("/:slug/*", async (c, next) => {
    const gate = await openGate(c, hooks);
    if (gate.kind === "not_a_drop") return next();
    if (gate.kind === "response") return gate.response;
    if (gate.kind === "not_found") return c.notFound();
    if (gate.kind === "locked") return lockedPage(gate.loaded.meta, false);
    const loaded = gate.loaded;
    const slug = loaded.meta.slug;

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

/**
 * Everything every viewer request has to do before it may look at a path:
 * find the drop, refuse it if it has expired, and — when it is protected —
 * check the unlock cookie against the nonce `meta.json` holds right now.
 *
 * `open` means serve it; `locked` means the password gate is in the way and
 * the caller decides what to do about it; `response` is an answer already
 * decided; `not_found` is left to the route, because the 404 page belongs to
 * the app's own handler.
 *
 * `not_a_drop` is the one that is NOT an answer: the first segment cannot be a
 * slug, so this request was never the viewer's. The route hands it on with
 * `next()` instead of answering, because a route mounted after the viewer —
 * the dev probes at `/_dev` — would otherwise be shadowed by `/:slug/*`, and
 * a 404 from here would be the viewer swallowing another route's request.
 */
type Gate =
  | { kind: "open"; loaded: LoadedDrop }
  | { kind: "locked"; loaded: LoadedDrop; password: PasswordRecord }
  | { kind: "response"; response: Response }
  | { kind: "not_a_drop" }
  | { kind: "not_found" };

async function openGate(c: Context<{ Bindings: Env }>, hooks: DevHooks): Promise<Gate> {
  const slug = c.req.param("slug") ?? "";
  if (!isSlug(slug)) return { kind: "not_a_drop" };

  const loaded = await loadDrop(c.env.BUCKET, slug);
  if (loaded === null) return { kind: "not_found" };

  // Expiry is checked before anything is resolved: an expired drop tells the
  // visitor it is gone, and never which paths it had.
  const state = dropState(loaded.meta.expires_at, hooks.now(c.env, c.req.raw));
  if (state !== "live") return { kind: "response", response: gonePage(c.req.url) };

  const password = storedPassword(loaded.meta.access);
  if (password === undefined) return { kind: "open", loaded };

  const secret = c.env.HMAC_SECRET;
  if (typeof secret !== "string" || secret.length === 0) {
    return { kind: "response", response: noSecretPage() };
  }

  const token = readCookie(c.req.header("Cookie"), UNLOCK_COOKIE);
  if (token !== null) {
    const ok = await verifyUnlock(secret, token, {
      slug: loaded.meta.slug,
      nonce: password.nonce,
      now: hooks.now(c.env, c.req.raw),
    });
    if (ok) return { kind: "open", loaded };
  }

  return { kind: "locked", loaded, password };
}

/**
 * The typed password, from an `application/x-www-form-urlencoded` body. The
 * read is capped because this route is reachable without any credential.
 */
async function readPassword(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return null;

  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_UNLOCK_BODY_BYTES) return null;

  const text = await request.text();
  if (text.length > MAX_UNLOCK_BODY_BYTES) return null;

  const password = new URLSearchParams(text).get("password");
  return password === null || password.length === 0 ? null : password;
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

/**
 * The unlock form. It is a 401: the request was refused for want of a
 * credential, and answering 200 would tell a crawler the page is the content.
 * `Vary: Cookie` keeps any intermediary from handing this page to a visitor
 * who has already unlocked.
 */
function lockedPage(meta: DropMeta, failed: boolean): Response {
  const response = htmlResponse(
    unlockPage({ title: meta.title ?? meta.slug, failed }),
    401,
  );
  response.headers.set("Vary", "Cookie");
  return response;
}

/**
 * A protected drop on an instance with no `HMAC_SECRET` cannot be unlocked by
 * anyone, so it is refused rather than opened.
 */
function noSecretPage(): Response {
  return htmlResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Unavailable</title>
  </head>
  <body>
    <h1>Unavailable</h1>
    <p>This instance cannot verify passwords. Its operator should redeploy it.</p>
  </body>
</html>
`,
    500,
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
