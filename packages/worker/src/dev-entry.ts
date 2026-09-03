/**
 * The dev instance's entry point — the ONLY build that contains the `/_dev`
 * probes. `scripts/deploy-dev.mjs` renders its wrangler config with this file
 * as `main` and `DEV_ROUTES: "1"`; the production entry (`src/index.ts`) does
 * not import the module at all, so a production bundle cannot contain it.
 */
import app from "./index.js";
import { devRoutes } from "./dev/routes.js";

app.route("/_dev", devRoutes());

export default app;
