/**
 * The file tree, from the console's side: which store a walk or a map reads,
 * a folder's List and the chaos score from the Convex tree's facts, and
 * re-checking what a console change touched before its audiences are told.
 *
 * Until phase 7 of `docs/decisions/app-and-console/convex-tree.md` this file
 * also kept a second copy of the tree in each context's fast-search database
 * (D1), with its links, front matter and chaos history, and fell back to it
 * while the Convex facts were not whole. That copy is gone: where the Convex
 * tree or its facts cannot answer, a reader gets what a context with no
 * search database always got — the bucket, the search index for the map,
 * `available: false` for a List (the app reads the folder from the bucket),
 * and `NO_CHAOS` for the score. The database itself stays, for fast search
 * (`lib/fastSearchFns/client.ts`).
 *
 * Each use runs inside the credential barrier (`runFileOperation`), because
 * each needs the bucket.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { folderNotesFromNodes, type FolderNotesResult } from "./folderNotes";
import { liveChaosScoreOf, NO_CHAOS } from "./chaosOps";
import { factChaosSource, factPropSource, factsReady } from "../nodes/factSources";
import { clearanceOf } from "../clearance";
import { type FileStore, loadPrivacyState, type PrivacyState } from "../fileOps";
import { audiencesForChange, type TreeChange, trimTrailingSlashes } from "../treeAnnounce";
import { treeAudiences } from "../treeAudiences";
import { PRIVACY_KEY } from "../privacy";
import { isServedStore, servedNodesStore } from "../nodes/manifestStore";
import { attachLinkTable, convexLinkTable } from "../nodes/linkTable";
import { scheduleFactFill } from "../nodes/factFill";
import { scheduleNodesTouch, startNodesSweepIfDue, touchNodesNow } from "../nodes/run";
import type { FileOperation, OperationResult } from "./operationTypes";

export type TreeOperation = Extract<FileOperation, { kind: "folderNotes" | "chaosScore" }>;

export function isTreeOperation(operation: { kind: string }): operation is TreeOperation {
  return operation.kind === "folderNotes" || operation.kind === "chaosScore";
}

/** What a List gets where the Convex facts cannot answer: read the folder from the bucket. */
const NO_FOLDER_NOTES: FolderNotesResult = {
  kind: "folderNotes",
  available: false,
  notes: [],
  cursor: null,
  missing: [],
  fill: false,
};

/** Operations that only read which notes exist, answered from the rows where the tree serves. */
const SERVED_READS = new Set(["workspaceGraph", "notePaths", "folderPaths"]);

/** Organizer actions that only read: `gather` (the sweep's work list) and `outline`. */
const ORGANIZER_READS = new Set(["gather", "outline"]);

/**
 * The store a walk reads: the Convex tree where it serves the workspace
 * (`servedNodesStore`), else the bucket. A walk the Convex tree answers says
 * `nodes`, and the first page of a `source: "tree"` walk carries where a
 * catch-up from the tree's change log starts.
 */
export async function manifestSource(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    operation: { kind: string; source?: string; cursor?: string; action?: unknown };
  },
  store: FileStore,
): Promise<{ store: FileStore; source: "bucket" | "nodes"; since?: number; privacy?: string | null }> {
  // The organizer's read-only passes list every note: from the tree where it
  // serves (phase 5). Its writes keep the bucket's listing and rules.
  if (args.operation.kind === "organizer" && typeof args.operation.action === "string" && ORGANIZER_READS.has(args.operation.action)) {
    const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
    return served === null ? { store, source: "bucket" } : { store: served, source: "nodes" };
  }
  // The Convex tree's shadow starts filling on the first page of any walk (`lib/nodes/run.ts`).
  if (args.operation.kind === "manifest" && args.operation.cursor === undefined) {
    await startNodesSweepIfDue(ctx, args.workspaceId);
  }
  // Read-only readers of which notes exist: the map, link completion and the
  // folder picker read the rows where the tree serves (`servedNodesStore`),
  // and the bucket or the search index where it does not.
  if (SERVED_READS.has(args.operation.kind)) {
    const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
    const chosen = served ?? store;
    const reading = args.operation.kind === "workspaceGraph" ? await withLinkTable(ctx, args, chosen) : chosen;
    return { store: reading, source: served === null ? "bucket" : "nodes" };
  }
  if (args.operation.kind !== "manifest" || args.operation.source !== "tree") return { store, source: "bucket" };
  // The Convex tree, where it serves: the rows the live listings read. The
  // first page says where a catch-up from the tree's change log starts
  // (`nodesFeed.ts`), read before the rows: a move or a rules change landing
  // in between leaves the copy judged by the older version, which walks again,
  // rather than claiming a version the rows were not read under.
  const start = args.operation.cursor === undefined
    ? await ctx
      .runQuery(internal.functions.nodesFeed.walkStart, { workspaceId: args.workspaceId, now: Date.now() })
      .catch(() => null)
    : null;
  const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
  if (served !== null) {
    if (args.operation.cursor !== undefined) return { store: served, source: "nodes" };
    return { store: served, source: "nodes", ...(start === null ? {} : start) };
  }
  return { store, source: "bucket" };
}

/**
 * The map's store: the same store, carrying the Convex facts' link table
 * (`lib/nodes/linkTable.ts`) once they have read every note. Until then, and
 * wherever the tree does not serve, the map reads the search index; a fill is
 * started where the facts are missing or behind.
 */
async function withLinkTable(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
  store: FileStore,
): Promise<FileStore> {
  if (!isServedStore(store)) return store;
  const table = await convexLinkTable(ctx, args.workspaceId, store).catch(() => null);
  if (table === null || table.unparsed > 0) await scheduleFactFill(ctx, args.workspaceId);
  return table === null ? store : attachLinkTable(store, table);
}

/**
 * A List's notes or the chaos score, from the Convex tree and its facts, with
 * the bucket the barrier opened. Neither has anything else to ask: where the
 * tree does not serve or its facts have not read every note, a List reads
 * the folder from the bucket and the score is not shown.
 */
export async function runTreeOperation(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; scope: "private" | "team"; grantedNames?: string[]; operation: TreeOperation },
  store: FileStore,
): Promise<OperationResult> {
  const operation = args.operation;
  const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
  const served = await servedNodesStore(ctx, args.workspaceId, store).catch(() => null);
  if (operation.kind === "folderNotes") {
    // Which notes are in the folder: the Convex tree where it serves and no
    // move is pending (a note then reads at its old key). Their front matter:
    // the rows' own, once the facts have read every note.
    if (served === null || !(await factsReady(ctx, args.workspaceId))) {
      return NO_FOLDER_NOTES;
    }
    const answer = await folderNotesFromNodes(served, factPropSource(ctx, args.workspaceId), operation, clearance);
    if (answer.fill) await scheduleFactFill(ctx, args.workspaceId);
    return answer.available ? answer : NO_FOLDER_NOTES;
  }
  // Counted from the Convex tree's keys where it serves, with its facts once
  // they have read every note.
  if (served === null) return NO_CHAOS;
  const live = await liveChaosScoreOf(served, factChaosSource(ctx, args.workspaceId), operation, clearance).catch(() => null);
  return live ?? NO_CHAOS;
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
