import type { PendingOp, PendingState, PendingWrite } from "../../offline/outbox";
import { baseName, displayName, displayPath, parentPath } from "./paths";

/**
 * Which notes in a listing have not reached the bucket, as one read-only value.
 *
 * The status strip has always *counted* them — "3 notes waiting to sync",
 * "2 notes need you" — and nothing on any list said which rows those were. A
 * count with no way to find the notes is the complaint `copy.ts` already makes
 * about a conflict count without names, and it is the same complaint about a
 * tree: somebody who has been editing on a train comes back to forty rows that
 * all look alike and three of them are not in their bucket.
 *
 * ## Why a selector and not the queue
 *
 * The tree, the folder page and the Recent sheet are drawing components, and
 * each of them needs one fact per row: is this path waiting, is it stuck, or
 * neither. Handing them the outbox would teach three components the queue's
 * shape — its three states, which of them "needs you", that `rejected` counts
 * with `conflicted` — and three copies of that rule is how one of them comes to
 * mark a refused write as merely waiting. So the rule is here, once, and the
 * components ask `stateFor(path)`.
 *
 * ## Which queue it is built from
 *
 * The queue is per context, keyed by workspace id (`outbox.ts`), and every list
 * this feeds shows exactly one context: the tree and the folder page are the
 * open context's, and the Recent sheet is cleared on a context switch
 * (`clearedHistory`). So a list is marked from the queue *of the context it is
 * showing* — the live one `useOfflineNotes` holds — and never from another
 * context's, where the same `1-projects/plan.md` is a different note.
 *
 * Read-only by construction: it copies the paths out and holds no reference to
 * the queue, so nothing that draws a mark can reach a write.
 */

/**
 * `queued` — a write is waiting for a connection and will go on its own.
 * `conflict` — a write is parked and waiting for a person.
 *
 * `conflict` covers a `rejected` write too, and that is not loose naming: the
 * strip counts `conflicted + rejected` together as "need you" (`queueLine`),
 * because they share the only property a mark on a row can carry — nothing
 * will happen until somebody opens this note. Opening it is also how either one
 * is answered (`useFileBrowser`'s `open` restores both).
 */
export type SyncMark = "queued" | "conflict";

export interface PendingMarks {
  /** The mark for one path, or `null` for a note that is in the bucket. */
  stateFor: (path: string) => SyncMark | null;
  /** Waiting for a connection, oldest first — the order the drain sends them. */
  queued: readonly string[];
  /** Waiting for a person, oldest first. */
  conflicted: readonly string[];
  /**
   * What a row should be called when "the note at this path" is not the whole
   * story — "New note: Groceries" for a note that exists only on this device.
   * `null` for an ordinary edit, whose row is just the note.
   */
  labelFor?: (path: string) => string | null;
  /** The renames, moves, deletes and new folders waiting — see `OpRow`. */
  operations?: readonly OpRow[];
}

/**
 * One queued operation, as the sync sheet lists it.
 *
 * `text` is plain language — "Rename plan → plan-2026", "Delete old-notes",
 * "New folder: Trips" — and the sheet adds "waiting to sync" or "needs you"
 * from `mark`. `open` is where pressing the row goes (the renamed note, the new
 * folder), absent for a delete: there is nothing to open, and the row's
 * answers are the only thing to do with it.
 */
export interface OpRow {
  id: string;
  text: string;
  mark: SyncMark;
  /** Why it is parked, in the server's own words. */
  detail?: string;
  open?: string;
  /**
   * What a person may answer. `override` — do it anyway, against the version
   * the conflict reported; `retry` — send a refusal again unchanged;
   * `discard` — take it back. A waiting op offers nothing: it is going on
   * its own, and the undo was offered when it was pressed.
   */
  answers: readonly ("override" | "retry" | "discard")[];
}

/** What a screen reader hears for a mark, and what a test looks for. */
export function describeSyncMark(mark: SyncMark): string {
  return mark === "conflict" ? "needs you" : "waiting to sync";
}

export const NO_PENDING: PendingMarks = {
  stateFor: () => null,
  queued: [],
  conflicted: [],
  labelFor: () => null,
  operations: [],
};

