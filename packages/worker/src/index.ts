import { Hono } from "hono";
import { mcpRoutes } from "./api/mcp.js";
import { apiRoutes } from "./api/router.js";
import type { Env } from "./bindings.js";
import { PRODUCTION_HOOKS } from "./dev/hooks.js";
import type { DevHooks } from "./dev/hooks.js";
import { errorBody } from "./errors.js";
import { loadInstanceConfig } from "./instance-config.js";
import { runCron } from "./operations/cron.js";
import { isReservedPath } from "./reserved.js";
import { renderSkill } from "./skill.js";
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

  // The Worker calling itself, in-process: no network hop, no binding to
  // render. `doctor` proves the MCP endpoint through it.
  const self = (request: Request, env: Env) => Promise.resolve(app.fetch(request, env));

  // Every REST route, generated from the operation registry. `health` is the
  // one open route in it; everything else needs a key and a scope.
  app.route("/_api/v1", apiRoutes(hooks, self));

  // The same operations as MCP tools, one stateless server per request.
  app.route("/_api/mcp", mcpRoutes(hooks, self));

  // The instance's own skill, open: it holds no secret, and one URL is how an
  // agent onboards. Rendered per request from the live policy.
  app.get("/_skill.md", async (c) => {
    const config = await loadInstanceConfig(c.env.BUCKET, c.req.url);
    return c.text(renderSkill(config), 200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-cache, must-revalidate",
    });
  });

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

/**
 * The hourly cron (AGENTS.md, "Pruning"). It is deliberately thin: everything
 * it decides lives in `operations/cron.ts`, so the contract tests can drive
 * the same function through a dev route instead of waiting an hour.
 *
 * The Worker's own URL is not knowable here — there is no request — and the
 * cron does not need one: it reads the config only for `cron_ops_budget`.
 */
export async function runScheduled(env: Env, hooks: DevHooks = PRODUCTION_HOOKS): Promise<void> {
  const config = await loadInstanceConfig(env.BUCKET, "https://cron.invalid/");
  await runCron({
    bucket: env.BUCKET,
    now: hooks.now(env),
    budget: config.policy.cron_ops_budget,
  });
}

/**
 * What Cloudflare runs: the fetch handler and the scheduled handler, from one
 * app. `createApp` is exported separately because the dev entry point adds its
 * probe routes to the Hono app before wrapping it the same way.
 */
export function createWorker(hooks: DevHooks = PRODUCTION_HOOKS) {
  return workerOf(createApp(hooks), hooks);
}

export function workerOf(app: Hono<{ Bindings: Env }>, hooks: DevHooks) {
  return {
    fetch: (request: Request, env: Env, ctx: WaitUntil) =>
      app.fetch(request, env, ctx as Parameters<typeof app.fetch>[2]),
    scheduled: async (_event: unknown, env: Env, ctx: WaitUntil) => {
      ctx.waitUntil(runScheduled(env, hooks));
    },
  };
}

/** The one thing this Worker asks of Cloudflare's execution context. */
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

export default createWorker();
