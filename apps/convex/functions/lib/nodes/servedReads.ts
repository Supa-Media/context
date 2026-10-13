/**
 * File operations the Convex tree answers before the bucket is opened.
 *
 * A one-folder `list` (the console's fallback listing, a shared folder link,
 * a share card, the routines scan, an Obsidian plugin's vault listing) is the
 * same `listFolder` over the same rows and rules the sidebar's live query
 * reads (`listFolderFromNodes`), so where the tree serves the workspace it
 * answers without a bucket credential being decrypted at all. Anywhere it
 * does not (not proved, failing, staff's Pause), or for a path the bucket's
 * own listing would refuse, the answer is `null` and the barrier lists the
 * bucket exactly as before, refusal included.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { requireFolderPath } from "../fileOps/paths";
import type { OperationResult } from "../filesFns/operationTypes";

export async function servedReadAnswer(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    grantedNames?: string[];
    operation: { kind: string; path?: unknown };
  },
): Promise<OperationResult | null> {
  if (args.operation.kind !== "list" || typeof args.operation.path !== "string") return null;
  try {
    // A malformed path is the bucket listing's refusal to give, in its own words.
    requireFolderPath(args.operation.path);
  } catch {
    return null;
  }
  const listing = await ctx
    .runQuery(internal.functions.nodesListing.listServed, {
      workspaceId: args.workspaceId,
      path: args.operation.path,
      scope: args.scope,
      ...(args.grantedNames === undefined ? {} : { grantedNames: args.grantedNames }),
    })
    .catch(() => null);
  const answer = listing as { kind?: unknown } | null;
  return answer !== null && typeof answer === "object" && answer.kind === "listing" ? (answer as OperationResult) : null;
}
