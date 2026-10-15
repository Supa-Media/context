/**
 * "Still loading": what a reader is told while a workspace's first copy into
 * the Convex tree has not finished.
 *
 * Decided by the owner, 2026-10-13: "the only thing that should be reading
 * from storage directly should be actually opening and editing a note ... I
 * don't want to see even fallbacks". Every reader of which notes exist (the
 * sidebar, Home, Lists and Boards, the map, the chaos score, quick open, the
 * folder picker, device sync, the note count) answers from the tree. Where
 * the tree is not there yet, the answer is this explicit state, never a
 * bucket listing, and asking for it starts the copy if none is running.
 *
 * A store that can be listed neither in key order nor by a continuation
 * token (`unsupported`) has no tree, so it says so in its own words rather
 * than loading for ever; Dropbox, which ignores key order, is paged by its
 * token and has one (`sweep.ts`).
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps/store";
import { treeReadiness, type TreeReadiness } from "./listing";
import { servedNodesStore } from "./manifestStore";
import { startNodesSweepIfDue } from "./run";

/**
 * The store under the rows: no bucket at all. `servedNodesStore` answers
 * `list` from the rows and `privacy.md` from the mirror itself, so anything
 * that reaches this is a read a tree answer should never have made, and it
 * fails rather than open the bucket.
 */
export const NO_BUCKET: FileStore = {
  list: async () => {
    throw new Error("a tree read reads no bucket");
  },
  get: async () => {
    throw new Error("a tree read reads no bucket");
  },
} as unknown as FileStore;

/** The code a reader gets while the tree is not there to answer. Raised before any bucket credential is opened. */
export const TREE_LOADING = "TREE_LOADING";

export const TREE_LOADING_MESSAGE = "This workspace's files are still loading. They will appear here in a minute.";
export const TREE_UNSUPPORTED_MESSAGE =
  "This storage could not be listed, so its files cannot be shown here yet. Context tries again daily; notes still open by name.";

export function treeLoadingError(readiness: Exclude<TreeReadiness, "served">): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: TREE_LOADING,
    message: readiness === "unsupported" ? TREE_UNSUPPORTED_MESSAGE : TREE_LOADING_MESSAGE,
  });
}

/**
 * A tree read for a workspace with no bucket bound: there is nothing to copy
 * and nothing loading. The barrier answers it as it answers every operation
 * on such a workspace (`STORAGE_NOT_CONNECTED`, raised there and only there:
 * `storageCodePosition.test.ts`).
 */
export class TreeUnbound extends Error {
  constructor() {
    super("no bucket is bound to this workspace");
  }
}

/**
 * Where this workspace's tree is, and, when it is not there yet, a sweep
 * started if one is due (never twice: `nodeSweepDue` respects a running
 * pass's lease, and staff's Pause holds it). `unbound` when no bucket is
 * bound, and then nothing is started.
 */
export async function readinessAndKick(
  ctx: Pick<ActionCtx, "runQuery" | "scheduler">,
  workspaceId: Id<"workspaces">,
): Promise<TreeReadiness | "unbound"> {
  const { state, bound } = await ctx.runQuery(internal.functions.nodes.readiness, { workspaceId });
  const readiness = treeReadiness(state);
  if (readiness === "served") return readiness;
  if (!bound) return "unbound";
  // An unlistable store is tried again once its day has passed (`nodeSweepDue`).
  await startNodesSweepIfDue(ctx as ActionCtx, workspaceId);
  return readiness;
}

/** The refusal for a tree that does not serve: `TREE_LOADING`, or `TreeUnbound` for no bucket. */
export function notServed(readiness: TreeReadiness | "unbound"): Error {
  if (readiness === "unbound") return new TreeUnbound();
  return treeLoadingError(readiness === "unsupported" ? "unsupported" : "loading");
}

/**
 * The tree's store for a read, with no bucket under it: every listing is the
 * rows and `privacy.md` is the rules mirror, and any other read throws rather
 * than open the bucket. Throws `TREE_LOADING` (after starting the copy) while
 * the first copy has not finished.
 */
export async function servedStoreOrLoading(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<FileStore> {
  const served = await servedNodesStore(ctx, workspaceId, NO_BUCKET);
  if (served !== null) return served;
  const readiness = await readinessAndKick(ctx, workspaceId);
  // Served between the two reads: ask once more rather than say "loading" about a tree that is there.
  if (readiness === "served") {
    const again = await servedNodesStore(ctx, workspaceId, NO_BUCKET);
    if (again !== null) return again;
  }
  throw notServed(readiness === "served" ? "loading" : readiness);
}
