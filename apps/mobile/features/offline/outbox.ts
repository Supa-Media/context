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

/**
 * The operations the queue can hold besides an edit.
 *
 * `move` is both a rename and a move — the server's `moveEntry` is one action
 * for both, and so is this; the words differ only on screen (`describeOp`).
 * `trash` is the console's Delete, which is recoverable. There is no
 * permanent delete in here, and there should not be: a queued, unconditional,
 * unrecoverable operation typed on a train and sent hours later is the one
 * thing no offline layer should ever do on somebody's behalf.
 */
export type OpKind = "move" | "archive" | "trash" | "folder";

/**
 * A rename, move, archive, delete or new folder that has not reached the
 * bucket yet.
 *
 * Kept beside the edits rather than folded into them, because an edit is text
 * and these are not — and because the edit queue's one-entry-per-path rule is
 * load-bearing for everything that reads `writes` (the marks, the restore, the
 * merge's ancestor holds), which a second kind of entry under the same key
 * would quietly break.
 *
 * **It carries the version it was asked about, and the drain sends that
 * version** — `moveEntry`, `archiveEntry` and `trashEntry` all take the
 * `expectedEtag` and refuse with `CONFLICT` when the note moved on, the same
 * answer an edit gets. A rename typed on a train is a decision about the note
 * as it was on the train. The rule `enqueue` follows holds here too: nothing
 * but this queue's *own* landings ever moves `baseEtag` (`rebaseOp`), never a
 * fresher read.
 */
export interface PendingOp {
  /** A local handle for the controls that answer this op. Never sent. */
  id: string;
  kind: OpKind;
  /**
   * The bucket path acted on — the note as the bucket knows it, or the folder
   * to make. For a note this device has already renamed, that is the *old*
   * name: the bucket has not heard of the new one yet.
   */
  path: string;
  /** `move` only: where it goes. */
  to?: string;
  /**
   * The note's version when this was asked. `null` for a folder (a folder has
   * none), and for a note whose version this queue has yet to produce — a note
   * created offline and then renamed while the create was being sent, or a
   * rename of a rename that is still in flight. Such an op is never sent while
   * it is `null`: the landing ahead of it supplies the version
   * (`rebaseOp`), and until one does it waits. **An op on a note is never sent
   * without a version**, which is this queue's form of "no force flag".
   */
  baseEtag: string | null;
  queuedAt: number;
  updatedAt: number;
  state: PendingState;
  attempts: number;
  conflict?: { currentEtag?: string; message: string; noticedAt: number };
  rejection?: { code: string; message: string; noticedAt: number };
  lastError?: string;
}

export interface Outbox {
  /** Bumped when the shape changes; a record from another version is discarded. */
  version: 1;
  workspaceId: string;
  writes: PendingWrite[];
  /**
   * Renames, moves, archives, deletes and new folders — see `PendingOp`.
   *
   * Optional, and the version was deliberately **not** bumped for it. A record
   * from another version is discarded whole (`parseOutbox`), so bumping it
   * would make the first launch of this build throw away every edit queued by
   * the last one — the loss this file exists to prevent. An absent `ops` reads
   * as none. The cost runs the other way and is smaller: an older build that
   * rewrites this record drops the ops and keeps the edits.
   */
  ops?: PendingOp[];
}

export const OUTBOX_VERSION = 1;

export function emptyOutbox(workspaceId: string): Outbox {
  return { version: OUTBOX_VERSION, workspaceId, writes: [], ops: [] };
}

/** The ops in a queue, reading an absent list — a record from before them — as none. */
export function opsOf(outbox: Outbox): PendingOp[] {
  return outbox.ops ?? [];
}

