/**
 * THE BRIDGE, BOTH ENDS OF IT, WITH NO ELECTRON ANYWHERE.
 *
 * Split by behaviour into `consoleBridge/` — see `consoleBridge/preloadContract.test.mjs`
 * for the full rationale, the sabotage record, and how the split is organised.
 * This file stays as the entry point `test/test.mjs` imports, running every
 * slice in the same order the single file used to.
 */

import { runIpcCensusChecks } from "./consoleBridge/ipcCensus.test.mjs";
import { runPreloadContractChecks } from "./consoleBridge/preloadContract.test.mjs";
import { runSenderGuardChecks } from "./consoleBridge/senderGuard.test.mjs";
import { runProducerCensusChecks } from "./consoleBridge/producerCensus.test.mjs";

export async function runConsoleBridgeChecks(check) {
  await runIpcCensusChecks(check);
  await runPreloadContractChecks(check);
  await runSenderGuardChecks(check);
  await runProducerCensusChecks(check);
}
