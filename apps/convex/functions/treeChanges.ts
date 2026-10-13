/**
 * What changed in a context's tree since a device last synced: the desktop
 * and phone apps' catch-up, instead of a walk of the whole tree. Any member
 * may ask, and is told only what their clearance could see — see
 * `lib/filesFns/treeChanges.ts` for how a key that left is judged.
 *
 * `since`, `after` and `privacy` come from the previous answer, or from the
 * first page of a `syncManifest` walk with `source: "tree"`. An answer with
 * `full: true` means walk the manifest instead.
 *
 * Where the Convex tree serves the workspace its change log answers
 * (`nodesFeed.ts`, phase 6); elsewhere the D1 tree table's.
 *
 * Its own module because `files.ts` is past the size a file may grow from.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { TreeChangesResult } from "./lib/filesFns/operationTypes";
import { treeChangesValidator } from "./lib/filesFns/validators";
import { isFeedToken } from "./lib/nodes/log";

export async function syncTreeChangesHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; since: number; after?: string; privacy?: string },
): Promise<TreeChangesResult> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  // The Convex tree's change log, where the tree serves the workspace (`nodesFeed.ts`).
  const fromNodes = await ctx.runQuery(internal.functions.nodesFeed.changes, {
    actorUserId,
    workspaceId: args.workspaceId,
    since: args.since,
    ...(args.privacy === undefined ? {} : { privacy: args.privacy }),
    now: Date.now(),
  });
  if (fromNodes !== null) return fromNodes;
  // A cursor from that log means nothing to the D1 table's: walk.
  if (isFeedToken(args.privacy)) {
    return {
      kind: "treeChanges",
      full: true,
      entries: [],
      folders: [],
      gone: [],
      goneFolders: [],
      since: args.since,
      after: args.after ?? "",
      more: false,
      privacy: null,
      manifestUsable: true,
    };
  }
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "treeChanges",
      since: args.since,
      ...(args.after === undefined ? {} : { after: args.after }),
      ...(args.privacy === undefined ? {} : { privacy: args.privacy }),
    },
  });
  return result as TreeChangesResult;
}

export const syncTreeChanges = action({
  args: {
    workspaceId: v.id("workspaces"),
    since: v.number(),
    after: v.optional(v.string()),
    privacy: v.optional(v.string()),
  },
  returns: treeChangesValidator,
  handler: async (ctx, args): Promise<TreeChangesResult> => await syncTreeChangesHandler(ctx, args),
});
