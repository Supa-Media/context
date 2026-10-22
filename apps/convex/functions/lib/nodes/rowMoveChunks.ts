/**
 * A keyed folder move too big for one transaction, moved a page at a time
 * (`rowMove.ts` moves anything within `ROW_MOVE_MAX` in one go).
 *
 * The move is a `rowMoves` row. Its first mutation (`beginChunkedMove`) makes
 * every check a whole move makes that does not need each row (the name exists,
 * the destination and everything under it is free, the rules are the ones the
 * caller judged, nothing overlapping is moving), then moves the root row, stands
 * the destination's folders and records the move. Each page after it
 * (`moveRowPage`) moves the next `ROW_MOVE_MAX` live rows under the old name,
 * in path order, so a folder always moves before what is in it. Row ids are
 * kept, so a moved row's children still point at it.
 *
 * While the row is `moving`, the half-moved folder reads as one folder at its
 * new name, and each note is found exactly once:
 *  - a listing folds the rows still at the old name to the new one
 *    (`movingRowMoves`, read beside the queued moves by `listing.ts` and
 *    `treeTaken.ts`), the way a queued byte move is drawn;
 *  - the id layer's lookup by path (`throughRowMoves`, `noteIdsKeyed.ts`)
 *    finds a note at whichever name its row holds now, so an open note, a
 *    write and a new note all land on the one row;
 *  - in rows mode every access row under either name is also read at the
 *    other (`withMovingAccess`, `accessRows.ts`), so a row is judged by the
 *    same rules wherever it sits mid-move. In file mode the caller carried the
 *    rules to the new name before the first mutation and releases the old ones
 *    after the last, as for a move made in one go; a page that finds the rules
 *    changed since moves nothing and asks for them to be carried again
 *    (`rules_changed`), so a rule written mid-move is never left behind.
 *
 * A page is idempotent: it reads where the rows are now and moves what is
 * still at the old name, so a page run twice, or by the request and the
 * watchdog at once, moves each row once. The request that started the move
 * drives the pages (`rowMoveDrive.ts`); if it dies, the watchdog
 * (`nodeRowMoves.continueRowMove`) finishes the rows, and asking for the same
 * move again finishes the bucket-side steps.
 *
 * A row that cannot move is left at the old name, under a folder of that name
 * (made private in rows mode, so leaving it never widens it): one the mover
 * could not see, a file with no key, or a name somebody took meanwhile. Its
 * children stay with it. After the walk reaches the end, a second walk from the
 * start picks up anything that arrived behind it; the move finishes after that.
 * The whole-move steps run once: pins and settings follow, and the website is
 * marked, at the start; the emptied folder is retired, and the website marked
 * again, at the end.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { clearanceOf } from "../clearance";
import { underHiddenRoot } from "../fileOps/store";
import { canSee } from "../privacy";
import { MAIN_ROLES, type MainRole } from "@context/shared/src/folderRoles.cjs";
import { followMovesForMembers } from "../placesFollow";
import { markWebsiteMoved } from "../websites/routeChangeAt";
import { freshenMeaningAfterActivity } from "../meaningFns/rows";
import { accessSourceOf, refreshAccess } from "./accessBackfill";
import { claimJobBeforeMove, jobOfRow } from "./folderJobs";
import { followFolderSettings } from "./settingsFollow";
import { privacyEtagOf, readerMirror, rulesForReaders } from "./readerRules";
import { type PrivacyMirror, nameOf } from "./table";
import { type PendingMove, pendingMoves } from "./moveOverlay";
import type { AccessRow } from "./rowAccess";
import {
  ROW_MOVE_MAX,
  type RowMoveAnswer,
  chainAt,
  followMovedFiles,
  liveUnder,
  removeReplaced,
  retireEmptied,
  rowAt,
  standFolders,
} from "./rowMove";

/** Rows of tombstones and left rows one page may read past before it stops: bounds a page's reads. */
const PAGE_SCAN = ROW_MOVE_MAX * 4;
/** How long a page's progress holds off the watchdog: the request is driving it. */
export const ROW_MOVE_LEASE_MS = 30_000;
/** How long a moved record waits for its request to settle the bucket's side before the watchdog lets it go. */
export const ROW_MOVE_SETTLE_MS = 24 * 60 * 60 * 1000;
/** Moves one workspace reads through at once. Each holds its own names, and overlapping ones are refused. */
const MOVING_PER_WORKSPACE = 20;

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** `path` under `from`, renamed to sit under `to`; `null` when it is not under `from`. */
function rebased(path: string, from: string, to: string): string | null {
  return within(path, from) ? `${to}${path.slice(from.length)}` : null;
}

