import { Hono } from "hono";
import { mcpRoutes } from "./api/mcp.js";
import { apiRoutes } from "./api/router.js";
import type { Env } from "./bindings.js";
import { PRODUCTION_HOOKS } from "./dev/hooks.js";
import type { DevHooks } from "./dev/hooks.js";
import { errorBody } from "./errors.js";
import { isReservedPath } from "./reserved.js";
import { viewerRoutes } from "./viewer.js";

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

/**
 * The whole Worker.
 *
 * `hooks` is the only way the dev build differs from production: it bends the
 * clock and can abort a publish mid-write. Production calls this with nothing,
 * so no dev variable is ever named in the code a production bundle contains.
 */
export function createApp(hooks: DevHooks = PRODUCTION_HOOKS) {
  const app = new Hono<{ Bindings: Env }>();

  // Every response, without exception: drops are not for search engines.
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
  });

  // Every REST route, generated from the operation registry. `health` is the
  // one open route in it; everything else needs a key and a scope.
  app.route("/_api/v1", apiRoutes(hooks));

  // The same operations as MCP tools, one stateless server per request.
  app.route("/_api/mcp", mcpRoutes(hooks));

  // The viewer is last: it owns every path that is not the control plane, and
  // `RESERVED_PREFIXES` plus the `_`-free slug alphabet keep the two apart.
  app.route("/", viewerRoutes(hooks));

  // A path under a reserved prefix belongs to the control plane, so its 404 is
  // the machine-readable one; anything else is a viewer path and gets the page.
  app.notFound((c) => {
    if (isReservedPath(new URL(c.req.url).pathname)) {
      return c.json(errorBody("NOT_FOUND", "No such route."), 404);
    }
    return c.html(NOT_FOUND_PAGE, 404);
  });

  return app;
}

export default createApp();
