/**
 * The offline mirror: what may be copied, when it may be served, and who it is.
 *
 * Split by behaviour into `mirror/` — see `mirror/shouldMirror.test.mjs` for
 * the full rationale and the sabotage record, and how the split is
 * organised. This file stays as the entry point `test/test.mjs` imports,
 * running every slice in the same order the single file used to.
 */

import { runShouldMirrorChecks } from "./mirror/shouldMirror.test.mjs";
import { runFallbackAndStoreChecks } from "./mirror/fallbackAndStore.test.mjs";

export async function runMirrorChecks(check) {
  await runShouldMirrorChecks(check);
  await runFallbackAndStoreChecks(check);
}
