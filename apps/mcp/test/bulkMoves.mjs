/**
 * The gateway's two bulk-move suites, as their own entry point.
 *
 * Each moves thousands of objects through the real S3Store against the
 * in-memory S3 backend, so together they were most of `pnpm test`'s wall time
 * (about 72 of 106 seconds locally, 2026-10-07). Neither shares state with the
 * flat sequence in test.mjs: each builds its own control plane and S3 backend
 * and swaps `globalThis.fetch` for its own duration, which is why they can run
 * in a separate process alongside it (test/run.mjs) instead of after it.
 */
import { check, suite, getFailures } from "./harness.mjs";
import { runMoveWithoutConditionalDeleteChecks } from "./moveWithoutConditionalDelete.test.mjs";
import { runBulkFolderMoveVisibilityChecks } from "./bulkFolderMoveVisibility.test.mjs";

// `node test/bulkMoves.mjs` runs both; test/run.mjs runs `move` and `folder`
// as two processes so neither waits for the other. Any other argument is
// refused rather than read as "neither".
const SUITES = {
  move: () => suite("runMoveWithoutConditionalDeleteChecks", () => runMoveWithoutConditionalDeleteChecks(check)),
  folder: () => suite("runBulkFolderMoveVisibilityChecks", () => runBulkFolderMoveVisibilityChecks(check)),
};
const only = process.argv[2];
if (only !== undefined && !(only in SUITES)) throw new Error(`unknown bulk suite "${only}"; expected move or folder`);
for (const [name, run] of Object.entries(SUITES)) {
  if (only === undefined || only === name) await run();
}

console.log(getFailures() ? `\n${getFailures()} FAILURES` : "\nALL PASS");
