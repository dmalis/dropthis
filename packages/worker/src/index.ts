import { Hono } from "hono";
import { apiRoutes } from "./api/router.js";
import type { Env } from "./bindings.js";
import { PRODUCTION_HOOKS } from "./dev/hooks.js";
import type { DevHooks } from "./dev/hooks.js";
import { ApiError, errorBody } from "./errors.js";
import { oauthRoutes } from "./oauth/routes.js";
import type { McpHandler } from "./oauth/provider.js";
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
 * The MCP surface until issue #8 lands: the auth seam in front of it is
 * complete, the surface behind it is not.
 */
const MCP_NOT_MOUNTED: McpHandler = async () => {
  throw new ApiError("INTERNAL", "The MCP surface is not mounted in this build (issue #8).");
};

/**
 * The whole Worker.
 *
 * `hooks` is the only way the dev build differs from production: it bends the
 * clock and can abort a publish mid-write. Production calls this with nothing,
 * so no dev variable is ever named in the code a production bundle contains.
 * `mcp` is the MCP surface, reached only with a resolved caller.
 */
export function createApp(hooks: DevHooks = PRODUCTION_HOOKS, mcp: McpHandler = MCP_NOT_MOUNTED) {
  const app = new Hono<{ Bindings: Env }>();

  // Every response, without exception: drops are not for search engines.
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Robots-Tag", "noindex, nofollow");
  });

  // Every REST route, generated from the operation registry. `health` is the
  // one open route in it; everything else needs a key and a scope.
  app.route("/_api/v1", apiRoutes(hooks));

  // `/_api/mcp` (bearer first, OAuth otherwise), the `/_oauth/*` endpoints
  // and the discovery documents. One file owns that wiring.
  app.route("/", oauthRoutes(hooks, mcp));

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
