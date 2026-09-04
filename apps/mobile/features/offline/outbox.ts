/**
 * The queue of writes that have not reached the bucket yet.
 *
 * A pure reducer, in the shape `editor.ts` already uses and for the same
 * reason: the interesting transitions here — typing more into a note whose
 * queued write has already been refused, a drain landing after the person has
 * moved on, an app restarted with three edits waiting — are exactly the ones
 * that cannot be tested inside a component and are trivial to test here.
 *
 * ## The rules this file exists to hold
 *
 * **One entry per note, and the last text wins.** Forty saves while offline are
 * one write when the connection comes back. A queue of forty revisions would be
 * forty round trips against the customer's bucket, thirty-nine chances for one
 * of them to conflict, and — where they have versioning on — forty noncurrent
 * versions they pay to store, for a result identical to sending the last one.
 *
 * **A conflicted entry is never retried on its own.** It is parked until a
 * person decides, and typing more does not un-park it — the same rule the
 * online editor already follows ("A conflict is not cleared by typing", see
 * `editorReducer`'s `edited` case). The draft is based on a version somebody
 * else has moved past, and sending it anyway is the silent clobber this whole
 * feature exists not to do.
 *
 * **Nothing here is ever dropped to save space.** The read cache is bounded and
 * disposable — it is a copy of what is in the bucket. This is not: it is the
 * only copy of something a person typed. It leaves only by being written to the
 * bucket, or by that person choosing to let it go.
 *
 * **`baseEtag: null` means "this note did not exist when I typed it", and it is
 * not a licence to overwrite.** The control plane refuses a write with no
 * `expectedEtag` against a key that exists — `writeFile` answers `CONFLICT`
 * with "A file already exists at that path." — so a note created offline that
 * somebody else created meanwhile arrives here as a conflict rather than as a
 * clobber. That is a property of the server, checked by
 * `__tests__/offlineSync.test.ts`, not an assumption made here.
 */

/** What a queued write is waiting on. */
export type PendingState =
  /** Waiting for a connection. Retried automatically. */
  | "pending"
  /** The note moved on before this landed. Waiting for a person. */
  | "conflicted"
  /** Refused for a reason retrying cannot fix. Waiting for a person. */
  | "rejected";

export interface PendingWrite {
  /** Bucket-relative, exactly as `writeNote` takes it. */
  path: string;
  text: string;
  /**
   * The etag this text was typed against, or `null` for a note that did not
   * exist. Passed to `writeNote` as `expectedEtag`; it is what makes the drain
   * a conflict-checked write rather than a blind one.
   */
  baseEtag: string | null;
  /** When the first still-unsent edit to this note was queued. */
  queuedAt: number;
  /** When the text last changed. */
  updatedAt: number;
  state: PendingState;
  /** Drain attempts that reached the server and were refused or failed. */
  attempts: number;
  /** Set in `conflicted`. `currentEtag` is absent when the note was deleted. */
  conflict?: { currentEtag?: string; message: string; noticedAt: number };
  /** Set in `rejected`. */
  rejection?: { code: string; message: string; noticedAt: number };
  /** The last transient failure, for the person who asks why it is still here. */
  lastError?: string;
}

export interface Outbox {
  /** Bumped when the shape changes; a record from another version is discarded. */
  version: 1;
  workspaceId: string;
  writes: PendingWrite[];
}

export const OUTBOX_VERSION = 1;

export function emptyOutbox(workspaceId: string): Outbox {
  return { version: OUTBOX_VERSION, workspaceId, writes: [] };
}

function replace(outbox: Outbox, path: string, next: PendingWrite | null): Outbox {
  const writes = outbox.writes.flatMap((write) =>
    write.path === path ? (next === null ? [] : [next]) : [write],
  );
  return { ...outbox, writes };
}

export function find(outbox: Outbox, path: string): PendingWrite | undefined {
  return outbox.writes.find((write) => write.path === path);
}

/**
 * Queue a save, or fold it into the one already waiting for this note.
 *
 * `queuedAt` is the *first* edit's time and survives superseding, because that
 * is the number the console shows ("queued 20 minutes ago") and it should
 * answer "how long has this been waiting", not "when did you last press a key".
 *
 * A `conflicted` or `rejected` entry keeps its state and its explanation. The
 * newer text is still taken — losing what somebody just typed because an older
 * version of it was refused would be the worst outcome available — but the
 * refusal stands until it is answered, so the drain does not pick this up and
 * send it into the same wall.
 */
export function enqueue(
  outbox: Outbox,
  save: { path: string; text: string; baseEtag: string | null; now: number },
): Outbox {
  const existing = find(outbox, save.path);
  if (existing === undefined) {
    return {
      ...outbox,
      writes: [
        ...outbox.writes,
        {
          path: save.path,
          text: save.text,
          baseEtag: save.baseEtag,
          queuedAt: save.now,
          updatedAt: save.now,
          state: "pending",
          attempts: 0,
        },
      ],
    };
  }

  return replace(outbox, save.path, {
    ...existing,
    text: save.text,
    updatedAt: save.now,
    /*
      The base etag is *not* advanced from the caller. Whatever this draft was
      first typed against is what the write must be checked against; taking a
      fresher etag from an editor that reloaded in the background is how a
      conflict turns into an overwrite without anybody deciding to.
    */
  });
}

