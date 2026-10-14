/**
 * Every app read of *which notes exist*, answered from the Convex tree before
 * a bucket credential is opened, and never from the bucket.
 *
 * Decided by the owner, 2026-10-13: "the only thing that should be reading
 * from storage directly should be actually opening and editing a note ...
 * I don't want to see even fallbacks". Until then each of these readers read
 * the rows where the tree served and walked the bucket (or the search index,
 * or the D1 tables) everywhere else, and the barrier decrypted the bucket's
 * credential for all of them, whether or not it was used.
 *
 * - a one-folder `list` (the console's listing, a shared folder link, a share
 *   card, the routines scan, an Obsidian plugin's vault listing);
 * - a `source: "tree"` `manifest` (a tab's Home, pins, recents and quick
 *   switcher, a List's folder walk, the desktop and phone apps' sync);
 * - `notePaths` (link completion, quick open), `folderPaths` (the picker),
 *   `workspaceGraph` (the map), `visiblePaths` (the map's moves panel);
 * - `folderNotes` (Lists and Boards) and `chaosScore`.
 *
 * Each runs over `servedStoreOrLoading`: the rows for every listing, the
 * rules mirror for `privacy.md`, and a store underneath that throws on any
 * other read, so none of these can reach the bucket even by accident. Who
 * may see what is decided by the same code as before (`listFolder`,
 * `syncManifest`, `canSee`), over the mirror. While the workspace's first
 * copy has not finished, each answers `TREE_LOADING` and starts the copy; a
 * workspace with no bucket bound throws `TreeUnbound`, which the barrier
 * answers as `STORAGE_NOT_CONNECTED`.
 *
 * A `manifest` without `source: "tree"` is not here: only a website Publish
 * asks for one, and it must see a page written past the app at once
 * (`docs/decisions/websites.md`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { clearanceOf, type Clearance } from "../clearance";
import { requireFolderPath } from "../fileOps/paths";
import type { FileStore } from "../fileOps/store";
import { executeOperation } from "../filesFns/executeOperation";
import { toConvexError } from "../filesFns/operationErrors";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { folderNotesFromNodes } from "../filesFns/folderNotes";
import { liveChaosScoreOf, NO_CHAOS, type ChaosSource } from "../filesFns/chaosOps";
import { factChaosSource, factPropSource } from "./factSources";
import { scheduleFactFill } from "./factFill";
import { attachLinkTable, convexLinkTable } from "./linkTable";
import { notServed, readinessAndKick, servedStoreOrLoading } from "./treeLoading";

const TREE_READS = new Set(["list", "notePaths", "folderPaths", "workspaceGraph", "visiblePaths", "folderNotes", "chaosScore"]);

/** Whether the tree answers this operation, with no bucket credential opened. */
export function isTreeRead(operation: { kind: string; source?: unknown }): boolean {
  if (operation.kind === "manifest") return operation.source === "tree";
  return TREE_READS.has(operation.kind);
}

type ReadArgs = {
  workspaceId: Id<"workspaces">;
  scope: "private" | "team";
  grantedNames?: string[];
  operation: { kind: string; [field: string]: unknown };
};

/** The answer to a tree read (`isTreeRead`), or `TREE_LOADING` thrown. Never opens the bucket. */
export async function treeReadAnswer(ctx: ActionCtx, args: ReadArgs): Promise<OperationResult> {
  const clearance = clearanceOf(args.scope, args.grantedNames ?? []);
  const operation = args.operation;
  if (operation.kind === "list") return await oneFolder(ctx, args);
  if (operation.kind === "manifest") return await manifestPage(ctx, args, clearance);
  const served = await servedStoreOrLoading(ctx, args.workspaceId);
  if (operation.kind === "folderNotes") return await folderNotes(ctx, args.workspaceId, served, operation, clearance);
  if (operation.kind === "chaosScore") return await chaosScore(ctx, args.workspaceId, served, operation, clearance);
  const store = operation.kind === "workspaceGraph" ? await withLinks(ctx, args.workspaceId, served) : served;
  return await run(store, clearance, operation, args.workspaceId);
}

/** `executeOperation` over a served store: the same reader, its errors converted the same way. */
function run(store: FileStore, clearance: Clearance, operation: ReadArgs["operation"], workspaceId: Id<"workspaces">) {
  return executeOperation(store, clearance, operation as FileOperation, Date.now(), null, null, () => {}, () => {}, workspaceId);
}

