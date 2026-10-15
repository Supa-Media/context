/**
 * Moving to the trash as a queued move (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): Delete answers as soon as
 * the tree draws the note gone, and the bucket moves it into
 * `.context/trash/` behind, the way a queued folder move does.
 *
 * A trash is a move whose destination is hidden plumbing, so the one
 * `moveQueue` row is all every listing needs: the folded name is under
 * `.context/`, which no listing draws and `canSee` refuses at every scope.
 * What a trash made in one go (`trashPath`) never did, this does not do
 * either: no rules are carried (the note's rules stay at its name for
 * Restore), no links are rewritten, no forwarding is recorded, and pins stay
 * where they are. The worker (`moveWork.ts`) knows the row by its `trash`
 * flag and skips those steps at the finish.
 *
 * Restore while the move is still queued turns it around (`restoreQueued`),
 * and the tree draws the note back at once.
 *
 * Anything this cannot do at once answers `null`, and the caller trashes the
 * old way: a store that cannot move a note safely, a name another move still
 * holds, a folder with notes the caller cannot see, rules that do not parse.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { FileOpError, notFound } from "../fileOps/errors";
import type { MoveResult } from "../fileOps/moving";
import { timestampSlug } from "../fileOps/paths";
import { loadPrivacyState } from "../fileOps/privacyState";
import { TRASH_ROOT, type FileStore } from "../fileOps/store";
import { canSee } from "../privacy";
import { inventory, storeCanQueue } from "./moveStart";

/** How long Restore waits for a pass that holds the trash to let go. */
const RESTORE_WAIT_MS = 20_000;
const RESTORE_POLL_MS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Queue a trash of `path`, or answer `null` for "trash it the old way".
 * Throws `notFound()` for a name the caller cannot see, as `trashPath` does.
 */
export async function startQueuedTrash(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    store: FileStore;
    path: string;
    clearance: Clearance;
    now: number;
  },
): Promise<MoveResult | null> {
  const { workspaceId, store, path, clearance, now } = args;
  // Only where one object can move without losing an edit, and where the trash
  // can be restored again: `restoreTrashedPath` needs a guarded delete.
  if (!storeCanQueue(store) || store.capabilities?.conditionalDelete !== true) return null;
  // The stamp is the server's, to the millisecond; a second trash of the same name in that millisecond
  // shares the destination, `reserve` refuses it as overlapping, and it goes the old way.
  const to = `${TRASH_ROOT}/${timestampSlug(now)}/${path}`;
  const reserved = await ctx.runMutation(internal.functions.nodeMoves.reserve, {
    workspaceId,
    from: path,
    to,
    scope: clearance.scope,
    grantedNames: [...clearance.names],
    trash: true,
    now,
  });
  // Another move holds the name (the folder it sits in is still moving, say): the old way
  // reaches the note where the tree draws it, through the pending moves.
  if (!reserved.ok) return null;
  let drawn = false;
  try {
    const source = await inventory(ctx, workspaceId, path, reserved.moves);
    if (!source.folder && !source.file) return null;
    const state = await loadPrivacyState(store);
    if (state.invalid) return null;
    if (!canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();
    // Notes the caller cannot see stay where they are: the old way does that.
    if (source.files.some((key) => !canSee(key, clearance.scope, state.rules, state.overrides, clearance.names))) return null;
    drawn = await ctx.runMutation(internal.functions.nodeMoves.activate, {
      id: reserved.id,
      kind: source.folder ? "folder" : "file",
      total: source.folder ? source.files.length : 1,
      added: { folders: [], notes: [] },
      privacyEtag: null,
      now,
    });
    if (!drawn) return null;
    return { from: path, to, paths: [to], queued: source.folder ? source.files.length : 1 };
  } finally {
    if (!drawn) await ctx.runMutation(internal.functions.nodeMoves.release, { id: reserved.id }).catch(() => {});
  }
}

/**
 * Restore of `trash` to `path` while its trash is still queued: turn the move
 * around and answer `undone`, or `none` when nothing is queued for it and the
 * bucket holds the trash already. A pass carrying it right now is waited out
 * (one note takes a moment, and then it is either turned around or landed),
 * and so is a folder's trash carrying a note restored on its own; `landed`
 * says the bucket moved while this waited, so the moves the request began
 * with are out of date.
 */
export async function restoreQueuedTrash(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; trash: string; path: string; wait?: (ms: number) => Promise<void> },
): Promise<"undone" | "none" | "landed"> {
  const wait = args.wait ?? sleep;
  const until = Date.now() + RESTORE_WAIT_MS;
  let waited = false;
  for (;;) {
    const answer = await ctx.runMutation(internal.functions.nodeMoves.undoTrash, {
      workspaceId: args.workspaceId,
      trash: args.trash,
      path: args.path,
      now: Date.now(),
    });
    if (answer === "undone") return "undone";
    if (answer === "none") return waited ? "landed" : "none";
    if (Date.now() >= until) throw new FileOpError("CONFLICT", "That note is still moving to the trash. Try again in a moment.");
    waited = true;
    await wait(RESTORE_POLL_MS);
  }
}
