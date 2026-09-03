/**
 * The dev instance's entry point — the ONLY build that contains the `/_dev`
 * probes. `scripts/deploy-dev.mjs` renders its wrangler config with this file
 * as `main` and `DEV_ROUTES: "1"`; the production entry (`src/index.ts`) does
 * not import the module at all, so a production bundle cannot contain it.
 */
import { createApp } from "./index.js";
import { DEV_HOOKS } from "./dev/enabled-hooks.js";
import { devRoutes } from "./dev/routes.js";

const app = createApp(DEV_HOOKS);
app.route("/_dev", devRoutes());

export default app;