/** One folder from its own rows (`nodesListing.listServed`), at the barrier's clearance. */
async function oneFolder(ctx: ActionCtx, args: ReadArgs): Promise<OperationResult> {
  const path = args.operation.path;
  try {
    // A malformed path is refused in the bucket listing's own words, before any read.
    requireFolderPath(typeof path === "string" ? path : "");
    if (typeof path !== "string") throw new Error("no path");
  } catch (error) {
    throw toConvexError(error);
  }
  const listing = await ctx.runQuery(internal.functions.nodesListing.listServed, {
    workspaceId: args.workspaceId,
    path,
    scope: args.scope,
    ...(args.grantedNames === undefined ? {} : { grantedNames: args.grantedNames }),
  });
  if (listing !== null) return listing as OperationResult;
  const readiness = await readinessAndKick(ctx, args.workspaceId);
  throw notServed(readiness === "served" ? "loading" : readiness);
}

/**
 * One page of a whole-tree walk. The first page says where a catch-up from
 * the tree's change log starts (`nodesFeed.ts`), read before the rows: a move
 * or a rules change landing in between leaves the copy judged by the older
 * version, which walks again, rather than claiming a version the rows were
 * not read under.
 */
async function manifestPage(ctx: ActionCtx, args: ReadArgs, clearance: Clearance): Promise<OperationResult> {
  const first = args.operation.cursor === undefined;
  const start = first
    ? await ctx.runQuery(internal.functions.nodesFeed.walkStart, { workspaceId: args.workspaceId, now: Date.now() }).catch(() => null)
    : null;
  const served = await servedStoreOrLoading(ctx, args.workspaceId);
  const result = await run(served, clearance, args.operation, args.workspaceId);
  return { ...result, source: "nodes", ...(start === null ? {} : start) } as OperationResult;
}

/**
 * The map's store: the Convex facts' link table once they have read every
 * note. Until then the map draws every note from the rows and says it is
 * behind on links (`workspaceGraph`); a fill is started where the facts are
 * missing or behind. Never the search index.
 */
async function withLinks(ctx: ActionCtx, workspaceId: Id<"workspaces">, served: FileStore): Promise<FileStore> {
  const table = await convexLinkTable(ctx, workspaceId, served).catch(() => null);
  if (table === null || table.unparsed > 0) await scheduleFactFill(ctx, workspaceId);
  return table === null ? served : attachLinkTable(served, table);
}

/**
 * A List or Board: the folder's notes from the rows, their front matter from
 * each row's facts. A note whose facts lag its version shows what was last
 * parsed; one never parsed yet is reported `missing` (a gap the List says it
 * may have), and the facts fill is started. No note is read.
 */
async function folderNotes(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  served: FileStore,
  operation: ReadArgs["operation"],
  clearance: Clearance,
): Promise<OperationResult> {
  const answer = await folderNotesFromNodes(
    served,
    factPropSource(ctx, workspaceId),
    operation as unknown as { folder: string; subfolders: boolean; cursor?: string },
    clearance,
  ).catch((error) => {
    throw toConvexError(error);
  });
  if (answer.fill) await scheduleFactFill(ctx, workspaceId);
  return answer;
}

/**
 * The chaos score, counted from the rows' keys. What a key cannot say (a
 * note's length, a contact's review) comes from the facts; before they have
 * read every note the score is counted from the keys alone, not recorded in
 * the history, and the fill is started.
 */
async function chaosScore(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  served: FileStore,
  operation: ReadArgs["operation"],
  clearance: Clearance,
): Promise<OperationResult> {
  const facts = factChaosSource(ctx, workspaceId);
  let whole = true;
  const source: ChaosSource = {
    ...facts,
    extras: async () => {
      const found = await facts.extras();
      if (found !== null) return found;
      whole = false;
      await scheduleFactFill(ctx, workspaceId);
      return new Map();
    },
    record: async (totals) => {
      if (whole) await facts.record?.(totals);
    },
  };
  const live = await liveChaosScoreOf(served, source, operation as { folder?: string }, clearance).catch(() => null);
  return live ?? NO_CHAOS;
}
