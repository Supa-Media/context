/**
 * A move on built paths (`paths.ts`; `paths-on-read.md`, "A folder move is one row change"): the moved row
 * takes its new parent and name, and no row beneath it is written. Whatever its size, a folder moves in one
 * transaction, so there is no cap, no paging and no move in flight.
 *
 * A destination is free when nothing live holds it: a row beneath a moved folder keeps its name beneath it,
 * so only the root's name can be taken.
 *
 * A folder of up to `ROW_MOVE_MAX` rows is still read, so what followed each file before follows it now, at
 * once: its files are judged by the caller and checked against what it judged, their links and link facts
 * follow, and the change log names each one at both names. A bigger folder is not read at all:
 *  - the caller judges what is beneath it from the rules beneath it (`builtJudge.ts`);
 *  - its links and link facts follow in the background, a page at a time (`folderLinks.ts`);
 *  - the change log writes nothing, and a device walks after it (`folderMoves`, in the feed token);
 *  - every file beneath was keyed before the workspace built its paths (`paths-on-read.md`, the flip).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { MAIN_ROLES, type MainRole } from "@context/shared/src/folderRoles.cjs";
import { followMovesForMembers } from "../placesFollow";
import { markWebsiteMoved } from "../websites/routeChangeAt";
import { freshenMeaningAfterActivity } from "../meaningFns/rows";
import { refreshSnapshot } from "./accessBackfill";
import { archiveMoveRefusal } from "./archiveTwins";
import { claimJobBeforeMove, jobOfRow } from "./folderJobs";
import { queueFolderLinks } from "./folderLinks";
import type { Rules } from "./log";
import { liveNodeAt, nodeAt } from "./paths";
import { overlapsRowMove } from "./rowMoveChunks";
import {
  ROW_MOVE_MAX,
  chainAt,
  etagIs,
  followMovedFiles,
  liveUnder,
  removeReplaced,
  retireEmptied,
  standFolders,
  subtreeOf,
  type RowMoveAnswer,
  type RowMoveRefusal,
} from "./rowMove";
import { followFolderSettings } from "./settingsFollow";
import { nameOf } from "./table";

export interface BuiltMoveArgs {
  workspaceId: Id<"workspaces">;
  from: string;
  to: string;
  expectedEtag?: string;
  /** Checked for a file, which is its own one planned file; a folder's files are judged by its rules. */
  plannedFiles?: string[];
  now: number;
  trash: boolean;
  /** Who could see each old path, judged before the row moves (`followMovedFiles`). */
  before: Rules;
  /** The rules members' pins are judged by as they follow (`followMovesForMembers`). */
  mirror: Parameters<typeof followMovesForMembers>[3];
}

/** Bump the count of folder moves a device's feed token carries (`nodesFeed.ts`). */
async function countFolderMove(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const tree = await ctx.db
    .query("nodeTrees")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (tree !== null) await ctx.db.patch(tree._id, { folderMoves: (tree.folderMoves ?? 0) + 1 });
}

/** Whether a gone row at a destination can be removed: one with rows beneath it stays, beside the live row. */
async function childless(ctx: MutationCtx, row: Doc<"nodes">): Promise<boolean> {
  const child = await ctx.db
    .query("nodes")
    .withIndex("by_parent_name", (q) => q.eq("workspaceId", row.workspaceId).eq("parentId", row._id))
    .first();
  return child === null;
}

/** The root and the live rows beneath it, when they are at most `ROW_MOVE_MAX`; `whole: false` past that. */
async function listedBeneath(
  ctx: MutationCtx,
  ws: Id<"workspaces">,
  from: string,
  root: Doc<"nodes">,
): Promise<{ rows: Doc<"nodes">[]; whole: boolean }> {
  const subtree = await subtreeOf(ctx.db, ws, from, ROW_MOVE_MAX - 1);
  return subtree.over ? { rows: [root], whole: false } : { rows: [root, ...subtree.below], whole: true };
}

/**
 * A gone row kept at the name, beside the moved one, keeps no setting: the stored-path move removed it with
 * its setting and grants, and a setting left at the name would judge the live row that now holds it.
 */
async function dropSettings(ctx: MutationCtx, row: Doc<"nodes">): Promise<void> {
  for (const grant of await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect()) {
    await ctx.db.delete(grant._id);
  }
  if (row.access !== undefined) await ctx.db.patch(row._id, { access: undefined });
}

