/**
 * A move or rename in a keyed workspace is a row change (`notes-by-id`,
 * `keyed-design.md`): the note's bytes stay at `notes/<noteId>.md`, and only
 * the `nodes` rows change. `path` moves for every row under the moved name,
 * `parentId` and `name` for the root only (its children point at the folder
 * rows themselves, which keep their ids), and nothing is copied or queued.
 *
 * Refused, with nothing written, when:
 *  - the workspace is not keyed (`keyedWorkspace`): the old way moves it;
 *  - a queued byte move is still pending here (its names are not settled);
 *  - the destination, or any path a moved row would take, is held by a live row;
 *  - any file under the name has no key (its flip is not finished);
 *  - the name and the live rows under it are more than `maxRows` (the caller says too large).
 *
 * Everything here is one mutation, so a refusal leaves nothing behind and a
 * success is all of it. Privacy rules are not written here: they live in
 * `privacy.md`, which the caller carries before and releases after
 * (`rowMoveStart.ts`, as `moveStart.ts` does for a queued move).
 *
 * A move into or out of the trash (`trash: true`, `rowTrash.ts`) writes no
 * rules and so checks none: the trashed note keeps its rules at its own name
 * for Restore, and its links and pins stay where they are, as a trash made in
 * one go leaves them. The flag is refused unless one end of the move is under
 * `.context/trash`.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { keyedWorkspace } from "../noteIds/keyedState";
import { convexNodeTable } from "./convexTable";
import { readMirror, treeServesNow } from "./listing";
import { newNoteId } from "./noteIds";
import { followMovesForMembers } from "../placesFollow";
import { markWebsiteMoved } from "../websites/routeChangeAt";
import { freshenMeaningAfterActivity } from "../meaningFns/rows";
import { folderChain, nameOf } from "./table";
import { TRASH_ROOT } from "../fileOps/store";
import { isPlumbing } from "../privacy";
import { refreshAccess } from "./accessBackfill";

/** Live rows one row move may rename, the name itself included. Above this the caller refuses as too large. */
export const ROW_MOVE_MAX = 500;

export type RowMoveRefusal =
  | "not_keyed"
  | "not_served"
  | "busy"
  | "not_found"
  | "taken"
  | "unkeyed"
  | "too_large"
  | "rules_changed"
  | "changed"
  | "invalid";

export type RowMoveAnswer =
  | {
      ok: true;
      kind: "file" | "folder";
      /** Live rows that moved, the root included. */
      rows: number;
      /** Each file that moved, at its old and new path. */
      files: { from: string; to: string }[];
      /** The moved file's etag, for a single note (`movePath`'s answer). */
      etag?: string;
    }
  | { ok: false; reason: RowMoveRefusal };

/** The root and the live rows under `from`, read from `path` order, stopping past `max`. */
export interface Subtree {
  root: Doc<"nodes"> | null;
  below: Doc<"nodes">[];
  over: boolean;
}

/** The row at exactly `path`, live or not. Paths are unique within a workspace. */
export async function rowAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  return await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();
}

/**
 * The live root at `from` and the live rows beneath it. Reads at most
 * `max + 1` of them, then says `over`. Tombstones beneath stay where they are:
 * they say nothing that moves.
 */
export async function subtreeOf(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  from: string,
  max: number,
): Promise<Subtree> {
  const exact = await rowAt(db, workspaceId, from);
  const root = exact !== null && exact.goneAt === undefined ? exact : null;
  const prefix = `${from}/`;
  const below: Doc<"nodes">[] = [];
  for await (const doc of db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", prefix))) {
    if (!doc.path.startsWith(prefix)) break;
    if (doc.goneAt !== undefined) continue;
    below.push(doc);
    if (below.length > max) return { root, below, over: true };
  }
  return { root, below, over: false };
}

