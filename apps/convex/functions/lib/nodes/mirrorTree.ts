/**
 * The workspace object's tree changes, mirrored into Convex (`functions/objectRowsMirror.ts` `tree`, the route
 * `POST /gateway/rows/mirror` with op `tree`). Decided by the owner, 2026-11-02:
 * `docs/decisions/storage-and-credentials/object-row-writes.md`.
 *
 * One record is one change the object already took: the folders it stood up or brought back (outermost first), the
 * moves it made, and the rows it retired or erased. It is applied in that order, in one mutation, and every lookup
 * and refusal happens before the first write, so a refused change leaves nothing behind. The follow-ups a move runs
 * in Convex (links, change log, pins, folder settings, website, meaning, access snapshot) run as they do for a row
 * move from the app, with the trash flag's semantics. What the object already decided is not judged again: no job
 * claim, no archive fence, no privacy check, no retiring of emptied folders (the object sends those as `removed`).
 *
 * Refusals answer `{ applied: false, reason }` and never throw, so the caller drops the change rather than retrying it.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { OBJECT_ROW_ID, nodeByObjectId } from "./objectIds";
import { liveNodeAt, nodeAt, nodePaths } from "./paths";
import { readerMirror } from "./readerRules";
import { mirrorRules, type Rules } from "./log";
import { followMovesForMembers } from "../placesFollow";
import { markWebsiteMoved } from "../websites/routeChangeAt";
import { freshenMeaningAfterActivity } from "../meaningFns/rows";
import { refreshSnapshot } from "./accessBackfill";
import { followFolderSettings } from "./settingsFollow";
import { queueFolderLinks } from "./folderLinks";
import { childless, countFolderMove, dropSettings } from "./builtMove";
import { ROW_MOVE_MAX, chainAt, followMovedFiles, liveUnder, removeReplaced, subtreeOf } from "./rowMove";
import { nameOf, type PrivacyMirror } from "./table";

/** The most entries one change carries in each list; above it the change is refused `bad_record`. */
export const MIRROR_TREE_MAX = 500;

export interface MirrorTreeFolder {
  id: string;
  noteId: string | null;
  path: string;
  role: string | null;
  at: number;
}

export interface MirrorTreeMove {
  id: string;
  kind: "file" | "folder";
  from: string;
  to: string;
  at: number;
}

export interface MirrorTreeRecord {
  moves: MirrorTreeMove[];
  folders: MirrorTreeFolder[];
  removed: { id: string; at: number }[];
  trash: boolean;
  erase?: boolean;
}

export type MirrorTreeAnswer = { applied: true } | { applied: false; reason: string };

type NodeFields = Partial<Omit<Doc<"nodes">, "_id" | "_creationTime">>;

/** The folder's parent path, or `null` at the top of the workspace. */
function parentOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? null : path.slice(0, slash);
}

