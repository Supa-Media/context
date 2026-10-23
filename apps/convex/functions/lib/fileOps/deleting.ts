/**
 * Trashing, restoring and permanently deleting (archiving is `archiving.ts`).
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 *
 * Every workspace is keyed (`notes-by-id`): a trash is a row move to hidden
 * plumbing (`rowTrash.ts`), restored by the same row move back, and a permanent
 * delete is refused until emptying the trash may retire a row (`trash.ts`).
 */

import { canSee } from "../privacy";
import { type Clearance } from "../clearance";
import { assertNotProtectedFolder } from "./nameTwins";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { assertWritablePath } from "./writing";
import { type MoveResult } from "./moving";
import { KEYED_REFUSAL } from "../noteIds/keyedStore";
import type { FileStore } from "./store";

/**
 * A permanent delete in a keyed workspace. It would retire the note's row and
 * key, and that is what emptying the trash may do, not an ordinary delete
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`). Nothing is removed.
 */
const KEYED_PERMANENT_REFUSAL =
  "Permanent delete is not available in a keyed workspace yet. Move it to the trash instead, which keeps it restorable. Nothing was changed.";

/* -------------------------------------------------------------------------- */
/*                            trashing and deleting                           */
/* -------------------------------------------------------------------------- */

/**
 * Restore of a trashed row move, turned round by the credential barrier
 * (`lib/nodes/moveBarrier.ts`, `restoreRowTrash`). Attached non-enumerably, as
 * `trashKeyedRows` is; a store without it is refused.
 */
type RestoreKeyedTrash = (restore: { trash: string; path: string }) => Promise<boolean>;

/**
 * Move a visible entry into hidden, recoverable trash without rewriting its
 * privacy rules or links. Keeping those rules at the original path makes Undo
 * restore the exact access state instead of guessing it from the trash folder.
 * The trash is a row move (`rowTrash.ts`) to the same destination, through the
 * barrier's seam (`trashKeyedRows`).
 */
export async function trashPath(
  store: FileStore,
  options: {
    path: string;
    clearance: Clearance;
    now: number;
    /**
     * The version this delete was asked about. A delete typed offline must not
     * put somebody's newer text in the trash without the person who asked for
     * it being told it changed; the row move checks it, after the visibility
     * check, so a note the caller cannot see is `notFound()`.
     */
    expectedEtag?: string;
  },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  await assertNotProtectedFolder(store, path, options.clearance, "remove");
  assertWritablePath(path);
  return await trashKeyedRows(store, {
    path,
    clearance: options.clearance,
    now: options.now,
    ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
  });
}

type TrashKeyedRows = (trash: {
  path: string;
  clearance: Clearance;
  now: number;
  expectedEtag?: string;
}) => Promise<MoveResult>;

/**
 * Trash a path as its rows in a keyed workspace (`lib/nodes/rowTrash.ts`): the
 * trash, and the operations that would otherwise delete a path permanently
 * (`removeNewFolder`, a plugin's delete, the contextual moves out). The rows
 * move to the trash and Restore brings them back, so nothing is lost. Only the
 * barrier attaches the seam (`lib/nodes/moveBarrier.ts`); a store without it
 * stays refused.
 */
export async function trashKeyedRows(
  store: FileStore,
  options: { path: string; clearance: Clearance; now: number; expectedEtag?: string },
): Promise<MoveResult> {
  const trash = (store as { trashKeyedRows?: TrashKeyedRows }).trashKeyedRows;
  if (typeof trash !== "function") throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
  return await trash(options);
}

/** Restore one trash result to the original path encoded inside its key. */
export async function restoreTrashedPath(
  store: FileStore,
  options: { from: string; to: string; clearance: Clearance },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(to);
  const match = /^\.context\/trash\/[^/]+\/(.+)$/.exec(from);
  if (match === null || match[1] !== to) {
    throw new FileOpError("PATH_INVALID", "That trash entry does not match this restore path.");
  }
  const state = await loadPrivacyState(store);
  if (!canSee(to, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
  const restore = (store as { restoreKeyedTrash?: RestoreKeyedTrash }).restoreKeyedTrash;
  if (typeof restore !== "function") throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
  await restore({ trash: from, path: to });
  return { from, to, paths: [to], queued: 1 };
}

/** The word a caller must send to delete something permanently. */
export const DELETE_CONFIRMATION = "permanently delete";

export interface DeleteResult {
  paths: string[];
}

/**
 * Delete permanently. Refused in every workspace: they are all keyed, and a
 * keyed row and its key are retired only by emptying the trash
 * (`lib/trash/`). Nothing is removed. `confirmation` must be the literal
 * `DELETE_CONFIRMATION`, so a truthy value a buggy caller passed cannot stand in.
 */
export async function deletePath(
  _store: FileStore,
  options: { path: string; confirmation: string; clearance: Clearance; expectedEtag?: string },
): Promise<DeleteResult> {
  if (options.confirmation !== DELETE_CONFIRMATION) {
    throw new FileOpError(
      "CONFIRMATION_REQUIRED",
      "Permanent deletion has to be confirmed explicitly. This cannot be undone — archive it instead if you might want it back.",
    );
  }
  requirePath(options.path);
  throw new FileOpError("KEYED_WORKSPACE", KEYED_PERMANENT_REFUSAL);
}
