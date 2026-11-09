import type { OpKind, Outbox, PendingOp } from "./outbox";

/**
 * Where things are, in a queue that has renamed, moved and removed them: the
 * bucket's name for what this device shows, and the other way round. Moved
 * out of `outbox.ts` when folders joined the queue (owner, 2026-11-09:
 * "every action works offline: … folders, moving, renaming, deleting").
 *
 * ## Folders, and why they go last
 *
 * A note's op carries the note's version and is independent of every other
 * note. A folder's is not: moving `garden` moves every note in it, and a note
 * edited, created or renamed inside it is a note whose bucket name the folder
 * move changes. So the queue keeps one rule for them: **a folder op is sent
 * after everything else queued inside it, and everything queued inside a
 * moved folder is kept under the folder's old name** — the name the bucket
 * still has while those edits are sent. The folder move then carries them
 * with it. Drawn on screen, they are where the person put them
 * (`localPathOf`); queued, they are where the bucket will have them when they
 * are sent (`serverPathOf`).
 *
 * That holds only while folder ops do not nest, so they may not: a folder op
 * inside, around or onto another one waits for it to be sent (`folderOpBlocked`).
 * Renaming a folder twice is one rename, and deleting a renamed one deletes
 * the original, as notes already do.
 */

export const FOLDER_OP_KINDS: ReadonlySet<OpKind> = new Set<OpKind>(["folderMove", "folderTrash", "folderArchive"]);

/** A move, delete or archive of a whole folder. A new folder (`folder`) is not one: it moves nothing. */
export function isFolderOp(op: Pick<PendingOp, "kind">): boolean {
  return FOLDER_OP_KINDS.has(op.kind);
}

/** `path` is `folder`, or somewhere inside it. */
export function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function opsIn(outbox: Outbox): PendingOp[] {
  return outbox.ops ?? [];
}

function folderOps(outbox: Outbox): PendingOp[] {
  return opsIn(outbox).filter(isFolderOp);
}

/** A shown path, through any folder move that put it there, to the folder's old name. */
export function beforeFolderMoves(outbox: Outbox, shown: string): string {
  for (const op of folderOps(outbox)) {
    if (op.kind === "folderMove" && op.to !== undefined && within(shown, op.to)) {
      return op.path + shown.slice(op.to.length);
    }
  }
  return shown;
}

/** A queued path, through any folder move still to be sent, to where it is shown. */
export function afterFolderMoves(outbox: Outbox, queued: string): string {
  for (const op of folderOps(outbox)) {
    if (op.kind === "folderMove" && op.to !== undefined && within(queued, op.path)) {
      return op.to + queued.slice(op.path.length);
    }
  }
  return queued;
}

/**
 * Where a note is in the bucket while this device has renamed it.
 *
 * Followed through a chain — `a` renamed to `b` and then to `c` while the first
 * was still in flight is two moves, and the bucket has `a` until both land. An
 * edit typed into `c` is an edit of the bucket's `a`, and is queued there: the
 * drain sends the edit, then the rename, which carries the text with it. Sent
 * the other way round, the edit would be a write to a path the bucket has not
 * heard of. A folder moved on this device is undone first: its notes are
 * queued under its old name (see the file comment).
 */
export function serverPathOf(outbox: Outbox, local: string): string {
  let path = beforeFolderMoves(outbox, local);
  const ops = opsIn(outbox);
  for (let guard = 0; guard <= ops.length; guard += 1) {
    const move = ops.find((op) => op.kind === "move" && op.to === path);
    if (move === undefined) return path;
    path = move.path;
  }
  return path;
}

/** The inverse: where this device shows a bucket path it has renamed. */
export function localPathOf(outbox: Outbox, server: string): string {
  let path = server;
  const ops = opsIn(outbox);
  for (let guard = 0; guard <= ops.length; guard += 1) {
    const move = ops.find((op) => op.kind === "move" && op.path === path);
    if (move === undefined || move.to === undefined) break;
    path = move.to;
  }
  return afterFolderMoves(outbox, path);
}

/**
 * Every path this queue has a claim on: what it will write, and every end of
 * every op.
 *
 * **A claimed path is not free to be reused as a *different* note until the
 * queue has drained**, and that one rule is what lets the drain treat each
 * note as independent of every other. Delete `plan` and make a new `plan`
 * offline, and the order becomes load-bearing across two notes — the create
 * sent first is a conflict with the note the delete had not removed yet. So
 * the console refuses the second `plan` with a sentence instead, which is rare
 * and says exactly what to do.
 */
export function claimedPaths(outbox: Outbox): Set<string> {
  const paths = new Set<string>();
  for (const write of outbox.writes) paths.add(write.path);
  for (const op of opsIn(outbox)) {
    paths.add(op.path);
    if (op.to !== undefined) paths.add(op.to);
  }
  return paths;
}

/** Anything in the queue at `folder` or inside it, on either end, other than `except`. */
export function claimsWithin(outbox: Outbox, folder: string, except?: string): boolean {
  if (outbox.writes.some((write) => within(write.path, folder))) return true;
  return opsIn(outbox).some(
    (op) => op.id !== except && (within(op.path, folder) || (op.to !== undefined && within(op.to, folder))),
  );
}

/**
 * Whether a folder op at `path` (to `to`) would nest with one already queued:
 * inside it, around it, or onto either end of it. `except` is the op being
 * replaced, when this is a second rename of the same folder.
 */
export function folderOpBlocked(outbox: Outbox, path: string, to: string | undefined, except?: string): boolean {
  const ends = to === undefined ? [path] : [path, to];
  return folderOps(outbox).some((op) => {
    if (op.id === except) return false;
    const theirs = op.to === undefined ? [op.path] : [op.path, op.to];
    return ends.some((mine) => theirs.some((other) => within(mine, other) || within(other, mine)));
  });
}

/**
 * Whether anything the console does to `local` has to go through this queue
 * rather than straight to the bucket — even online.
 *
 * A note created on this device, or renamed on it, is not at that path in the
 * bucket yet; an online `moveEntry` of it is a refusal about a file that does
 * not exist. And a note with an op waiting (or parked) on it has an order to
 * keep. Plain queued *edits* are not claims: those notes are in the bucket
 * where the console says they are, which is how an online save of a note with
 * a parked write has always worked. A folder with anything queued inside it
 * has an order too: moved online first, the edits waiting inside it would
 * then be sent to a folder that is no longer there.
 */
export function routesThroughQueue(outbox: Outbox, local: string, folder = false): boolean {
  const server = serverPathOf(outbox, local);
  if (server !== local) return true;
  if (folder) return claimsWithin(outbox, server) || folderOpBlocked(outbox, server, undefined);
  if (opsIn(outbox).some((op) => op.path === server)) return true;
  return outbox.writes.find((write) => write.path === server)?.baseEtag === null;
}

/**
 * Whether a folder op must wait: something queued inside the folder has not
 * reached the bucket yet, in any state. A parked edit inside a folder holds
 * the folder's move, because sent past it, the edit would come back to a
 * name the bucket no longer has.
 */
export function folderOpWaits(outbox: Outbox, op: PendingOp): boolean {
  return claimsWithin(outbox, op.path, op.id);
}