/** A move that puts a name inside itself, or a name onto one of its own ancestors, is not a move. */
function invalidMove(from: string, to: string): boolean {
  return from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`);
}

/** Two paths name overlapping subtrees: one is the other, or sits beneath it. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Set the fields and bring the row's `objectAt` to the object's clock, never backwards. Reads the row afresh. */
async function stamp(ctx: MutationCtx, row: Doc<"nodes">, at: number, fields: NodeFields): Promise<void> {
  const current = await ctx.db.get(row._id);
  if (current === null) return;
  await ctx.db.patch(row._id, { ...fields, objectAt: Math.max(current.objectAt ?? 0, at) });
}

type FolderStep =
  | { kind: "skip" }
  | { kind: "revive"; row: Doc<"nodes">; folder: MirrorTreeFolder }
  | { kind: "adopt"; row: Doc<"nodes">; folder: MirrorTreeFolder }
  | { kind: "insert"; folder: MirrorTreeFolder };

type Refusal = { applied: false; reason: string };

/**
 * The folders' plan, read before anything is written. A folder the object names by a row Convex has (`nodeByObjectId`)
 * is revived at its path; a live row already at the path is adopted (its clock only, no second folder); otherwise a
 * folder is made, under its object id when the id is one of the object's (`OBJECT_ROW_ID`), else skipped.
 */
async function planFolders(
  ctx: MutationCtx,
  ws: Id<"workspaces">,
  folders: MirrorTreeFolder[],
): Promise<{ steps: FolderStep[]; livePaths: Set<string> } | Refusal> {
  const steps: FolderStep[] = [];
  const livePaths = new Set<string>();
  for (const folder of folders) {
    const existing = await nodeByObjectId(ctx.db, ws, folder.id);
    const held = await liveNodeAt(ctx.db, ws, folder.path);
    let step: FolderStep;
    if (existing !== null) {
      if (existing.kind !== "folder") return { applied: false, reason: "changed" };
      if (held !== null && held._id !== existing._id) return { applied: false, reason: "taken" };
      step = { kind: "revive", row: existing, folder };
    } else if (held !== null) {
      if (held.kind !== "folder") return { applied: false, reason: "taken" };
      step = { kind: "adopt", row: held, folder };
    } else if (OBJECT_ROW_ID.test(folder.id)) {
      step = { kind: "insert", folder };
    } else {
      step = { kind: "skip" };
    }
    if (step.kind !== "skip") {
      const parent = parentOf(folder.path);
      if (parent !== null && !livePaths.has(parent) && (await liveNodeAt(ctx.db, ws, parent))?.kind !== "folder") {
        return { applied: false, reason: "bad_record" };
      }
      livePaths.add(folder.path);
    }
    steps.push(step);
  }
  return { steps, livePaths };
}

interface PlannedMove {
  move: MirrorTreeMove;
  root: Doc<"nodes">;
  /** Live rows beneath the root, read when the folder is small enough to follow row by row. */
  beneath: Doc<"nodes">[];
  /** A folder past `ROW_MOVE_MAX` rows on built paths: not read, followed in the background. */
  big: boolean;
  /** Gone rows at a destination the move takes (removed on write). */
  tombstones: Doc<"nodes">[];
  /** Built paths: whether the root's destination tombstone has rows under it (kept, with its settings dropped). */
  builtHeld: Doc<"nodes"> | null;
}

/**
 * Every move's plan, read before anything is written. Built paths move the root alone; stored paths also rewrite
 * the path of every live row beneath (`too_large` past `ROW_MOVE_MAX`). Moves that overlap each other are refused
 * `changed`: each one is planned against the rows as they stood, so two of them cannot touch the same name.
 */
async function planMoves(
  ctx: MutationCtx,
  ws: Id<"workspaces">,
  moves: MirrorTreeMove[],
  folderPaths: Set<string>,
  livePaths: Set<string>,
): Promise<{ planned: PlannedMove[] } | Refusal> {
  for (let i = 0; i < moves.length; i += 1) {
    for (let j = i + 1; j < moves.length; j += 1) {
      const a = moves[i];
      const b = moves[j];
      if (overlaps(a.from, b.from) || overlaps(a.from, b.to) || overlaps(a.to, b.from) || overlaps(a.to, b.to)) {
        return { applied: false, reason: "changed" };
      }
    }
  }
  const paths = await nodePaths(ctx.db, ws);
  const built = paths.built;
  const planned: PlannedMove[] = [];
  for (const move of moves) {
    const row = await nodeByObjectId(ctx.db, ws, move.id);
    if (row === null || row.goneAt !== undefined) return { applied: false, reason: "no_row" };
    if (row.kind !== move.kind || invalidMove(move.from, move.to)) return { applied: false, reason: "changed" };
    if ((await paths.pathOf(row)) !== move.from) return { applied: false, reason: "changed" };
    if (folderPaths.has(move.to)) return { applied: false, reason: "taken" };
    const parent = parentOf(move.to);
    if (parent !== null && !livePaths.has(parent) && (await liveNodeAt(ctx.db, ws, parent))?.kind !== "folder") {
      return { applied: false, reason: "bad_record" };
    }
    if (await liveUnder(ctx.db, ws, move.to)) return { applied: false, reason: "taken" };
    const ancestors = await chainAt(ctx.db, ws, move.to);
    if (ancestors.some((entry) => entry.row !== null && entry.row.goneAt === undefined && entry.row.kind === "file")) {
      return { applied: false, reason: "taken" };
    }

    const subtree = await subtreeOf(ctx.db, ws, move.from, built ? ROW_MOVE_MAX - 1 : ROW_MOVE_MAX);
    if (subtree.root === null) return { applied: false, reason: "no_row" };
    if (!built && subtree.over) return { applied: false, reason: "too_large" };
    const big = built && subtree.over;
    const beneath = big ? [] : subtree.below;

    const tombstones: Doc<"nodes">[] = [];
    let builtHeld: Doc<"nodes"> | null = null;
    if (built) {
      const held = await nodeAt(ctx.db, ws, move.to);
      if (held !== null && held.goneAt === undefined) return { applied: false, reason: "taken" };
      builtHeld = held;
    } else {
      const pairs = [subtree.root, ...beneath].map((r) => ({ to: `${move.to}${r.path.slice(move.from.length)}` }));
      for (const pair of pairs) {
        const held = await nodeAt(ctx.db, ws, pair.to);
        if (held !== null && held.goneAt === undefined) return { applied: false, reason: "taken" };
        if (held !== null) tombstones.push(held);
      }
    }
    planned.push({ move, root: subtree.root, beneath, big, tombstones, builtHeld });
  }
  return { planned };
}

/** The removed rows that still exist, read before anything is written. */
async function planRemovals(
  ctx: MutationCtx,
  ws: Id<"workspaces">,
  removed: { id: string; at: number }[],
  movedIds: Set<Id<"nodes">>,
): Promise<{ rows: { row: Doc<"nodes">; at: number }[] } | Refusal> {
  const rows: { row: Doc<"nodes">; at: number }[] = [];
  for (const entry of removed) {
    const row = await nodeByObjectId(ctx.db, ws, entry.id);
    if (row === null) continue;
    if (movedIds.has(row._id)) return { applied: false, reason: "changed" };
    rows.push({ row, at: entry.at });
  }
  return { rows };
}

/** The folder a move or a new folder stands in: the live folder at `path`'s parent, or none at the top. */
async function parentIdAt(ctx: MutationCtx, ws: Id<"workspaces">, path: string): Promise<Id<"nodes"> | undefined> {
  const parent = parentOf(path);
  if (parent === null) return undefined;
  return (await liveNodeAt(ctx.db, ws, parent))?._id;
}

async function writeFolder(ctx: MutationCtx, ws: Id<"workspaces">, step: FolderStep): Promise<void> {
  if (step.kind === "skip") return;
  const { folder } = step;
  if (step.kind === "adopt") {
    await stamp(ctx, step.row, folder.at, {});
    return;
  }
  const parentId = await parentIdAt(ctx, ws, folder.path);
  const role = folder.role ?? undefined;
  if (step.kind === "revive") {
    await stamp(ctx, step.row, folder.at, {
      path: folder.path,
      name: nameOf(folder.path),
      parentId,
      goneAt: undefined,
      ...(role === undefined ? {} : { role }),
    });
    return;
  }
  await ctx.db.insert("nodes", {
    workspaceId: ws,
    path: folder.path,
    parentId,
    name: nameOf(folder.path),
    kind: "folder",
    observedAt: folder.at,
    objectId: folder.id,
    objectAt: folder.at,
    ...(folder.noteId ? { noteId: folder.noteId } : {}),
    ...(role === undefined ? {} : { role }),
  });
}

async function writeMove(ctx: MutationCtx, ws: Id<"workspaces">, plan: PlannedMove, built: boolean): Promise<void> {
  const { move, root } = plan;
  // A gone row at the destination goes, as a row move replaces it; on built paths one with rows under it stays,
  // beside the live row, and keeps no settings (`builtMove.ts`).
  if (built && plan.builtHeld !== null) {
    if (await childless(ctx, plan.builtHeld)) await removeReplaced(ctx, plan.builtHeld);
    else await dropSettings(ctx, plan.builtHeld);
  }
  for (const tombstone of plan.tombstones) await removeReplaced(ctx, tombstone);

  await stamp(ctx, root, move.at, {
    path: move.to,
    name: nameOf(move.to),
    parentId: await parentIdAt(ctx, ws, move.to),
  });
  if (!built) {
    for (const row of plan.beneath) await stamp(ctx, row, move.at, { path: `${move.to}${row.path.slice(move.from.length)}` });
  }
}

/** The follow-ups a row move runs after its rows change (`rowMove.ts` `applyRowMove`, `builtMove.ts`). */
async function followMove(
  ctx: MutationCtx,
  ws: Id<"workspaces">,
  plan: PlannedMove,
  trash: boolean,
  at: number,
  before: Rules,
  mirror: PrivacyMirror,
): Promise<void> {
  const { move, root } = plan;
  if (!plan.big) {
    const rows = [root, ...plan.beneath].filter((row) => row.kind === "file");
    const files = rows.map((row) => ({ from: row.path, to: `${move.to}${row.path.slice(move.from.length)}` }));
    await followMovedFiles(ctx, ws, files, trash, before);
  } else {
    await countFolderMove(ctx, ws);
    // A trash leaves links where they were, for Restore.
    if (!trash) await queueFolderLinks(ctx, ws, root._id, move.from, at);
  }
  // Pins and recents follow a move; a trashed note keeps them at its name, for Restore to find.
  if (!trash) await followMovesForMembers(ctx, ws, [{ from: move.from, to: move.to }], mirror);
  await markWebsiteMoved(ctx, ws, { from: move.from, to: move.to });
  if (!trash) await followFolderSettings(ctx, ws, move.from, move.to);
  await freshenMeaningAfterActivity(ctx, ws);
  await refreshSnapshot(ctx, ws);
}

/**
 * Applies one tree change: folders, then moves, then removals. Answers `applied: false` (writing nothing) when a
 * name the change needs is taken, a row is missing, or a list is over `MIRROR_TREE_MAX`.
 */
export async function mirrorTree(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; objectAt: number; record: MirrorTreeRecord },
): Promise<MirrorTreeAnswer> {
  const { workspaceId: ws, record } = args;
  if (record.moves.length > MIRROR_TREE_MAX || record.folders.length > MIRROR_TREE_MAX || record.removed.length > MIRROR_TREE_MAX) {
    return { applied: false, reason: "bad_record" };
  }

  // Reads only, until every refusal is decided.
  const folders = await planFolders(ctx, ws, record.folders);
  if ("applied" in folders) return folders;
  const folderPaths = new Set(record.folders.map((folder) => folder.path));
  const moves = await planMoves(ctx, ws, record.moves, folderPaths, folders.livePaths);
  if ("applied" in moves) return moves;
  const movedIds = new Set(moves.planned.map((plan) => plan.root._id));
  const removals = await planRemovals(ctx, ws, record.removed, movedIds);
  if ("applied" in removals) return removals;
  const built = (await nodePaths(ctx.db, ws)).built;
  const mirror = await readerMirror(ctx, ws);
  const before = await mirrorRules(mirror);

  // Writes.
  for (const step of folders.steps) await writeFolder(ctx, ws, step);
  for (const plan of moves.planned) await writeMove(ctx, ws, plan, built);
  for (const { row, at } of removals.rows) {
    if (record.erase === true) {
      for (const grant of await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect()) {
        await ctx.db.delete(grant._id);
      }
      await ctx.db.delete(row._id);
    } else if (row.goneAt === undefined) {
      await stamp(ctx, row, at, { goneAt: at });
    }
  }
  // Follow-ups, once the rows have all moved, in the order the object made the moves.
  for (const plan of moves.planned) await followMove(ctx, ws, plan, record.trash, plan.move.at, before, mirror);
  return { applied: true };
}