/**
 * Build the marks from a queue's writes, and its ops.
 *
 * Takes the writes rather than an `Outbox` so a caller holding a different
 * shape of the same facts — a test, or a picture — does not have to invent a
 * workspace id to get a mark.
 *
 * An op marks the row it left behind: a renamed or moved note at its new
 * name, a new folder at itself. A deleted or archived note has no row to mark
 * — the tree has already taken it out — so it is only in `operations`, which
 * is where the sheet lists it. An edit of a note this device renamed is filed
 * under the bucket's name for it and marked on the row the person sees.
 */
export function pendingMarks(
  writes: readonly Pick<PendingWrite, "path" | "state" | "queuedAt">[],
  queue: {
    ops?: readonly PendingOp[];
    /** Where the console shows a bucket path — `localPathOf`. */
    localPathOf?: (path: string) => string;
    /** Bucket paths of notes that exist only on this device. */
    creates?: ReadonlySet<string>;
  } = {},
): PendingMarks {
  const ops = queue.ops ?? [];
  if (writes.length === 0 && ops.length === 0) return NO_PENDING;
  const local = queue.localPathOf ?? ((path: string) => path);
  const byPath = new Map<string, SyncMark>();
  const mark = (path: string, next: SyncMark) => {
    // The louder one wins: a note whose edit is waiting and whose rename is
    // parked needs somebody.
    if (byPath.get(path) === "conflict") return;
    byPath.set(path, next);
  };
  const ordered = [...writes].sort((a, b) => a.queuedAt - b.queuedAt);
  const queued: string[] = [];
  const conflicted: string[] = [];
  const created = new Set<string>();
  for (const write of ordered) {
    const path = local(write.path);
    const state = markOf(write.state);
    mark(path, state);
    (state === "queued" ? queued : conflicted).push(path);
    if (queue.creates?.has(write.path) === true) created.add(path);
  }
  const operations: OpRow[] = [];
  for (const op of [...ops].sort((a, b) => a.queuedAt - b.queuedAt)) {
    const state = markOf(op.state);
    const shown = op.kind === "move" ? op.to : op.kind === "folder" ? op.path : undefined;
    if (shown !== undefined) mark(shown, state);
    const why = op.state === "conflicted" ? op.conflict?.message : op.state === "rejected" ? op.rejection?.message : undefined;
    operations.push({
      id: op.id,
      text: describeOp(op),
      mark: state,
      ...(why === undefined ? {} : { detail: why }),
      ...(shown === undefined ? {} : { open: shown }),
      answers:
        op.state === "conflicted"
          ? op.conflict?.currentEtag === undefined
            ? ["discard"]
            : ["override", "discard"]
          : op.state === "rejected"
            ? ["retry", "discard"]
            : [],
    });
  }
  return {
    stateFor: (path) => byPath.get(path) ?? null,
    queued,
    conflicted,
    labelFor: (path) => (created.has(path) ? `New note: ${displayName(baseName(path))}` : null),
    operations,
  };
}

function markOf(state: PendingState): SyncMark {
  return state === "pending" ? "queued" : "conflict";
}

/**
 * An op in the words somebody would use for it.
 *
 * Rename when only the name changed, Move when only the folder did, and the
 * whole destination when both did. Names are drawn as the tree draws them —
 * sort numbers and `.md` dropped — because this is a sentence about rows the
 * person just saw, not a path they typed.
 */
export function describeOp(op: Pick<PendingOp, "kind" | "path" | "to">): string {
  const name = displayName(baseName(op.path));
  switch (op.kind) {
    case "folder":
      return `New folder: ${name}`;
    case "trash":
      return `Delete ${name}`;
    case "archive":
      return `Archive ${name}`;
    case "move": {
      const to = op.to ?? op.path;
      if (parentPath(op.path) === parentPath(to)) return `Rename ${name} → ${displayName(baseName(to))}`;
      if (baseName(op.path) === baseName(to)) {
        const folder = parentPath(to) === "" ? "the root of your context" : displayPath(parentPath(to));
        return `Move ${name} → ${folder}`;
      }
      return `Move ${name} → ${displayPath(parentPath(to))}/${displayName(baseName(to))}`;
    }
  }
}