function nested(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

/** The workspace's keyed moves still moving, oldest first. */
export async function movingRowMoves(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"rowMoves">[]> {
  const rows = await db
    .query("rowMoves")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MOVING_PER_WORKSPACE * 2);
  return rows.filter((row) => row.state === "moving").sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Every move the tree draws already, as a listing folds them (`moveOverlay.ts`): the queued byte moves, then
 * the keyed moves still moving. A keyed workspace never has the first and an unkeyed one never the second
 * (`rowMove.ts` refuses while a byte move is queued), so the order never composes two kinds.
 */
export async function drawnMoves(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<PendingMove[]> {
  const keyed = (await movingRowMoves(db, workspaceId)).map((row) => ({ from: row.from, to: row.to }));
  return [...(await pendingMoves(db, workspaceId)), ...keyed];
}

/** Whether a move of `from` to `to` touches a name a keyed move is still carrying: one move per subtree at a time. */
export async function overlapsRowMove(db: DatabaseReader, workspaceId: Id<"workspaces">, from: string, to: string): Promise<boolean> {
  const moving = await movingRowMoves(db, workspaceId);
  return moving.some((move) => [from, to].some((path) => nested(path, move.from) || nested(path, move.to)));
}

async function liveRowAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<boolean> {
  const row = await rowAt(db, workspaceId, path);
  return row !== null && row.goneAt === undefined;
}

/**
 * The name the id layer looks `path` up at while a keyed move is carrying it: wherever its row is now. A name
 * under the new folder whose row has not moved yet is found at the old one; a name under the old folder whose
 * row has moved is found at the new one, and so is a new note asked for under the old name, which then lands
 * in the folder people see. A trash is not followed in: a note under a folder going to the trash is either
 * still there or gone. Anything no move carries is `path` itself.
 */
export async function throughRowMoves(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  path: string,
  /** The moving moves, when the caller already read them for several paths. */
  read?: readonly Pick<Doc<"rowMoves">, "from" | "to">[],
): Promise<string> {
  const moving = read ?? (await movingRowMoves(db, workspaceId));
  for (const move of moving) {
    const oldName = rebased(path, move.to, move.from);
    const newName = rebased(path, move.from, move.to);
    if (oldName === null && newName === null) continue;
    if (await liveRowAt(db, workspaceId, path)) return path;
    if (oldName !== null) return (await liveRowAt(db, workspaceId, oldName)) ? oldName : path;
    if (underHiddenRoot(move.to)) return path;
    return newName as string;
  }
  return path;
}

/**
 * The access rows as readers judge them while keyed moves are moving: every row under either name of a move
 * is read at the other too, where no row there says otherwise, so a row is judged by the same rules wherever
 * it sits. Nothing else lives under the new name (it was free when the move began), so the copies only ever
 * stand in for the rows that moved, or have not yet.
 */
export function withMovingAccess(rows: AccessRow[], moving: readonly Pick<Doc<"rowMoves">, "from" | "to">[]): AccessRow[] {
  if (moving.length === 0) return rows;
  const held = new Set(rows.map((row) => row.path));
  const copies: AccessRow[] = [];
  for (const move of moving) {
    for (const row of rows) {
      const other = rebased(row.path, move.from, move.to) ?? rebased(row.path, move.to, move.from);
      if (other === null || held.has(other)) continue;
      held.add(other);
      copies.push({ ...row, path: other });
    }
  }
  return copies.length === 0 ? rows : [...rows, ...copies];
}

/**
 * The first mutation of a chunked move: the whole-move checks, then the root moves and the move is recorded.
 * Every check is made before anything is written, so a refusal changes nothing.
 */
export async function beginChunkedMove(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    root: Doc<"nodes">;
    from: string;
    to: string;
    now: number;
    trash: boolean;
    privacyEtag: string | null;
    clearance: { scope: "private" | "team"; grantedNames: string[] };
    mirror: PrivacyMirror | null;
  },
): Promise<RowMoveAnswer> {
  const { workspaceId: ws, root, from, to, now, trash } = args;
  const refuse = (reason: "taken" | "invalid"): RowMoveAnswer => ({ ok: false, reason });
  const held = await rowAt(ctx.db, ws, to);
  if (held !== null && held.goneAt === undefined) return refuse("taken");
  if (await liveUnder(ctx.db, ws, to)) return refuse("taken");
  const ancestors = await chainAt(ctx.db, ws, to);
  if (ancestors.some((entry) => entry.row !== null && entry.row.goneAt === undefined && entry.row.kind === "file")) {
    return refuse("taken");
  }
  if (trash && MAIN_ROLES.includes((await jobOfRow(ctx.db, ws, root)) as MainRole)) return refuse("invalid");

  if (!trash) await claimJobBeforeMove(ctx, ws, root);
  if (held !== null) await removeReplaced(ctx, held);
  const parentId = await standFolders(ctx, ws, ancestors, now);
  await ctx.db.patch(root._id, { path: to, observedAt: now, parentId, name: nameOf(to) });
  const id = await ctx.db.insert("rowMoves", {
    workspaceId: ws,
    from,
    to,
    trash,
    state: "moving",
    scope: args.clearance.scope,
    grantedNames: args.clearance.grantedNames,
    // A trash carries no rules, and in rows mode the rows are the rules: only a file-mode move waits on them.
    privacyEtag: trash || (await accessSourceOf(ctx.db)) === "rows" ? null : args.privacyEtag,
    pass: 1,
    ...(root.parentId === undefined ? {} : { oldParentId: root.parentId }),
    moved: 1,
    left: 0,
    now,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Once, for the whole move: pins and recents, and the settings naming the folder, follow it now, so new
  // writes land at the new name; the website stops serving what it carries away.
  if (!trash) await followMovesForMembers(ctx, ws, [{ from, to }], args.mirror);
  await markWebsiteMoved(ctx, ws, { from, to });
  if (!trash) await followFolderSettings(ctx, ws, from, to);
  await freshenMeaningAfterActivity(ctx, ws);
  await refreshAccess(ctx, ws);
  await ctx.scheduler.runAfter(ROW_MOVE_LEASE_MS, internal.functions.nodeRowMoves.continueRowMove, { id });
  return { ok: true, kind: "folder", rows: 1, files: [], chunked: id };
}

export type RowMovePage =
  | { state: "moving" | "done"; files: { from: string; to: string }[]; left: number }
  | { state: "rules_changed" | "gone"; files: []; left: number };

/**
 * Whether every rule and exception under the old name is also at the new one, saying the same: a file-mode
 * move whose rules changed since they were carried needs them carried again only when this is false.
 */
export function stillCarried(mirror: Pick<PrivacyMirror, "folders" | "notes">, from: string, to: string): boolean {
  const folders = new Map(mirror.folders.map((rule) => [rule.prefix, rule.visibility]));
  const notes = new Map(mirror.notes.map((rule) => [rule.path, rule.visibility]));
  for (const rule of mirror.folders) {
    const there = rebased(rule.prefix, from, to);
    if (there !== null && folders.get(there) !== rule.visibility) return false;
  }
  for (const rule of mirror.notes) {
    const there = rebased(rule.path, from, to);
    if (there !== null && notes.get(there) !== rule.visibility) return false;
  }
  return true;
}

/** Whether a row carries access of its own: moving it changes what the access rows say. */
async function carriesAccess(ctx: MutationCtx, row: Doc<"nodes">): Promise<boolean> {
  if (row.access !== undefined) return true;
  return (await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).first()) !== null;
}

/**
 * The folder a left row stays in, at the old name: the row its parent was, if that stayed too, or one stood
 * there now. In rows mode a folder stood here is private: the rules it stood under went with the folder that
 * moved, and a left row must never come out wider than it was.
 */
async function folderForLeft(ctx: MutationCtx, ws: Id<"workspaces">, path: string, now: number, rowsMode: boolean): Promise<Id<"nodes"> | undefined> {
  const chain = [...(await chainAt(ctx.db, ws, path)), { path, row: await rowAt(ctx.db, ws, path) }];
  if (chain.some((entry) => entry.row !== null && entry.row.goneAt === undefined && entry.row.kind === "file")) return undefined;
  const fresh = chain.filter((entry) => entry.row === null || entry.row.goneAt !== undefined).map((entry) => entry.path);
  const id = await standFolders(ctx, ws, chain, now);
  if (rowsMode) {
    for (const folder of fresh) {
      const row = await rowAt(ctx.db, ws, folder);
      if (row !== null && row.access === undefined) await ctx.db.patch(row._id, { access: { base: "private" } });
    }
  }
  return id;
}

/**
 * The next page of a chunked move (see the header). Answers what it moved, `done` once the move has finished,
 * `rules_changed` when a file-mode move must have its rules carried again first, and `gone` for no such move.
 */
export async function moveRowPage(ctx: MutationCtx, id: Id<"rowMoves">): Promise<RowMovePage> {
  const move = await ctx.db.get(id);
  if (move === null) return { state: "gone", files: [], left: 0 };
  if (move.state === "moved") return { state: "done", files: [], left: move.left };
  const ws = move.workspaceId;
  if (move.privacyEtag !== null) {
    const etag = await privacyEtagOf(ctx, ws);
    if (etag !== move.privacyEtag) {
      // A change elsewhere, or one the new name already has: nothing to carry, so the pages go on.
      const mirror = await readerMirror(ctx, ws);
      if (mirror === null || mirror.invalid || !stillCarried(mirror, move.from, move.to)) {
        return { state: "rules_changed", files: [], left: move.left };
      }
      await ctx.db.patch(id, { privacyEtag: etag });
    }
  }
  const rowsMode = (await accessSourceOf(ctx.db)) === "rows";
  // A restore comes out of the trash, which nobody sees; the caller judged it as a whole (`restoreTrashedPath`).
  const judged = underHiddenRoot(move.from) ? null : await rulesForReaders(ctx, ws);
  const clearance = clearanceOf(move.scope, move.grantedNames);
  const prefix = `${move.from}/`;
  const lower = move.cursor ?? prefix;

  const page: Doc<"nodes">[] = [];
  let scanned = 0;
  let ended = true;
  let cursor = move.cursor;
  const rows = ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws).gt("path", lower));
  for await (const row of rows) {
    if (!row.path.startsWith(prefix)) break;
    if (page.length >= ROW_MOVE_MAX || scanned >= PAGE_SCAN) {
      ended = false;
      break;
    }
    scanned += 1;
    cursor = row.path;
    if (row.goneAt === undefined) page.push(row);
  }

  const parents = new Map<string, Doc<"nodes"> | null>();
  const parentOf = async (row: Doc<"nodes">) => {
    if (row.parentId === undefined) return null;
    const key = row.parentId as string;
    if (!parents.has(key)) parents.set(key, await ctx.db.get(row.parentId));
    return parents.get(key) ?? null;
  };
  const files: { from: string; to: string }[] = [];
  let moved = 0;
  let left = move.left;
  let access = false;
  for (const row of page) {
    const destination = `${move.to}${row.path.slice(move.from.length)}`;
    const parent = await parentOf(row);
    // Its folder went ahead of it, so it follows; a folder left at the old name keeps what is in it.
    const parentMoved = parent !== null && within(parent.path, move.to);
    const seen = judged === null || canSee(row.path, clearance.scope, judged.rules, judged.overrides, clearance.names);
    const keyed = row.kind !== "file" || row.storageKey !== undefined;
    const there = parentMoved && seen && keyed ? await rowAt(ctx.db, ws, destination) : null;
    if (!parentMoved || !seen || !keyed || (there !== null && there.goneAt === undefined)) {
      left += 1;
      // Its folder moved without it: it stays at the old name, in a folder of that name.
      if (parentMoved) {
        const folder = await folderForLeft(ctx, ws, row.path.slice(0, row.path.lastIndexOf("/")), move.now, rowsMode);
        if (folder !== undefined) await ctx.db.patch(row._id, { parentId: folder });
      }
      continue;
    }
    if (there !== null) await removeReplaced(ctx, there);
    access = access || (await carriesAccess(ctx, row));
    await ctx.db.patch(row._id, { path: destination, observedAt: move.now });
    // A later row in this page whose parent is this one reads it moved.
    parents.set(row._id as string, { ...row, path: destination });
    moved += 1;
    if (row.kind === "file") files.push({ from: row.path, to: destination });
  }
  await followMovedFiles(ctx, ws, files, move.trash);

  const patch: Partial<Doc<"rowMoves">> = { moved: move.moved + moved, left, updatedAt: Date.now() };
  if (!ended) {
    patch.cursor = cursor;
  } else if (move.pass === 1) {
    // The first walk reached the end: a second walk from the start catches what arrived behind it, and counts
    // what is left afresh.
    patch.pass = 2;
    patch.cursor = undefined;
    patch.left = 0;
  } else {
    await ctx.db.patch(id, { ...patch, state: "moved", cursor: undefined });
    await retireEmptied(ctx, ws, move.oldParentId, move.now);
    await markWebsiteMoved(ctx, ws, { from: move.from, to: move.to });
    await freshenMeaningAfterActivity(ctx, ws);
    await refreshAccess(ctx, ws);
    return { state: "done", files, left };
  }
  await ctx.db.patch(id, patch);
  if (access) await refreshAccess(ctx, ws);
  return { state: "moving", files, left: patch.left ?? left };
}

/** The `rowMoves` row for a move of `from`, still moving or moved but not yet settled, if any. */
export async function rowMoveOf(db: DatabaseReader, workspaceId: Id<"workspaces">, from: string): Promise<Doc<"rowMoves"> | null> {
  const rows = await db
    .query("rowMoves")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MOVING_PER_WORKSPACE * 2);
  return rows.find((row) => row.from === from) ?? null;
}