/** The write landed. Nothing is left to say about this note. */
export function settle(outbox: Outbox, path: string): Outbox {
  return replace(outbox, path, null);
}

export function markConflict(
  outbox: Outbox,
  path: string,
  conflict: { currentEtag?: string; message: string; now: number },
): Outbox {
  const existing = find(outbox, path);
  if (existing === undefined) return outbox;
  return replace(outbox, path, {
    ...existing,
    state: "conflicted",
    attempts: existing.attempts + 1,
    conflict: {
      currentEtag: conflict.currentEtag,
      message: conflict.message,
      noticedAt: conflict.now,
    },
    rejection: undefined,
  });
}

export function markRejected(
  outbox: Outbox,
  path: string,
  rejection: { code: string; message: string; now: number },
): Outbox {
  const existing = find(outbox, path);
  if (existing === undefined) return outbox;
  return replace(outbox, path, {
    ...existing,
    state: "rejected",
    attempts: existing.attempts + 1,
    rejection: { code: rejection.code, message: rejection.message, noticedAt: rejection.now },
    conflict: undefined,
  });
}

/** A transient failure: still `pending`, still retried, but say what happened. */
export function markFailed(outbox: Outbox, path: string, message: string): Outbox {
  const existing = find(outbox, path);
  if (existing === undefined) return outbox;
  return replace(outbox, path, {
    ...existing,
    attempts: existing.attempts + 1,
    lastError: message,
  });
}

/**
 * "Theirs wins" — throw this draft away.
 *
 * The only operation in this file that destroys somebody's typing, and it is
 * reachable from exactly one place: a control the person pressed with the
 * conflict explained next to it.
 */
export function discard(outbox: Outbox, path: string): Outbox {
  return replace(outbox, path, null);
}

/**
 * "Mine wins" — send this draft over the version that is there now.
 *
 * Re-bases onto the etag the conflict reported, so the retry is still a
 * conditional write against a specific version rather than a blind put. What it
 * does NOT do is keep the version being replaced. Nothing here does any more —
 * that is object versioning's job at the provider, and it is the customer's to
 * enable — so "overwrite theirs" recovers only if they turned it on. The
 * conflict UI says so rather than promising a copy this product stopped making.
 *
 * A `rejected` entry cannot be forced this way — there is nothing to re-base
 * onto and the refusal was not about a version. `retry` is its route back.
 */
export function forceMine(outbox: Outbox, path: string): Outbox {
  const existing = find(outbox, path);
  if (existing === undefined || existing.state !== "conflicted") return outbox;
  return replace(outbox, path, {
    ...existing,
    state: "pending",
    baseEtag: existing.conflict?.currentEtag ?? existing.baseEtag,
    conflict: undefined,
  });
}

/** Put a rejected entry back in the queue, unchanged, at the person's request. */
export function retry(outbox: Outbox, path: string): Outbox {
  const existing = find(outbox, path);
  if (existing === undefined || existing.state !== "rejected") return outbox;
  return replace(outbox, path, { ...existing, state: "pending", rejection: undefined });
}

/** Everything the drain may send, oldest first. */
export function drainable(outbox: Outbox): PendingWrite[] {
  return outbox.writes
    .filter((write) => write.state === "pending")
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

export interface OutboxCounts {
  pending: number;
  conflicted: number;
  rejected: number;
}

export function counts(outbox: Outbox): OutboxCounts {
  return {
    pending: outbox.writes.filter((w) => w.state === "pending").length,
    conflicted: outbox.writes.filter((w) => w.state === "conflicted").length,
    rejected: outbox.writes.filter((w) => w.state === "rejected").length,
  };
}

/**
 * Read an outbox back off the store.
 *
 * Anything that is not exactly this version's shape comes back as an empty
 * outbox for that workspace rather than as a throw or a half-parsed record. The
 * loss is real and is the lesser one: a record we cannot read is a record we
 * cannot send, and crashing the console on launch over it helps nobody.
 * `version` is what makes that a decision rather than an accident.
 */
export function parseOutbox(raw: string | null, workspaceId: string): Outbox {
  if (raw === null) return emptyOutbox(workspaceId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyOutbox(workspaceId);
  }
  if (typeof parsed !== "object" || parsed === null) return emptyOutbox(workspaceId);
  const record = parsed as Partial<Outbox>;
  if (record.version !== OUTBOX_VERSION) return emptyOutbox(workspaceId);
  if (record.workspaceId !== workspaceId) return emptyOutbox(workspaceId);
  if (!Array.isArray(record.writes)) return emptyOutbox(workspaceId);

  const writes = record.writes.filter(isPendingWrite);
  return { version: OUTBOX_VERSION, workspaceId, writes };
}

function isPendingWrite(value: unknown): value is PendingWrite {
  if (typeof value !== "object" || value === null) return false;
  const write = value as Partial<PendingWrite>;
  return (
    typeof write.path === "string" &&
    write.path !== "" &&
    typeof write.text === "string" &&
    (write.baseEtag === null || typeof write.baseEtag === "string") &&
    typeof write.queuedAt === "number" &&
    typeof write.updatedAt === "number" &&
    typeof write.attempts === "number" &&
    (write.state === "pending" || write.state === "conflicted" || write.state === "rejected")
  );
}
