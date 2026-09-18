import type { PendingWrite } from "../../offline/outbox";

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
}

/** What a screen reader hears for a mark, and what a test looks for. */
export function describeSyncMark(mark: SyncMark): string {
  return mark === "conflict" ? "needs you" : "waiting to sync";
}

export const NO_PENDING: PendingMarks = {
  stateFor: () => null,
  queued: [],
  conflicted: [],
};

/**
 * Build the marks from a queue's writes.
 *
 * Takes the writes rather than an `Outbox` so a caller holding a different
 * shape of the same facts — a test, or a picture — does not have to invent a
 * workspace id to get a mark.
 */
export function pendingMarks(
  writes: readonly Pick<PendingWrite, "path" | "state" | "queuedAt">[],
): PendingMarks {
  if (writes.length === 0) return NO_PENDING;
  const byPath = new Map<string, SyncMark>();
  const ordered = [...writes].sort((a, b) => a.queuedAt - b.queuedAt);
  const queued: string[] = [];
  const conflicted: string[] = [];
  for (const write of ordered) {
    const mark: SyncMark = write.state === "pending" ? "queued" : "conflict";
    byPath.set(write.path, mark);
    (mark === "queued" ? queued : conflicted).push(write.path);
  }
  return {
    stateFor: (path) => byPath.get(path) ?? null,
    queued,
    conflicted,
  };
}
