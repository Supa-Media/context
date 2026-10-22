/**
 * Moving or renaming a note or a folder inside one context.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import {
  type Visibility,
  canSee,
  effectiveVisibility,
  narrowerVisibility,
  nextOverrides,
  visibilityOf,
} from "../privacy";
import { type Clearance } from "../clearance";
import { KEYED_REFUSAL } from "../noteIds/keyedStore";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { pruneEmptyFolders } from "../../../../mcp/src/store/index.js";
import {
  eligible as collaborationEligible,
  moveDocument as moveCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import type { FileStore } from "./store";
import { assertNoNameTwin, assertNotProtectedFolder } from "./nameTwins";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { assertWritablePath } from "./writing";
import { objectBody } from "./objectBody";
import { keysUnder, isFolder } from "./walk";
import { fileInTree, filesInTree } from "./treeChecks";
import { assertMoveDestinationsVisible } from "./moveRules";
import { type ReferenceRewrite, rewriteReferences } from "./references";
import { mutateManifest, remapPrivacy } from "./privacyRewrite";
import { remapFolderIcons, remapIcons } from "@context/shared/src/folderIcons.cjs";

export interface MoveResult {
  from: string;
  to: string;
  /** Every key that moved. Paths, which are metadata — never content. */
  paths: string[];
  /** What the link rewrite did. See `rewriteReferences`. */
  references?: ReferenceRewrite;
  /**
   * The moved note's etag at its new path — a single note only, and only where
   * the bucket answered the write with one. See `movePath`.
   */
  etag?: string;
  /**
   * Set when the move was queued (a folder, phase 4 of the Convex tree): how
   * many files the tree now draws at `to` while the bucket catches up behind
   * it. `paths` is then just `to`.
   */
  queued?: number;
  /**
   * Set when a keyed workspace moved it as a row change (`nodes/rowMoveStart.ts`):
   * nothing was copied, and `queued` counts the files that moved.
   */
  rowed?: true;
  /** Set with `rowed`: each moved note's collaboration history already follows it (`nodes/rowHistory.ts`). */
  historyCarried?: true;
  /**
   * The files a keyed row move renamed, each at its old and new path, so the
   * gateway can carry their collaboration heads and state along
   * (`notes-by-id.md`). Metadata only; set with `rowed`.
   */
  moved?: { from: string; to: string }[];
}

/**
 * A move the tree draws at once, made as rows by the credential barrier
 * (`lib/nodes/moveBarrier.ts`, `rowMoveStart.ts`), or `null` where the barrier
 * did not attach it. Attached to the store non-enumerably, as the barrier's
 * other seams are.
 */
type QueueMove = (move: {
  from: string;
  to: string;
  clearance: Clearance;
  now: number;
  expectedEtag?: string;
}) => Promise<MoveResult | null>;

async function queuedMove(
  store: FileStore,
  move: { from: string; to: string; clearance: Clearance; now: number; expectedEtag?: string },
): Promise<MoveResult | null> {
  const queue = (store as { queueMove?: QueueMove }).queueMove;
  return typeof queue === "function" ? await queue(move) : null;
}

/**
 * Move or rename. A rename is a move whose parent does not change, so there is
 * one implementation rather than two that can disagree.
 *
 * Works on a file or a whole folder. The destination must not exist: this
 * never merges and never overwrites.
 *
 * The privacy manifest moves with it. That is the part it would be easy to
 * skip and expensive to get wrong — without it, dragging a private note into a
 * `team` folder silently shares it, because the exception that kept it private
 * still names a path that no longer exists.
 */
export async function movePath(
  store: FileStore,
  options: {
    from: string;
    to: string;
    clearance: Clearance;
    now: number;
    /**
     * The version of the note this move was asked about. Given, the move is
     * refused with `CONFLICT` and the current etag when the note is anywhere
     * else — the same answer a queued edit gets, for the same reason: a rename
     * typed offline is a decision about the note as it was then. Absent is an
     * online press made while looking at the listing, exactly as before.
     *
     * A note only: a folder has no version to name.
     */
    expectedEtag?: string;
    /**
     * Refuse, rather than read-compare, where the bucket cannot make the check
     * atomic. The plugin runtime asks for this — a plugin renames as part of a
     * transaction it cannot see the end of. A person's queued rename does not:
     * it gets the check an online save gets on the same bucket.
     */
    requireAtomic?: boolean;
  },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(from);
  assertWritablePath(to);
  if (from === to) return { from, to, paths: [] };
  await assertNotProtectedFolder(store, from, options.clearance, "move");
  if (to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be moved inside itself.");
  }
  // ...nor onto one of its own ancestors, which is a rename that flattens a
  // folder into a parent it is already inside. It also breaks the one thing
  // that makes the manifest repair below sound: a renamed rule normally lands
  // under the destination, where it cannot outrank a rule kept under the
  // source. When the destination IS an ancestor the two trees overlap, and a
  // renamed `.../b/b/hr/deep: team` came out longer than the `.../b/hr: private`
  // put back for a survivor, which published it.
  if (from.startsWith(`${to}/`)) {
    throw new FileOpError(
      "PATH_INVALID",
      "A folder cannot be moved onto a folder it is already inside.",
    );
  }

  // `projects` beside `Projects` is refused by name before anything moves.
  await assertNoNameTwin(store, to, options.clearance, "folder", from);

  // A move is made as rows (`rowMoveStart.ts`), even against a version. Nothing else moves a name: a store
  // the barrier did not attach a row move to, or a folder whose notes are not all keyed yet, is refused.
  const moved = await queuedMove(store, {
    from,
    to,
    clearance: options.clearance,
    now: options.now,
    ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
  });
  if (moved === null) throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
  return moved;
}
