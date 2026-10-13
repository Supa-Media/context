/**
 * The gateway's reads of the Convex tree (`lib/nodes/gatewayManifest.ts`).
 * Kept apart from `nodes.ts`, which owns the rows and their writes.
 */

import { internalQuery } from "../_generated/server";
import { readClearanceArgs, readClearanceHandler, readClearanceReturns } from "./lib/nodes/gatewayManifest";

/** The workspace and tier a gateway-borne token reads at, or null. INTERNAL. */
export const readClearance = internalQuery({
  args: readClearanceArgs,
  returns: readClearanceReturns,
  handler: readClearanceHandler,
});
