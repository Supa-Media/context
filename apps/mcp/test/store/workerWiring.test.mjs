/**
 * Static checks against the worker source: no legacy single-tenant BRAIN
 * binding, no store built outside a session, no static env token.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 */

import { readFileSync } from "./fixtures.mjs";

export async function runStoreWorkerWiringChecks(check) {
  /* ------------------------ no binding in tool logic ----------------------- */

  const workerSource = readFileSync(new URL("../../src/index.js", import.meta.url), "utf8");
  const legacyBindingUses = workerSource.match(/env\.BRAIN/g) || [];
  check(
    "the legacy single-tenant BRAIN binding is gone from the worker entirely",
    legacyBindingUses.length === 0
  );
  check(
    "the worker builds no store of its own; every caller-facing store comes from a session",
    !/new R2Store\(env\.[A-Z_]*BRAIN/.test(workerSource) &&
      /storeForSession\(session, env, controlPlane\)/.test(workerSource)
  );
  check(
    "no static env token survives anywhere in the worker's logic",
    !/env\.(PRIVATE|TEAM|PUBLIC|INBOX)_TOKEN/.test(workerSource)
  );
}
