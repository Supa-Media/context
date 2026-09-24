/**
 * Static checks against the worker source: no legacy single-tenant BRAIN
 * binding, no store built outside a session, no static env token.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { gatewaySourceFiles, soleSource } from "../gatewaySource.mjs";

export async function runStoreWorkerWiringChecks(check) {
  /* ------------------------ no binding in tool logic ----------------------- */

  // The worker is every module under `src/`, not its entry file alone: code
  // split out of `index.js` must not leave these checks' sight. The session
  // store is asserted in `route` itself, read from the one module declaring it
  // (see ../gatewaySource.mjs).
  const files = gatewaySourceFiles();
  const workerSource = files.map((file) => file.text).join("\n");
  const router = soleSource(files, /^(?:export )?async function route\(request, env, ctx\)/m, "index.js");
  const routeStart = router.text.indexOf("async function route(request, env, ctx)");
  const routeBody =
    routeStart === -1 ? "" : router.text.slice(routeStart, router.text.indexOf("\n}\n", routeStart));
  const legacyBindingUses = workerSource.match(/env\.BRAIN/g) || [];
  check(
    "the legacy single-tenant BRAIN binding is gone from the worker entirely",
    legacyBindingUses.length === 0
  );
  check(
    "the worker builds no store of its own; every caller-facing store comes from a session",
    !/new R2Store\(env\.[A-Z_]*BRAIN/.test(workerSource) &&
      /storeForSession\(session, env, controlPlane\)/.test(routeBody)
  );
  check(
    "no static env token survives anywhere in the worker's logic",
    !/env\.(PRIVATE|TEAM|PUBLIC|INBOX)_TOKEN/.test(workerSource)
  );
}