/** Whether any live row sits beneath `path`: a destination that is not free even though nothing sits at it. */
async function liveUnder(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<boolean> {
  const prefix = `${path}/`;
  for await (const doc of db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", prefix))) {
    if (!doc.path.startsWith(prefix)) return false;
    if (doc.goneAt === undefined) return true;
  }
  return false;
}

/** Whether a row's etag is `expected`, or its pre-flip path etag while it still holds that key's version (`keyedFrom`). */
export function etagIs(row: Pick<Doc<"nodes">, "etag" | "keyedFrom">, expected: string): boolean {
  if (row.etag === expected) return true;
  return row.keyedFrom !== undefined && row.etag === row.keyedFrom.keyEtag && row.keyedFrom.pathEtag === expected;
}

/** A move that puts a name inside itself, or a folder onto one of its own ancestors, is not a move. */
function invalidMove(from: string, to: string): boolean {
  return from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`);
}

/**
 * Renames the file or folder at `from` to `to` by rewriting rows, in this
 * transaction. See the header for what is refused and what is left alone.
 */
export async function applyRowMove(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    from: string;
    to: string;
    /** The file's etag the caller asked about (a queued rename typed offline). */
    expectedEtag?: string;
    /** The etag of `privacy.md` the caller just wrote; the tree's copy of the rules must be it. */
    privacyEtag: string | null;
    /**
     * The live files under `from` the caller read and judged (`plan`). A file
     * that arrived since is not in the judgement, so the move is refused
     * `changed` rather than moving a note nobody checked.
     */
    plannedFiles?: string[];
    now: number;
    /** Overrides `ROW_MOVE_MAX` (tests only). */
    maxRows?: number;
    /** A move into or out of the trash: no rules are checked or carried, and no links or pins follow. */
    trash?: boolean;
  },
): Promise<RowMoveAnswer> {
  const { workspaceId: ws, from, to, now } = args;
  const refuse = (reason: RowMoveRefusal): RowMoveAnswer => ({ ok: false, reason });
  const trash = args.trash === true;

  if (!(await keyedWorkspace(ctx.db, ws))) return refuse("not_keyed");
  if (!(await treeServesNow(ctx.db, ws))) return refuse("not_served");
  // A byte move still queued from before the flip names paths the rows no longer hold the notes at.
  const queued = await ctx.db.query("moveQueue").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).first();
  if (queued !== null) return refuse("busy");
  // The file version the caller was handed (`privacyEtag` is the file's etag, from `loadPrivacyState`): a file
  // version check, so it compares the file's mirror, not the rows' view. Classified as a guard, not a reader.
  const mirror = await readMirror(ctx.db, ws);
  if (!trash && (mirror?.etag ?? null) !== args.privacyEtag) return refuse("rules_changed");
  if (invalidMove(from, to)) return refuse("invalid");
  if (trash && !from.startsWith(`${TRASH_ROOT}/`) && !to.startsWith(`${TRASH_ROOT}/`)) return refuse("invalid");

  const max = args.maxRows ?? ROW_MOVE_MAX;
  // `subtreeOf` counts the rows beneath; the name is one of the `max`, so `max - 1` of them may sit beneath it.
  const subtree = await subtreeOf(ctx.db, ws, from, max - 1);
  if (subtree.root === null) return refuse("not_found");
  if (subtree.over) return refuse("too_large");
  const root = subtree.root;
  if (args.expectedEtag !== undefined) {
    if (root.kind !== "file") return refuse("invalid");
    if (!etagIs(root, args.expectedEtag)) return refuse("changed");
  }
  const rows = [root, ...subtree.below];
  if (args.plannedFiles !== undefined) {
    const live = rows.filter((row) => row.kind === "file").map((row) => row.path).sort();
    const planned = [...args.plannedFiles].sort();
    if (live.length !== planned.length || live.some((path, index) => path !== planned[index])) return refuse("changed");
  }
  if (rows.some((row) => row.kind === "file" && row.storageKey === undefined)) return refuse("unkeyed");

  // Every destination must be free: no live row at it, none under it, and no live file where a folder must stand.
  const pairs = rows.map((row) => ({ row, from: row.path, to: `${to}${row.path.slice(from.length)}` }));
  const tombstones: Doc<"nodes">[] = [];
  for (const pair of pairs) {
    const held = await rowAt(ctx.db, ws, pair.to);
    if (held !== null && held.goneAt === undefined) return refuse("taken");
    if (held !== null) tombstones.push(held);
  }
  if (await liveUnder(ctx.db, ws, to)) return refuse("taken");
  const ancestors = await Promise.all(folderChain(to).map(async (path) => ({ path, row: await rowAt(ctx.db, ws, path) })));
  if (ancestors.some((entry) => entry.row !== null && entry.row.goneAt === undefined && entry.row.kind === "file")) {
    return refuse("taken");
  }

  // Writes. Nothing above wrote, so every refusal left the rows as they were.
  for (const row of tombstones) await removeReplaced(ctx, row);

  // The folders `to` needs, outermost first: revived where a tombstone held the name, created where nothing did.
  let parentId: Id<"nodes"> | undefined;
  for (const { path, row } of ancestors) {
    if (row !== null && row.kind === "folder") {
      const patch: Partial<Doc<"nodes">> = { observedAt: now, parentId };
      if (row.goneAt !== undefined) patch.goneAt = undefined;
      await ctx.db.patch(row._id, patch);
      parentId = row._id;
      continue;
    }
    // A tombstone file where a folder must stand: the name is free, so it goes.
    if (row !== null) await removeReplaced(ctx, row);
    parentId = await insertFolder(ctx, ws, path, parentId, now);
  }
  const oldParent = root.parentId;

  for (const pair of pairs) {
    const isRoot = pair.row._id === root._id;
    await ctx.db.patch(pair.row._id, {
      path: pair.to,
      observedAt: now,
      ...(isRoot ? { parentId, name: nameOf(to) } : {}),
    });
  }

  // Links name their note by its path: each moved note's links now say where it is. A trash leaves them where
  // they were, for Restore, as a trash made in one go does.
  const files = pairs.filter((pair) => pair.row.kind === "file");
  if (!trash) {
    for (const pair of files) {
      const links = await ctx.db
        .query("nodeLinks")
        .withIndex("by_workspace_source", (q) => q.eq("workspaceId", ws).eq("source", pair.from))
        .collect();
      for (const link of links) await ctx.db.patch(link._id, { source: pair.to });
    }
  }

  // The change log: each file left its old path and appeared at its new one. Folders are not logged, and
  // neither is the trash's plumbing: a note going into the trash is gone, and one restored from it appears.
  const table = convexNodeTable(ctx, ws);
  for (const pair of files) {
    if (!isPlumbing(pair.from)) await table.logChange?.(pair.from, true);
    if (!isPlumbing(pair.to)) await table.logChange?.(pair.to, false);
  }

  await retireEmptied(ctx, ws, oldParent, now);

  // Pins and recents follow a move; a trashed note keeps them at its name, for Restore to find.
  if (!trash) await followMovesForMembers(ctx, ws, [{ from, to }], mirror);
  await markWebsiteMoved(ctx, ws, { from, to });
  await freshenMeaningAfterActivity(ctx, ws);
  // The rows moved and the rules moved with them, so the access rows follow. A tombstone a rule named at the
  // destination (`nodes.access`) was replaced above; the row now holding its name takes the rule's access here.
  await refreshAccess(ctx, ws);

  return {
    ok: true,
    kind: root.kind,
    rows: rows.length,
    files: files.map((pair) => ({ from: pair.from, to: pair.to })),
    ...(root.kind === "file" ? { etag: root.etag } : {}),
  };
}

/**
 * Remove a row a move replaces, with the grants on it: they name a row that is gone. A tombstone a rule
 * named is re-derived onto the row now holding its name (`refreshAccess`, at the end of the move).
 */
async function removeReplaced(ctx: MutationCtx, row: Doc<"nodes">): Promise<void> {
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  for (const grant of grants) await ctx.db.delete(grant._id);
  await ctx.db.delete(row._id);
}

async function insertFolder(
  ctx: MutationCtx,
  ws: Id<"workspaces">,
  path: string,
  parentId: Id<"nodes"> | undefined,
  now: number,
): Promise<Id<"nodes">> {
  return await ctx.db.insert("nodes", {
    workspaceId: ws,
    noteId: newNoteId(),
    path,
    parentId,
    name: nameOf(path),
    kind: "folder",
    observedAt: now,
  });
}

/**
 * Tombstones the folder a move left and then each parent left empty above
 * it, as `observe.ts` does for a tombstone (`retireEmptyFolders`), so the
 * sidebar stops drawing a folder nothing is in.
 */
async function retireEmptied(ctx: MutationCtx, ws: Id<"workspaces">, start: Id<"nodes"> | undefined, now: number): Promise<void> {
  let next = start;
  for (let depth = 0; next !== undefined && depth < 64; depth += 1) {
    const folder = await ctx.db.get(next);
    if (folder === null || folder.kind !== "folder" || folder.goneAt !== undefined) return;
    const child = await ctx.db
      .query("nodes")
      .withIndex("by_parent_name", (q) => q.eq("workspaceId", ws).eq("parentId", next))
      .filter((q) => q.eq(q.field("goneAt"), undefined))
      .first();
    if (child !== null) return;
    await ctx.db.patch(folder._id, { goneAt: now });
    next = folder.parentId;
  }
}
