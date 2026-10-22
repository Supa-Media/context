/**
 * The file tree, from the console's side: which store a website Publish
 * walks, and re-checking what a console change touched
 * before its audiences are told.
 *
 * Every read of which notes exist (a folder, a whole-tree walk, the map, link
 * completion, the folder picker, a List, the chaos score) is answered from
 * the Convex tree before the bucket's credential is opened, and never from
 * the bucket (`lib/nodes/treeReads.ts`; decided by the owner, 2026-10-13).
 * Until phase 7 of `docs/decisions/app-and-console/convex-tree.md` this file
 * also kept a second copy of the tree in each context's fast-search database
 * (D1); that is gone, and so are the bucket fallbacks that replaced it.
 *
 * Each use runs inside the credential barrier (`runFileOperation`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { type FileStore, loadPrivacyState, type PrivacyState } from "../fileOps";
import { audiencesForChange, type TreeChange, trimTrailingSlashes } from "../treeAnnounce";
import { treeAudiences } from "../treeAudiences";
import { PRIVACY_KEY } from "../privacy";
import { scheduleNodesTouch, touchNodesNow } from "../nodes/run";
import type { OperationResult } from "./operationTypes";

/**
 * The store an operation inside the barrier walks. Every manifest and every
 * walk of which notes exist (`lib/nodes/treeReads.ts`, `docs/decisions/websites.md`)
 * is answered from the tree before the barrier opens the bucket, so no
 * manifest reaches here; what is left here is the bucket's own listing.
 */
export async function manifestSource(
  _ctx: ActionCtx,
  _args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    operation: { kind: string; source?: string; cursor?: string };
  },
  store: FileStore,
): Promise<{ store: FileStore; source: "bucket" | "nodes"; since?: number; privacy?: string | null }> {
  return { store, source: "bucket" };
}

async function markChanged(ctx: ActionCtx, workspaceId: Id<"workspaces">, audiences: string[]) {
  if (audiences.length === 0) return;
  await ctx
    .runMutation(internal.functions.treeSignals.markTreeChanged, { workspaceId, audiences })
    .catch(() => {});
}

/**
 * After a console change: re-check what it touched in the Convex tree, then
 * tell its audiences. Before the change answers where the bucket is open
 * here, since the console reads that tree (phase 2), so a tab told the tree
 * changed reads the change rather than the row before it; scheduled
 * otherwise.
 */
export async function keepTreeAndAnnounce(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
  change: { paths: string[]; files: string[]; audiences: string[]; left?: { path: string; audiences: string[] }[] },
  store?: FileStore,
): Promise<void> {
  const nodesChange = { paths: change.paths, files: change.files, left: change.left };
  if (change.paths.length + change.files.length > 0) {
    if (store !== undefined) await touchNodesNow(ctx, args.workspaceId, store, nodesChange);
    else await scheduleNodesTouch(ctx, args.workspaceId, nodesChange);
  }
  await markChanged(ctx, args.workspaceId, change.audiences);
}

/**
 * Tell the audiences that can see this change that their tree is stale.
 *
 * After the operation and never inside it, like the activity stamp: the
 * change is in the customer's bucket by now, a hint is a derivative of it,
 * and a failure to send one must never look like a failed save — so every
 * step is inside the catch, and a lost hint is caught by the client's
 * periodic walk. An operation that threw never reaches here, so a failed
 * change is never announced.
 *
 * Who is told is `audiencesForChange`, beside `treeAudiences`. The paths are
 * re-checked in the Convex tree first and the audiences told after
 * (`keepTreeAndAnnounce`); `files` are notes whose text alone changed,
 * re-checked without telling anybody.
 */
export async function announceTreeChange(
  ctx: ActionCtx,
  store: FileStore,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team" },
  change: TreeChange | null,
  result: OperationResult,
  before: PrivacyState | null,
  files: string[] = [],
): Promise<void> {
  if (change === null) {
    if (files.length > 0) await keepTreeAndAnnounce(ctx, args, { paths: [], files, audiences: [] }, store);
    return;
  }
  try {
    const paths = [...change.paths];
    const gone = new Set((change.gone ?? []).map(trimTrailingSlashes));
    // Where a note actually landed — an archive's dated folder, a duplicate's
    // new name — is only in the answer. Its source is gone from where it was.
    if (result.kind === "moved") {
      const moved = result as { from?: unknown; to?: unknown };
      if (typeof moved.from === "string") {
        paths.push(moved.from);
        gone.add(trimTrailingSlashes(moved.from));
      }
      if (typeof moved.to === "string") paths.push(moved.to);
    }
    const after = await loadPrivacyState(store);
    const audiences = audiencesForChange({ change, paths, gone, before, after });
    // Who could see each key this took away, by the manifest from before it:
    // what a device catching up is told by (`nodesFeed`). Unknown without
    // that manifest, and then only the owner is told.
    const left = before === null
      ? []
      : [...gone].map((path) => ({ path, audiences: treeAudiences([path], before.rules, before.overrides) }));
    // A change that rewrote the rules re-reads them into the tree's mirror too.
    const rules = before === null || before.etag !== after.etag ? [PRIVACY_KEY] : [];
    await keepTreeAndAnnounce(ctx, args, { paths: [...paths, ...gone], files: [...files, ...rules], audiences, left }, store);
  } catch {
    // See above: a hint is never a failed change.
  }
}
