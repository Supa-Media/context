/**
 * Whether a folder too big to list holds something this caller cannot see (`builtMove.ts`): the settings
 * beneath it that hide what they cover (`hiddenBeneath`), counted only where a live row still stands.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { hiddenBeneath } from "../fileOps/moveRules";
import type { PrivacyState } from "../fileOps/privacyState";

/** Settings one check asks about; a folder with more hidden ones than this is judged to hide something. */
export const HIDDEN_ASKED = 200;

export async function hidesBeneath(
  ctx: Pick<ActionCtx, "runQuery">,
  workspaceId: Id<"workspaces">,
  from: string,
  clearance: Clearance,
  state: PrivacyState,
): Promise<boolean> {
  const paths = hiddenBeneath(from, clearance, state.rules, state.overrides);
  if (paths.length === 0) return false;
  if (paths.length > HIDDEN_ASKED) return true;
  return await ctx.runQuery(internal.functions.nodeRowMoves.liveAmong, { workspaceId, paths });
}
