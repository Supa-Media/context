/**
 * Trash and Restore in a keyed workspace as row changes (`rowMove.ts`).
 *
 * A keyed note's bytes sit at `notes/<noteId>.md`, so a trash that moved bytes
 * would move frozen path copies and leave the live note where it was. Instead
 * the note's row (or a folder's rows) move into `.context/trash/<stamp>/<path>`,
 * the same destination the queued byte trash names (`trashStart.ts`), and
 * Restore moves them back. Nothing is copied, deleted or queued, and no privacy
 * rule is written: the note keeps its rules at its own name for Restore, as a
 * trash made in one go does (`trashPath`).
 *
 * The collision rule matches the bytes': the stamp is the server's, and a
 * second trash in the same millisecond takes `<stamp>-2`, `<stamp>-3`, ... until
 * a free name is found.
 *
 * A folder with more live rows than `ROW_MOVE_MAX` goes in pages, as a row move
 * of it does (`rowMoveChunks.ts`): its root at once, so every listing drops it,
 * and the rows beneath behind it. Trashing it again while it is still going
 * carries the same trash on; a big Restore goes the same way.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { FileOpError, notFound } from "../fileOps/errors";
import type { MoveResult } from "../fileOps/moving";
import { timestampSlug } from "../fileOps/paths";
import { loadPrivacyState } from "../fileOps/privacyState";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import { TRASH_ROOT, type FileStore } from "../fileOps/store";
import { catchUpKeyedRows } from "./rowCatchUp";
import { canSee } from "../privacy";
import { refusal } from "./rowMoveStart";
import { carryRowHistory } from "./rowHistory";
import { driveRowMove, plannedFiles, recordedMove } from "./rowMoveDrive";
import { rowEtagFor } from "./handedVersion";

/** Trash destinations tried for one stamp before the trash is refused: the bucket's own bound. */
const TRASH_ATTEMPTS = 100;

type Pairs = { from: string; to: string }[];

/** The pages of a chunked trash or Restore, then its record goes: a trash has no bucket rules to settle. */
async function pagesOf(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  move: { id: Id<"rowMoves">; to: string; state: "moving" | "moved" },
  from: string,
): Promise<Pairs> {
  const driven = move.state === "moving" ? await driveRowMove(ctx, { workspaceId, id: move.id, from, to: move.to, store }) : { files: [] };
  await ctx.runMutation(internal.functions.nodeRowMoves.rowMoveSettled, { id: move.id });
  return driven.files;
}

/**
 * Move `path` (a note or a folder) into the trash as its rows, for a keyed
 * workspace. Throws what a row move refuses, and `notFound()` for a name the
 * caller cannot see, as `trashPath` does.
 */
