/**
 * The serve gate for the console's tree reads. A workspace whose `nodeTrees`
 * row is not `ready` is not served: its reads are refused as not served, never
 * answered from the bucket and never told "still loading" (`notes-by-id`).
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import type { Audience } from "./rowAccess";
import { NO_BUCKET, servedNodesStore } from "./manifestStore";

/** The code a tree read gets when the workspace's tree does not serve it. */
export const NOT_SERVED = "NOT_SERVED";

/**
 * A tree read for a workspace with no bucket bound: there is nothing to read
 * and nothing to copy. The barrier answers it as it answers every operation on
 * such a workspace (`STORAGE_NOT_CONNECTED`, raised there and only there:
 * `storageCodePosition.test.ts`).
 */
export class TreeUnbound extends Error {
  constructor() {
    super("no bucket is bound to this workspace");
  }
}

/** The refusal for a tree that does not serve this read: `TreeUnbound` for a workspace with no bucket, else `NOT_SERVED`. */
export async function notServed(ctx: Pick<ActionCtx, "runQuery">, workspaceId: Id<"workspaces">): Promise<Error> {
  if (!(await ctx.runQuery(internal.functions.nodes.bound, { workspaceId }))) return new TreeUnbound();
  return new ConvexError({ code: NOT_SERVED, message: "This workspace's files are not available from its tree yet." });
}

/** The tree's store for a read, with no bucket under it, or the refusal. Never opens the bucket. */
export async function servedStoreOrNotServed(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<FileStore> {
  const served = await servedNodesStore(ctx, workspaceId, NO_BUCKET, audience);
  if (served !== null) return served;
  throw await notServed(ctx, workspaceId);
}
