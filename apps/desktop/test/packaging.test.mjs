/**
 * The packaging, checked as far as a machine with no Mac can check it.
 *
 * Split by behaviour into `packaging/` — see `packaging/entitlementsAndIcon.test.mjs`
 * for the full rationale and the sabotage record, and how the split is
 * organised. This file stays as the entry point `test/test.mjs` imports,
 * running every slice in the same order the single file used to.
 */

import { runEntitlementsAndIconChecks } from "./packaging/entitlementsAndIcon.test.mjs";
import { runNotarizeAndShipChecks } from "./packaging/notarizeAndShip.test.mjs";
import { runDeployWorkflowChecks } from "./packaging/deployWorkflow.test.mjs";

export async function runPackagingChecks(check) {
  await runEntitlementsAndIconChecks(check);
  await runNotarizeAndShipChecks(check);
  await runDeployWorkflowChecks(check);
}
