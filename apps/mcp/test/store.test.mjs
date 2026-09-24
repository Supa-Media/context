/**
 * Storage adapter checks: SigV4 signing, ListObjectsV2 parsing, rootPrefix
 * isolation, and the conditional-write capability probe.
 *
 * Offline and dependency-free — every backend is a fetch stub or an in-memory
 * map. Run as part of `node test/test.mjs`.
 *
 * This file used to hold all of these checks directly, in one 2,115-line
 * function. It is now a thin facade over `test/store/*.test.mjs`, split by
 * responsibility, so `import { runStoreChecks } from "./store.test.mjs"`
 * keeps working unchanged and every check still runs in its original order.
 */

import { runStoreSigningChecks } from "./store/signing.test.mjs";
import { runStoreRootPrefixAndTraversalChecks } from "./store/rootPrefixAndTraversal.test.mjs";
import { runStoreAddressingAndProbeChecks } from "./store/addressingAndProbe.test.mjs";
import { runStoreGuardChecks } from "./store/guards.test.mjs";
import { runStoreDropboxChecks } from "./store/dropbox.test.mjs";
import { runStoreDropboxFolderChecks } from "./store/dropboxFolders.test.mjs";
import { runStoreWorkerWiringChecks } from "./store/workerWiring.test.mjs";

/**
 * @param {(label: string, ok: boolean) => void} check
 * @param {{ env: object, ownerToken: string }} gateway a live control-plane-backed
 *   environment from the main suite, so the worker checks below authenticate the
 *   same way every other request does — there is no other way in.
 */
export async function runStoreChecks(check, gateway) {
  await runStoreSigningChecks(check);
  await runStoreRootPrefixAndTraversalChecks(check);
  await runStoreAddressingAndProbeChecks(check);
  await runStoreGuardChecks(check, gateway);
  await runStoreDropboxChecks(check);
  await runStoreDropboxFolderChecks(check);
  await runStoreWorkerWiringChecks(check);
}