/** Whether there is anything at all in this queue. */
export function isEmpty(outbox: Outbox): boolean {
  return outbox.writes.length === 0 && opsOf(outbox).length === 0;
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
  const existing = find(outbox, path);
  const next = replace(outbox, path, null);
  if (existing?.baseEtag !== null) return next;
  /*
    A note created on this device and let go of: whatever was queued to happen
    *to* it — an archive, a rename sent behind the create — was waiting on the
    create for its version and can now never have one. Left behind, it would
    sit in the queue forever describing a note that was never made.
  */
  return withOps(
    next,
    opsOf(next).filter((op) => !(op.path === path && op.baseEtag === null && op.kind !== "folder")),
  );
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

/**
 * Everything waiting, edits and operations together.
 *
 * One count rather than two because every place that reads it asks one
 * question — is anything on this device that is not in the bucket? — and the
 * sign-out warning above all: a rename waiting to sync is thrown away by
 * sign-out exactly as an edit is.
 */
export function counts(outbox: Outbox): OutboxCounts {
  const all: { state: PendingState }[] = [...outbox.writes, ...opsOf(outbox)];
  return {
    pending: all.filter((w) => w.state === "pending").length,
    conflicted: all.filter((w) => w.state === "conflicted").length,
    rejected: all.filter((w) => w.state === "rejected").length,
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
  const ops = Array.isArray(record.ops) ? record.ops.filter(isPendingOp) : [];
  return { version: OUTBOX_VERSION, workspaceId, writes, ops };
}

function isPendingOp(value: unknown): value is PendingOp {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Partial<PendingOp>;
  return (
    typeof op.id === "string" &&
    (op.kind === "move" || op.kind === "archive" || op.kind === "trash" || op.kind === "folder") &&
    typeof op.path === "string" &&
    op.path !== "" &&
    (op.kind !== "move" || (typeof op.to === "string" && op.to !== "")) &&
    (op.baseEtag === null || typeof op.baseEtag === "string") &&
    typeof op.queuedAt === "number" &&
    typeof op.updatedAt === "number" &&
    typeof op.attempts === "number" &&
    (op.state === "pending" || op.state === "conflicted" || op.state === "rejected")
  );
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

/* ------------------------------------------------------------------------ */
/*                  renames, moves, archives, deletes, folders               */
/* ------------------------------------------------------------------------ */

function withOps(outbox: Outbox, ops: PendingOp[]): Outbox {
  return { ...outbox, ops };
}

export function findOp(outbox: Outbox, id: string): PendingOp | undefined {
  return opsOf(outbox).find((op) => op.id === id);
}

/** The op acting on a bucket path. There is at most one — see `queueMove`. */
export function opOn(outbox: Outbox, path: string): PendingOp | undefined {
  return opsOf(outbox).find((op) => op.path === path);
}

function replaceOp(outbox: Outbox, id: string, next: PendingOp | null): Outbox {
  return withOps(
    outbox,
    opsOf(outbox).flatMap((op) => (op.id === id ? (next === null ? [] : [next]) : [op])),
  );
}

/**
 * When a new op is stamped: now, or just after the newest thing in the queue.
 *
 * The drain sends in `queuedAt` order and a rename of a rename depends on the
 * first reaching the bucket first. Two presses inside one millisecond — a
 * script, a test, a fast double-tap — would otherwise tie, and a tie sorts
 * whichever way the engine likes.
 */
function stamp(outbox: Outbox, now: number): number {
  let latest = -Infinity;
  for (const entry of [...outbox.writes, ...opsOf(outbox)]) latest = Math.max(latest, entry.queuedAt);
  return Math.max(now, latest + 1);
}

/**
 * Where a note is in the bucket while this device has renamed it.
 *
 * Followed through a chain — `a` renamed to `b` and then to `c` while the first
 * was still in flight is two moves, and the bucket has `a` until both land. An
 * edit typed into `c` is an edit of the bucket's `a`, and is queued there: the
 * drain sends the edit, then the rename, which carries the text with it. Sent
 * the other way round, the edit would be a write to a path the bucket has not
 * heard of.
 */
export function serverPathOf(outbox: Outbox, local: string): string {
  let path = local;
  const ops = opsOf(outbox);
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
  const ops = opsOf(outbox);
  for (let guard = 0; guard <= ops.length; guard += 1) {
    const move = ops.find((op) => op.kind === "move" && op.path === path);
    if (move === undefined || move.to === undefined) return path;
    path = move.to;
  }
  return path;
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
  for (const op of opsOf(outbox)) {
    paths.add(op.path);
    if (op.to !== undefined) paths.add(op.to);
  }
  return paths;
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
 * a parked write has always worked.
 */
export function routesThroughQueue(outbox: Outbox, local: string): boolean {
  const server = serverPathOf(outbox, local);
  if (server !== local) return true;
  if (opOn(outbox, server) !== undefined) return true;
  return find(outbox, server)?.baseEtag === null;
}

function newOp(
  outbox: Outbox,
  fields: { id: string; kind: OpKind; path: string; to?: string; baseEtag: string | null },
  now: number,
): PendingOp {
  const queuedAt = stamp(outbox, now);
  return {
    id: fields.id,
    kind: fields.kind,
    path: fields.path,
    ...(fields.to === undefined ? {} : { to: fields.to }),
    baseEtag: fields.baseEtag,
    queuedAt,
    updatedAt: queuedAt,
    state: "pending",
    attempts: 0,
  };
}

export interface QueueOpInput {
  id: string;
  /** The path as this device shows it. */
  path: string;
  /**
   * The note's version as this device has it — the open editor's, or the
   * mirror's. Ignored where the queue already has a version for the note (a
   * queued edit, or a create), because that is the version the op must follow.
   */
  etag: string | null;
  now: number;
  /**
   * Whether entries already in the queue may be rewritten — `false` while a
   * drain is running.
   *
   * Coalescing edits entries in place: a create renamed before it is sent is
   * a create at the new name. If that create is on the wire when the rename
   * arrives, rewriting it produces two notes — the one the drain made at the
   * old name, and a second create at the new one. So during a drain an op is
   * queued *behind* whatever it would have folded into, with no version of its
   * own, and the landing ahead of it supplies one. More round trips, the same
   * result, and nothing to reconcile.
   */
  coalesce: boolean;
}

/**
 * Rename or move a note.
 *
 * Three cases, in the order they are tried:
 *
 *  - **It is already being renamed by this queue.** The pending move is
 *    re-pointed — `a → b` then `b → c` is `a → c`, one round trip — and renamed
 *    back to where it started, it is simply gone.
 *  - **It is a note this device created and has not sent.** The create moves
 *    to the new name. Nothing about the old name ever reaches the bucket.
 *    A create parked on a conflict is put back in the queue by this, and that
 *    is a person's answer rather than an automatic retry: "a file appeared at
 *    that name, so call mine something else" is exactly what a rename is.
 *  - **Otherwise** a move, carrying the version it was asked about — the
 *    queued edit's own base if the note has one, since the drain sends that
 *    edit first and moves the op onto what it produced.
 *
 * `null` when the move cannot be queued: the destination is claimed, or the
 * note has no version this device knows. The console says why before it gets
 * here; this is the backstop.
 */
export function queueMove(outbox: Outbox, input: QueueOpInput & { to: string }): Outbox | null {
  const { path: from, to } = input;
  if (from === to) return outbox;
  // Renaming back to where it started is the one claimed destination allowed,
  // and only when it can fold into the rename it undoes — queued behind one in
  // flight it would be a cycle, `a → b → a`, with nothing to anchor either end.
  if (claimedPaths(outbox).has(to) && !(input.coalesce && serverPathOf(outbox, from) === to)) {
    return null;
  }

  const earlier = opsOf(outbox).find((op) => op.kind === "move" && op.to === from);
  if (earlier !== undefined && input.coalesce) {
    if (to === earlier.path) return replaceOp(outbox, earlier.id, null);
    return replaceOp(outbox, earlier.id, { ...earlier, to, updatedAt: input.now });
  }
  if (earlier !== undefined) {
    // Behind the rename in flight, and versionless until it lands.
    if (opOn(outbox, from) !== undefined) return null;
    return withOps(outbox, [
      ...opsOf(outbox),
      newOp(outbox, { id: input.id, kind: "move", path: from, to, baseEtag: null }, input.now),
    ]);
  }

  if (opOn(outbox, from) !== undefined) return null;
  const write = find(outbox, from);
  if (write !== undefined && write.baseEtag === null && input.coalesce) {
    return {
      ...replace(outbox, from, {
        ...write,
        path: to,
        state: "pending",
        attempts: 0,
        conflict: undefined,
        rejection: undefined,
        lastError: undefined,
        updatedAt: input.now,
      }),
    };
  }
  const baseEtag = write !== undefined ? write.baseEtag : input.etag;
  if (baseEtag === null && write === undefined) return null;
  return withOps(outbox, [
    ...opsOf(outbox),
    newOp(outbox, { id: input.id, kind: "move", path: from, to, baseEtag }, input.now),
  ]);
}

/**
 * Delete (to the trash) or archive a note.
 *
 *  - **Being renamed by this queue:** the rename is replaced by the removal of
 *    the original. Renaming something and then deleting it is deleting it.
 *  - **Created on this device and not sent, and deleted:** the create is
 *    dropped and nothing is sent. It is handed back as `dropped`, so the
 *    console can offer to undo it — this is the one op that removes typing,
 *    and it removes it because the person pressed Delete on it.
 *  - **Created and archived:** queued behind the create. An archive keeps a
 *    note, so the note has to exist first.
 *  - **Otherwise** the removal, carrying the version it was asked about.
 */
export function queueRemoval(
  outbox: Outbox,
  input: QueueOpInput & { kind: "trash" | "archive" },
): { outbox: Outbox; dropped?: PendingWrite } | null {
  const { path } = input;
  const earlier = opsOf(outbox).find((op) => op.kind === "move" && op.to === path);
  if (earlier !== undefined && input.coalesce) {
    return {
      outbox: replaceOp(outbox, earlier.id, {
        ...earlier,
        kind: input.kind,
        to: undefined,
        state: "pending",
        conflict: undefined,
        rejection: undefined,
        updatedAt: input.now,
      }),
    };
  }
  if (earlier !== undefined) {
    if (opOn(outbox, path) !== undefined) return null;
    return {
      outbox: withOps(outbox, [
        ...opsOf(outbox),
        newOp(outbox, { id: input.id, kind: input.kind, path, baseEtag: null }, input.now),
      ]),
    };
  }

  if (opOn(outbox, path) !== undefined) return null;
  const write = find(outbox, path);
  if (write !== undefined && write.baseEtag === null && input.kind === "trash" && input.coalesce) {
    return { outbox: replace(outbox, path, null), dropped: write };
  }
  const baseEtag = write !== undefined ? write.baseEtag : input.etag;
  if (baseEtag === null && write === undefined) return null;
  return {
    outbox: withOps(outbox, [
      ...opsOf(outbox),
      newOp(outbox, { id: input.id, kind: input.kind, path, baseEtag }, input.now),
    ]),
  };
}

/**
 * A new folder. Folders in a bucket are key prefixes, and the server makes one
 * real by writing the folder's `README.md` placeholder (`createFolder`), so a
 * folder made offline is that same call made later. Notes created inside it
 * are their own creates and need nothing from it: a key under a prefix that
 * has no README is still a note in a folder.
 */
export function queueFolder(outbox: Outbox, input: { id: string; path: string; now: number }): Outbox | null {
  if (claimedPaths(outbox).has(input.path)) return null;
  return withOps(outbox, [
    ...opsOf(outbox),
    newOp(outbox, { id: input.id, kind: "folder", path: input.path, baseEtag: null }, input.now),
  ]);
}

/** The person took it back. Nothing about it reaches the bucket. */
export function dropOp(outbox: Outbox, id: string): Outbox {
  return replaceOp(outbox, id, null);
}

/** A refused op, back in the queue unchanged, because a person asked. */
export function retryOp(outbox: Outbox, id: string): Outbox {
  const op = findOp(outbox, id);
  if (op === undefined || op.state !== "rejected") return outbox;
  return replaceOp(outbox, id, { ...op, state: "pending", attempts: 0, rejection: undefined });
}

/**
 * "Do it anyway" — the note changed, and the person has been told so.
 *
 * `forceMine`'s shape: re-based onto the version the conflict reported, so
 * what is sent is still conditional on a specific version rather than blind.
 * A conflict with no current version (the note is gone) cannot be answered
 * this way; there is nothing left to rename.
 */
export function overrideOp(outbox: Outbox, id: string): Outbox {
  const op = findOp(outbox, id);
  if (op === undefined || op.state !== "conflicted" || op.conflict?.currentEtag === undefined) {
    return outbox;
  }
  return replaceOp(outbox, id, {
    ...op,
    state: "pending",
    baseEtag: op.conflict.currentEtag,
    conflict: undefined,
  });
}

/**
 * Move an op onto the version this queue's own landing just produced.
 *
 * The single place `baseEtag` of an op moves, and it moves only here, only to
 * an etag the bucket returned to *this queue* for the note the op is about:
 * the edit ahead of it, or the rename ahead of it. That is the person's own
 * version, not a fresher read somebody else made.
 */
export function rebaseOp(outbox: Outbox, id: string, etag: string): Outbox {
  const op = findOp(outbox, id);
  if (op === undefined) return outbox;
  return replaceOp(outbox, id, { ...op, baseEtag: etag });
}

export function settleOp(outbox: Outbox, id: string): Outbox {
  return replaceOp(outbox, id, null);
}

export function markOpConflict(
  outbox: Outbox,
  id: string,
  conflict: { currentEtag?: string; message: string; now: number },
): Outbox {
  const op = findOp(outbox, id);
  if (op === undefined) return outbox;
  return replaceOp(outbox, id, {
    ...op,
    state: "conflicted",
    attempts: op.attempts + 1,
    conflict: { currentEtag: conflict.currentEtag, message: conflict.message, noticedAt: conflict.now },
    rejection: undefined,
  });
}

export function markOpRejected(
  outbox: Outbox,
  id: string,
  rejection: { code: string; message: string; now: number },
): Outbox {
  const op = findOp(outbox, id);
  if (op === undefined) return outbox;
  return replaceOp(outbox, id, {
    ...op,
    state: "rejected",
    attempts: op.attempts + 1,
    rejection: { code: rejection.code, message: rejection.message, noticedAt: rejection.now },
    conflict: undefined,
  });
}

export function markOpFailed(outbox: Outbox, id: string, message: string): Outbox {
  const op = findOp(outbox, id);
  if (op === undefined) return outbox;
  return replaceOp(outbox, id, { ...op, attempts: op.attempts + 1, lastError: message });
}

/**
 * One note's worth of the queue: the edit to send first, then the op.
 *
 * Grouped by bucket path, because within one note the order is fixed whatever
 * order the presses came in — the edit goes before the rename (so the rename
 * carries the new text with it and is checked against the version the edit
 * produced) and before the delete (so what is in the trash is what the person
 * last wrote). Between notes the order is the order things were asked, which
 * is also the order the one cross-note dependency needs: a rename of a rename
 * waits for the first, and was always asked after it.
 */
export interface DrainUnit {
  path: string;
  write?: PendingWrite;
  op?: PendingOp;
}

export function drainUnits(outbox: Outbox): DrainUnit[] {
  const units = new Map<string, DrainUnit>();
  for (const write of outbox.writes) units.set(write.path, { path: write.path, write });
  for (const op of opsOf(outbox)) {
    const unit = units.get(op.path) ?? { path: op.path };
    unit.op = op;
    units.set(op.path, unit);
  }
  const first = (unit: DrainUnit) =>
    Math.min(unit.write?.queuedAt ?? Infinity, unit.op?.queuedAt ?? Infinity);
  return [...units.values()].sort((a, b) => first(a) - first(b));
}
