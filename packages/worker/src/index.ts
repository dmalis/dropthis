import { Hono } from "hono";
import type { Env } from "./bindings.js";
import { errorBody } from "./errors.js";
import { isReservedPath } from "./reserved.js";

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found</title>
  </head>
  <body>
    <h1>Not found</h1>
  </body>
</html>
`;

const app = new Hono<{ Bindings: Env }>();

// Every response, without exception: drops are not for search engines.
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
});

// Unauthenticated liveness. `init` polls it while a deploy propagates, and it
// is the one open route of the after-v1 unclaimed bootstrap. Nothing else is
// disclosed here.
app.get("/_api/v1/health", (c) => c.json({ ok: true }));

// A path under a reserved prefix belongs to the control plane, so its 404 is
// the machine-readable one; anything else is a viewer path and gets the page.
app.notFound((c) => {
  if (isReservedPath(new URL(c.req.url).pathname)) {
    return c.json(errorBody("NOT_FOUND", "No such route."), 404);
  }
  return c.html(NOT_FOUND_PAGE, 404);
});

export default app;