export async function applyBuiltMove(ctx: MutationCtx, args: BuiltMoveArgs): Promise<RowMoveAnswer> {
  const { workspaceId: ws, from, to, now, trash } = args;
  const refuse = (reason: RowMoveRefusal): RowMoveAnswer => ({ ok: false, reason });

  const root = await liveNodeAt(ctx.db, ws, from);
  if (root === null) return refuse("not_found");
  if (await overlapsRowMove(ctx.db, ws, from, to)) return refuse("busy");
  if (!trash) {
    const fenced = await archiveMoveRefusal(ctx.db, ws, root, to);
    if (fenced !== null) return refuse(fenced);
  }
  if (args.expectedEtag !== undefined) {
    if (root.kind !== "file") return refuse("invalid");
    if (!etagIs(root, args.expectedEtag)) {
      return root.etag === undefined ? refuse("changed") : { ok: false, reason: "changed", currentEtag: root.etag };
    }
  }
  // A folder of up to `ROW_MOVE_MAX` rows is read whole, as the stored-path move read it: its files are judged
  // and followed one by one. A bigger one is not read at all.
  const listed = root.kind === "file" ? { rows: [root], whole: true } : await listedBeneath(ctx, ws, from, root);
  if (listed.whole) {
    const files = listed.rows.filter((row) => row.kind === "file");
    if (args.plannedFiles !== undefined) {
      const live = files.map((row) => row.path).sort();
      const planned = [...args.plannedFiles].sort();
      if (live.length !== planned.length || live.some((path, index) => path !== planned[index])) return refuse("changed");
    }
    if (files.some((row) => row.storageKey === undefined)) return refuse("unkeyed");
  }

  // Only the root's name can be taken: what is beneath it keeps its name beneath it.
  const held = await nodeAt(ctx.db, ws, to);
  if (held !== null && held.goneAt === undefined) return refuse("taken");
  if (await liveUnder(ctx.db, ws, to)) return refuse("taken");
  const ancestors = await chainAt(ctx.db, ws, to);
  if (ancestors.some((entry) => entry.row !== null && entry.row.goneAt === undefined && entry.row.kind === "file")) {
    return refuse("taken");
  }
  // A main folder is never trashed, whatever the caller checked (`assertNotProtectedFolder`).
  if (trash && MAIN_ROLES.includes((await jobOfRow(ctx.db, ws, root)) as MainRole)) return refuse("invalid");

  // Writes. Nothing above wrote, so every refusal left the rows as they were.
  if (!trash) await claimJobBeforeMove(ctx, ws, root);
  // A gone row at the name goes, with its grants, unless rows still hang off it: the live row is the one read.
  if (held !== null && (await childless(ctx, held))) await removeReplaced(ctx, held);
  else if (held !== null) await dropSettings(ctx, held);
  const parentId = await standFolders(ctx, ws, ancestors, now);
  const oldParent = root.parentId;
  await ctx.db.patch(root._id, { observedAt: now, parentId, name: nameOf(to) });

  const files = listed.whole
    ? listed.rows.filter((row) => row.kind === "file").map((row) => ({ from: row.path, to: `${to}${row.path.slice(from.length)}` }))
    : [];
  if (listed.whole) await followMovedFiles(ctx, ws, files, trash, args.before);
  else {
    await countFolderMove(ctx, ws);
    // A trash leaves links where they were, for Restore.
    if (!trash) await queueFolderLinks(ctx, ws, root._id, from, now);
  }

  await retireEmptied(ctx, ws, oldParent, now);
  // Pins and recents follow a move; a trashed note keeps them at its name, for Restore to find.
  if (!trash) await followMovesForMembers(ctx, ws, [{ from, to }], args.mirror);
  await markWebsiteMoved(ctx, ws, { from, to });
  if (!trash) await followFolderSettings(ctx, ws, from, to);
  await freshenMeaningAfterActivity(ctx, ws);
  // The rules live on rows that moved with the folder, so the access rows are read again.
  await refreshSnapshot(ctx, ws);

  return {
    ok: true,
    kind: root.kind,
    rows: listed.whole ? listed.rows.length : 1,
    files,
    ...(root.kind === "file" ? { etag: root.etag } : {}),
  };
}
