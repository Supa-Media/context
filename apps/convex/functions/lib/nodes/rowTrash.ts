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
 * A folder with more live rows than `ROW_MOVE_MAX` is refused as too large, as a
 * row move of it is: there is no byte fallback, because the bytes it would move
 * are not the notes.
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
import { canSee } from "../privacy";
import { refusal } from "./rowMoveStart";
import { carryRowHistory } from "./rowHistory";

/** Trash destinations tried for one stamp before the trash is refused: the bucket's own bound. */
const TRASH_ATTEMPTS = 100;

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
  if (plan.kind === null) throw notFound();
  if (plan.tooLarge) throw refusal("too_large", path, true);
  if (plan.unkeyed) throw refusal("unkeyed", path, true);

  const state = await loadPrivacyState(store);
  if (state.invalid) throw new FileOpError("PRIVACY_MANIFEST_INVALID", "The privacy rules could not be read; the trash was not made.");
  if (!canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
  // A folder with something in it this caller cannot see cannot be trashed as one step: the row move takes all of it.
  if (plan.files.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names))) {
    throw new FileOpError("CONFLICT", "That folder cannot be moved to the trash in one step.");
  }

  const stamp = timestampSlug(now);
  const destination = (n: number) => `${TRASH_ROOT}/${n === 1 ? stamp : `${stamp}-${n}`}/${path}`;
  const attempt = (to: string) =>
    ctx.runMutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId,
      from: path,
      to,
      privacyEtag: null,
      plannedFiles: plan.files,
      now,
      trash: true,
      ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
    });
  let to = destination(1);
  let answer = await attempt(to);
  for (let n = 2; !answer.ok && answer.reason === "taken" && n <= TRASH_ATTEMPTS; n += 1) {
    to = destination(n);
    answer = await attempt(to);
  }
  if (!answer.ok) throw refusal(answer.reason, path, true);

  await carryRowHistory(store, plan.files.map((key) => ({ from: key, to: `${to}${key.slice(path.length)}` })));
  if (args.projection) await followInProjection(store, { written: [], gone: plan.files }, args.projection);
  return { from: path, to, paths: [to], queued: plan.files.length, rowed: true };
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
  if (plan.kind === null) throw notFound();
  if (plan.tooLarge) throw refusal("too_large", path, true);
  if (plan.unkeyed) throw refusal("unkeyed", path, true);
  const answer = await ctx.runMutation(internal.functions.nodeRowMoves.rowMove, {
    workspaceId,
    from: trash,
    to: path,
    privacyEtag: null,
    plannedFiles: plan.files,
    now,
    trash: true,
  });
  if (!answer.ok) throw refusal(answer.reason, path, true);
  await carryRowHistory(store, plan.files.map((key) => ({ from: key, to: `${path}${key.slice(trash.length)}` })));
}