export async function startRowTrash(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    store: FileStore;
    path: string;
    clearance: Clearance;
    now: number;
    projection?: ProjectionClient | null;
    /** The version the delete was asked about (an offline delete); the row move refuses `changed` if it moved on. */
    expectedEtag?: string;
  },
): Promise<MoveResult> {
  const { workspaceId, store, path, clearance, now } = args;
  const plan = await ctx.runQuery(internal.functions.nodeRowMoves.plan, { workspaceId, from: path });
  const recorded = await recordedMove(ctx, workspaceId, path, (move) => move.trash);
  if (recorded !== null && recorded.trash) {
    // Trashed again while its pages are still going: the same trash carries on, for whoever may see the name.
    const state = await loadPrivacyState(store);
    if (state.invalid || !canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
    const moves = await pagesOf(ctx, workspaceId, store, recorded, path);
    await carryRowHistory(store, moves);
    if (args.projection) await followInProjection(store, { written: [], gone: moves.map((pair) => pair.from) }, args.projection);
    return { from: path, to: recorded.to, paths: [recorded.to], queued: moves.length, rowed: true };
  }
  if (recorded !== null || (await ctx.runQuery(internal.functions.nodeRowMoves.rowMoveOverlaps, { workspaceId, from: path, to: path }))) {
    // "Something there is still moving" is itself something to know: said before the caller's clearance is
    // read, it tells a `team` caller that a private folder exists and is being moved, where a free name is
    // refused as not found. The name is judged first, and a caller who may not see it is told that instead.
    const judged = await loadPrivacyState(store);
    if (judged.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the trash was not made.");
    if (!canSee(path, clearance.scope, judged.rules, judged.overrides, clearance.names)) throw notFound();
    throw refusal("busy", path, true);
  }
  if (plan.kind === null) throw notFound();
  const planned = await plannedFiles(ctx, workspaceId, path, plan);
  if (planned.unkeyed) throw refusal("unkeyed", path, true);

  const state = await loadPrivacyState(store);
  if (state.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the trash was not made.");
  if (!canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
  // A folder with something in it this caller cannot see cannot be trashed as one step: the row move takes all of it.
  if (planned.files.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names))) {
    throw new FileOpError("CONFLICT", "That folder cannot be moved to the trash in one step.");
  }

  // The caller's version is the key's (`idLayout.js`); a row the key moved on from without telling it catches up first.
  // The caller's version as the row carries it (`handedVersion.ts`).
  const expectedEtag = await rowEtagFor(store, path, args.expectedEtag);
  await catchUpKeyedRows(ctx, workspaceId, store, [{ path, expectedEtag }]);
  const stamp = timestampSlug(now);
  const destination = (n: number) => `${TRASH_ROOT}/${n === 1 ? stamp : `${stamp}-${n}`}/${path}`;
  const attempt = (to: string) =>
    ctx.runMutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId,
      from: path,
      to,
      privacyEtag: null,
      ...(plan.tooLarge ? {} : { plannedFiles: planned.files }),
      chunk: { scope: clearance.scope, grantedNames: [...clearance.names] },
      now,
      trash: true,
      ...(expectedEtag === undefined ? {} : { expectedEtag }),
    });
  let to = destination(1);
  let answer = await attempt(to);
  for (let n = 2; !answer.ok && answer.reason === "taken" && n <= TRASH_ATTEMPTS; n += 1) {
    to = destination(n);
    answer = await attempt(to);
  }
  if (!answer.ok && answer.reason === "changed") {
    throw new FileOpError("CONFLICT", "That note changed somewhere else after this was asked for.", answer.currentEtag);
  }
  if (!answer.ok) throw refusal(answer.reason, path, true);

  const moves = answer.chunked === undefined
    ? planned.files.map((key) => ({ from: key, to: `${to}${key.slice(path.length)}` }))
    : await pagesOf(ctx, workspaceId, store, { id: answer.chunked, to, state: "moving" }, path);
  await carryRowHistory(store, moves);
  if (args.projection) await followInProjection(store, { written: [], gone: moves.map((pair) => pair.from) }, args.projection);
  return { from: path, to, paths: [to], queued: moves.length, rowed: true };
}

/**
 * Restore `trash` to `path` for a keyed workspace: the rows move back, and their
 * ids, bytes and links go with them. The caller has already checked that `path`
 * is the name the trash came from and that the caller may see it
 * (`restoreTrashedPath`). A name a live row holds is refused, as a move is.
 */
export async function restoreRowTrash(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; store: FileStore; trash: string; path: string; now: number },
): Promise<void> {
  const { workspaceId, store, trash, path, now } = args;
  const plan = await ctx.runQuery(internal.functions.nodeRowMoves.plan, { workspaceId, from: trash });
  const recorded = await recordedMove(ctx, workspaceId, trash, (move) => move.to === path);
  if (recorded !== null) {
    if (recorded.to !== path) throw refusal("busy", path, true);
    await carryRowHistory(store, await pagesOf(ctx, workspaceId, store, recorded, trash));
    return;
  }
  if (plan.kind === null) throw notFound();
  const planned = await plannedFiles(ctx, workspaceId, trash, plan);
  if (planned.unkeyed) throw refusal("unkeyed", path, true);
  const answer = await ctx.runMutation(internal.functions.nodeRowMoves.rowMove, {
    workspaceId,
    from: trash,
    to: path,
    privacyEtag: null,
    ...(plan.tooLarge ? {} : { plannedFiles: planned.files }),
    // The caller judged the trash as a whole; a page judges nothing that comes out of the trash.
    chunk: { scope: "private", grantedNames: [] },
    now,
    trash: true,
  });
  if (!answer.ok) throw refusal(answer.reason, path, true);
  const moves = answer.chunked === undefined
    ? planned.files.map((key) => ({ from: key, to: `${path}${key.slice(trash.length)}` }))
    : await pagesOf(ctx, workspaceId, store, { id: answer.chunked, to: path, state: "moving" }, trash);
  await carryRowHistory(store, moves);
}
