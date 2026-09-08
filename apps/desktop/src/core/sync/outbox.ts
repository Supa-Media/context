/**
 * Everything the gateway has not acknowledged yet.
 *
 * A laptop records meetings on aeroplanes, in basements, and on hotel wifi that
 * resolves DNS and nothing else. So the app never *sends* — it queues, and a
 * drain sends. The queue is a pure reducer for the same reason
 * `apps/mobile/features/offline/outbox.ts` is: the interesting cases are a
 * finalize that lands before its segments, a meeting ended in a tunnel, and an
 * app quit mid-drain, and none of them can be tested inside an event handler.
 *
 * ## The rules this file exists to hold
 *
 * **Nothing is ever dropped to save space.** A queued transcript is the only
 * copy of something that was said in a room; it leaves this queue by being
 * acknowledged or by a person deleting the meeting. There is no cap, no LRU,
 * no "compact the oldest".
 *
 * **One entry per session per kind, and the newest content wins.** Typing in
 * the notepad for an hour is one `notes` write. Segments are the exception —
 * they *merge*, keyed on the segment id the contract makes stable, because
 * every segment is content and the last transcript is not a superset of the
 * previous one unless it is built that way.
 *
 * **A session's entries drain in contract order.** `session` (so the gateway
 * knows the meeting exists) → `segments` → `notes` → `finalize`. The gateway
 * writes the note on finalize, so a finalize that overtook its segments would
 * write a note with half a transcript in it and answer every later attempt with
 * the path it already wrote. Only the head entry of a session is ever in
 * flight; different sessions do not block each other.
 *
 * **A refusal that retrying cannot fix parks the entry rather than deleting
 * it.** `meeting_invalid` and `meeting_forbidden` mean a person has to do
 * something — reconnect, re-grant, or send us a bug report. The transcript
 * stays queued either way.
 *
 * **A `finalize` entry that has been stuck too long is not left stuck.** A
 * session in `finalizing` has no timeout at the gateway — most of the time it
 * is one request away from `complete` — so a lost response, a crash between
 * queuing `session` and `finalize`, or a deterministic refusal nobody has
 * looked at yet all look identical from here: a `finalize` entry that never
 * clears. `recoverStaleFinalize` is the glue around `checkFinalizeTimeout`
 * (`@context/meetings/recovery`, the pure rule): a first stale sighting gets
 * one forced retry, and a session still stuck a full timeout window after that
 * gets a queued `fail` — never a silent "Finalizing" forever.
 */

import {
  FINALIZE_TIMEOUT_MS,
  checkFinalizeTimeout,
  ERRORS,
  foreignSegmentSessions,
  segmentSessionId,
} from "../contract.ts";
import type { TranscriptSegment } from "../contract.ts";

export type OutboxKind = "session" | "segments" | "notes" | "finalize";

/** Contract order. Index in this array is the drain order within a session. */
const KIND_ORDER: readonly OutboxKind[] = ["session", "segments", "notes", "finalize"];

/**
 * Selection priority across sessions, within one call to `nextDrain` — lower
 * drains first. Not the drain order *within* a session, which `KIND_ORDER`
 * still owns untouched.
 *
 * `session` and `finalize` rank ahead of `segments` and `notes` for the same
 * reason `drainUrgency` in `core/sync/drain.ts` answers `"now"` and `"await"`
 * for them and `"timer"` for the rest: a session write races the first chunk
 * of its own meeting's audio, and a finalize is already awaited by its caller.
 * Both lose that race just as surely from behind a deep backlog of *other*
 * sessions' `segments`/`notes` as from behind the thirty-second timer — an
 * adversarial review measured a transcript through a 74-entry backlog and
 * none at 75, because a pass carries at most 25 entries and `nextDrain` had no
 * opinion beyond `queuedAt`. See `docs/decisions/desktop.md`, "Twenty is less
 * than thirty, and every recording died of it".
 *
 * Ranked here rather than by importing `drainUrgency`, so that `outbox.ts` —
 * the pure reducer `drain.ts` is built on top of — never imports the module
 * built on top of it. `sessionOrder.test.mjs` pins the two against each other
 * kind for kind, so they cannot drift apart.
 *
 * This changes *which* ready head `nextDrain` returns, never the queue's own
 * order: nothing here reorders `outbox.entries`, and a lower-priority head
 * that is not ready (parked, or still backing off) is excluded exactly as it
 * always was — the priority is over what is ready, never a reason to wait on
 * what is not.
 */
function selectionRank(kind: OutboxKind): 0 | 1 {
  return kind === "session" || kind === "finalize" ? 0 : 1;
}

export type EntryState = "pending" | "parked";

export interface OutboxEntry {
  /** `${sessionId}:${kind}` — stable, so a collapse can find its predecessor. */
  id: string;
  sessionId: string;
  kind: OutboxKind;
  /**
   * The `@name` this meeting is addressed to, without the `@`, or `null`.
   *
   * `null` — and everything the tray records — means **the connection's own
   * default context**, which is the one this machine's grant was minted for.
   * That is not a fallback: a machine holds one grant, and "the context this
   * credential is for" and "this person's brain" are the same bucket by
   * construction.
   *
   * It exists because the console can address a meeting somewhere else. The
   * gateway routes on an optional `@name` at the front of the path, so this is
   * a *slug* rather than a path: `routableContext` checks it against the same
   * pattern the gateway's own selector accepts, and a value that fails is
   * refused rather than falling off the front of the URL and being served by
   * whatever context the credential defaults to. That silent fallback is a
   * meeting written into the wrong tenant, which is the one outcome worth
   * refusing to send.
   */
  context?: string | null;
  /** The JSON body posted to the route for this kind. */
  body: Record<string, unknown>;
  queuedAt: number;
  updatedAt: number;
  attempts: number;
  state: EntryState;
  /** Earliest millisecond this may be attempted again. */
  nextAttemptAt: number;
  /** Set when parked; shown to the person who asks why a meeting is stuck. */
  parked?: { code: string; message: string; noticedAt: number };
  lastError?: string;
  /**
   * When `recoverStaleFinalize` last forced a retry of this entry, so a second
   * stale sighting can tell "still within its one retry's own window" from
   * "the retry did not help either" — see `checkFinalizeTimeout`'s own
   * `retriedAt`. Only ever set on a `finalize` entry.
   */
  retriedAt?: number;
}

export interface Outbox {
  version: 1;
  entries: OutboxEntry[];
}

export const OUTBOX_VERSION = 1;

export function emptyOutbox(): Outbox {
  return { version: OUTBOX_VERSION, entries: [] };
}

/**
 * Repair whatever was on disk. A queue file that fails to parse is replaced by
 * an empty one — but a queue file that parses and holds entries keeps every
 * entry it can read, because those are somebody's meetings.
 */
export function normalizeOutbox(raw: unknown): Outbox {
  if (typeof raw !== "object" || raw === null) return emptyOutbox();
  const source = raw as { version?: unknown; entries?: unknown };
  if (source.version !== OUTBOX_VERSION || !Array.isArray(source.entries)) return emptyOutbox();
  const entries = source.entries.filter((entry): entry is OutboxEntry => {
    // See below: `context` is read at send time rather than trusted here.

    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Partial<OutboxEntry>;
    return (
      typeof candidate.id === "string" &&
      typeof candidate.sessionId === "string" &&
      typeof candidate.kind === "string" &&
      KIND_ORDER.includes(candidate.kind as OutboxKind) &&
      typeof candidate.body === "object" &&
      candidate.body !== null
    );
  });
  return { version: OUTBOX_VERSION, entries };
}

function entryId(sessionId: string, kind: OutboxKind): string {
  return `${sessionId}:${kind}`;
}

/**
 * Merge a segment list into an existing one.
 *
 * Keyed on `TranscriptSegment.id`, later wins, sorted by `startMs` so the note
 * reads in order however the engine emitted them. This is what makes a re-send
 * idempotent on our side as well as the gateway's.
 */
export function mergeSegments(
  existing: readonly TranscriptSegment[],
  incoming: readonly TranscriptSegment[],
): TranscriptSegment[] {
  const byId = new Map<string, TranscriptSegment>();
  for (const segment of existing) byId.set(segment.id, segment);
  for (const segment of incoming) byId.set(segment.id, segment);
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

/**
 * THE MEETINGS A WRITE IS CARRYING WORDS FOR THAT ARE NOT THE ONE IT NAMES.
 *
 * A segment id names its own meeting (`segmentSessionId`, in the contract), and
 * that name is the one thing about a batch that cannot be overwritten by
 * whatever routed it. Empty is the ordinary answer; anything else is a bug
 * upstream of this queue and the queue is where it stops.
 *
 * Exported so the two places that enqueue can *say* it happened. `queueWrite`
 * below drops the rows either way — a silent drop is bad, and a silent send of
 * one meeting's transcript into another meeting's note is worse, so the drop is
 * enforced in the reducer where it cannot be forgotten and the sentence is
 * owned by the caller that has somewhere to put it.
 */
export function misaddressedSegments(sessionId: string, body: Record<string, unknown>): string[] {
  return foreignSegmentSessions(sessionId, body["segments"]);
}

/** The rows of `segments` that were minted for `sessionId`, or name no meeting. */
function addressedTo(sessionId: string, segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter((segment) => {
    const named = segmentSessionId(segment?.id);
    return named === null || named === sessionId;
  });
}

export interface QueueInput {
  sessionId: string;
  kind: OutboxKind;
  body: Record<string, unknown>;
  /** See `OutboxEntry.context`. Absent and `null` both mean this machine's own. */
  context?: string | null;
  now: number;
}

/**
 * A slug the gateway's workspace selector will read as one, or `null`.
 *
 * `splitWorkspacePath` in `apps/mcp/src/session.js` accepts `[a-z0-9-]{2,32}`
 * and treats anything else as "no slug at all" — the path is then served by the
 * connection's default context. Restated here rather than imported, because the
 * desktop app does not depend on the worker's source; the point of mirroring it
 * is that a value this pattern refuses is exactly a value that would be
 * *ignored* on the far end, and being ignored is what makes it dangerous.
 *
 * `null` in is `null` out and means the connection's own context, which is the
 * ordinary case and everything the tray records.
 */
export function routableContext(value: unknown): string | null {
  /*
    Absent is the only thing that means "this machine's own context".

    Anything else that is not a legal slug is `UNROUTABLE` rather than `null`,
    including an empty string and a value a queue file on disk was corrupted
    into. Reading those as "the default" is precisely the silent wrong-tenant
    write this function exists to prevent — the difference between "nobody named
    a context" and "somebody named one and we could not read it" is the whole
    point, and only the first is an address.
  */
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return UNROUTABLE;
  return ROUTABLE_SLUG.test(value) ? value : UNROUTABLE;
}

const ROUTABLE_SLUG = /^[a-z0-9-]{2,32}$/;

/**
 * What `routableContext` answers for a value that is a name and not a legal one.
 *
 * A separate sentinel from `null`, because the two must not be confused: `null`
 * is "this machine's own context" and is a correct address, while this is "a
 * context nobody can route to" and must never be sent. `contextRouteFor`
 * refuses the entry rather than dropping the slug.
 */
export const UNROUTABLE = "\u0000unroutable";

/**
 * Add or collapse one write.
 *
 * A collapse resets `attempts` and `nextAttemptAt`: the content changed, so the
 * backoff earned by the previous content no longer describes this entry, and a
 * person who just typed something should not wait out a minute of backoff from
 * a write that no longer exists. A **parked** entry is the exception — it stays
 * parked, because new content does not make a rejected grant acceptable, and
 * un-parking on every keystroke would hammer a gateway that has already said no.
 */
export function queueWrite(outbox: Outbox, input: QueueInput): Outbox {
  const id = entryId(input.sessionId, input.kind);
  const existing = outbox.entries.find((entry) => entry.id === id);
  /*
    A batch is stripped of any row minted for a different meeting before it is
    stored, on the way in and on every collapse.

    Enforced here rather than at the call sites because this is the one function
    every desktop enqueue goes through — the tray's controller and the console's
    `writeMeetingFromConsole` both — and a rule that lives in two callers is a
    rule a third caller will not have. What it stops is not a full queue: it is
    one meeting's words being posted to another meeting's session, which the
    gateway takes for any session whose finalize has not landed yet. See
    `misaddressedSegments`, and `listenToRecorder` in the console app for how
    eight of one evening's meetings came to hold each other's transcripts.
  */
  const body =
    input.kind === "segments" && Array.isArray(input.body["segments"])
      ? {
          ...input.body,
          segments: addressedTo(input.sessionId, input.body["segments"] as TranscriptSegment[]),
        }
      : input.body;

  if (!existing) {
    const entry: OutboxEntry = {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      context: input.context ?? null,
      body,
      queuedAt: input.now,
      updatedAt: input.now,
      attempts: 0,
      state: "pending",
      nextAttemptAt: input.now,
    };
    return { ...outbox, entries: [...outbox.entries, entry] };
  }

  const merged =
    input.kind === "segments"
      ? {
          ...existing.body,
          ...body,
          segments: mergeSegments(
            addressedTo(
              input.sessionId,
              (existing.body["segments"] as TranscriptSegment[] | undefined) ?? [],
            ),
            (body["segments"] as TranscriptSegment[] | undefined) ?? [],
          ),
        }
      : { ...body };

  const next: OutboxEntry = {
    ...existing,
    /*
      The newest address wins, exactly as the newest body does. A meeting whose
      destination was changed between two writes is one meeting going one place;
      keeping the first address would send half of it to the other.
    */
    context: input.context ?? null,
    body: merged,
    updatedAt: input.now,
    ...(existing.state === "parked"
      ? {}
      : // New content is a new attempt at finalizing, so the timeout clock
        // (and whatever retry it already earned) restarts with it.
        { attempts: 0, nextAttemptAt: input.now, lastError: undefined, retriedAt: undefined }),
  };
  return { ...outbox, entries: outbox.entries.map((entry) => (entry.id === id ? next : entry)) };
}

/**
 * The next entry to send, or null.
 *
 * Head-of-session only, ordered by kind within a session exactly as before;
 * among sessions, a `session` or `finalize` head jumps ahead of every
 * `segments`/`notes` head regardless of how long either has waited, and ties
 * within a priority tier go to whichever head has waited longest. See
 * `selectionRank`. A parked or backed-off head blocks its own session and
 * nothing else — the meeting that cannot be sent must not stop the next one
 * from going out, and a high-priority head that is not ready loses its place
 * to a lower-priority one that is, rather than holding the slot open.
 */
export function nextDrain(outbox: Outbox, now: number): OutboxEntry | null {
  const heads = new Map<string, OutboxEntry>();
  for (const entry of outbox.entries) {
    const head = heads.get(entry.sessionId);
    if (!head || KIND_ORDER.indexOf(entry.kind) < KIND_ORDER.indexOf(head.kind)) {
      heads.set(entry.sessionId, entry);
    }
  }
  const ready = [...heads.values()]
    .filter((entry) => entry.state === "pending" && entry.nextAttemptAt <= now)
    .sort(
      (a, b) =>
        selectionRank(a.kind) - selectionRank(b.kind) ||
        a.queuedAt - b.queuedAt ||
        a.id.localeCompare(b.id),
    );
  return ready[0] ?? null;
}

/** How long to wait after `attempts` failures. Capped, so a queue never stalls. */
export function backoffMs(attempts: number, jitter = 0): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + jitter));
}

export type DrainResult =
  | {
      ok: true;
      /**
       * Where the note landed, for a finalize the gateway answered with one.
       *
       * The one fact in a successful ingest the client did not already know,
       * and the reason it is carried rather than dropped: on the console path
       * the *page* is waiting to hear that its meeting reached the bucket, and
       * "the queue accepted it" is not that. Absent for every other kind, and
       * for a gateway that answered without one.
       */
      notePath?: string | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
      retryable: boolean;
      /**
       * The HTTP status, when the refusal came from a gateway at all.
       *
       * Absent for the refusals `postEntry` composes before a request is built
       * — an unroutable context, a machine with no grant — because those never
       * had one, and a zero there would read as a status somebody could look
       * up. It exists so a log line can say `400 meeting_invalid <why>` rather
       * than a code with no HTTP behind it.
       */
      status?: number;
    };

/**
 * Which refusals are worth trying again.
 *
 * Straight off `ERRORS` in the contract, and stated here rather than at the
 * call site so that a new error code is a compile-adjacent decision instead of
 * an `else` branch somebody guessed at. Anything unrecognised is treated as
 * retryable: an unknown code is far more likely to be a gateway we have not
 * caught up with than a permanent refusal, and the cost of being wrong is a
 * backoff rather than a lost transcript.
 */
export function isRetryable(code: string): boolean {
  if (code === ERRORS.invalid || code === ERRORS.forbidden) return false;
  return true;
}

/** Apply what the gateway said. */
export function applyDrain(
  outbox: Outbox,
  entryId_: string,
  result: DrainResult,
  now: number,
  jitter = 0,
): Outbox {
  const entries = outbox.entries.flatMap((entry) => {
    if (entry.id !== entryId_) return [entry];
    if (result.ok) return [];
    const attempts = entry.attempts + 1;
    if (!result.retryable) {
      return [
        {
          ...entry,
          attempts,
          state: "parked" as const,
          parked: { code: result.code, message: result.message, noticedAt: now },
          lastError: result.message,
        },
      ];
    }
    return [
      {
        ...entry,
        attempts,
        nextAttemptAt: now + backoffMs(attempts, jitter),
        lastError: result.message,
      },
    ];
  });
  return { ...outbox, entries };
}

/**
 * PUT A DRAIN'S OUTCOME BACK ON A QUEUE THAT MOVED WHILE IT WAS IN FLIGHT.
 *
 * A drain is a snapshot plus a network round trip, and the queue is not frozen
 * for the duration: a segment is spoken, somebody types in the notepad, the
 * console hands over a write. Assigning the drain's result over the live queue
 * — `outbox = report.outbox` — silently drops every one of those, and the write
 * it drops has already been reported to whoever queued it as accepted. On the
 * console path that is a **false acknowledgement**: `meetings.write` answered
 * `queued: true` for a note the queue no longer holds, and
 * `docs/decisions/app-and-console.md`'s rule is exactly that a UI may never
 * claim a write it has not seen land.
 *
 * So the drain's outcome is *re-applied* rather than assigned, entry by entry:
 *
 *  - **Queued during the drain** — the drain knows nothing about it, so it is
 *    kept untouched. This is the case that was being lost.
 *  - **Acknowledged, and unchanged since** — removed, which is what an
 *    acknowledgement means.
 *  - **Acknowledged, but changed since** — kept. What the gateway acknowledged
 *    is not what the queue is now holding: a `segments` entry that merged three
 *    more segments while its predecessor was in flight is not the entry that
 *    was sent, and dropping it drops those three. Re-sending the whole entry is
 *    safe by the protocol's own rule — segments merge on a stable id and every
 *    route upserts.
 *  - **Refused or parked** — the drain's bookkeeping (the backoff it earned,
 *    the parked flag it set) is kept, over whatever content the queue now
 *    holds. A refusal is about the meeting, not about the bytes.
 *
 * Compared on `updatedAt` because `queueWrite` stamps it on every collapse,
 * which makes it exactly "the content changed" and nothing else.
 */
export function reconcileDrain(before: Outbox, drained: Outbox, live: Outbox): Outbox {
  if (live === before) return drained;

  const wasById = new Map(before.entries.map((entry) => [entry.id, entry]));
  const drainedById = new Map(drained.entries.map((entry) => [entry.id, entry]));

  const entries = live.entries.flatMap((entry): OutboxEntry[] => {
    const was = wasById.get(entry.id);
    if (was === undefined) return [entry];

    const changed = entry.updatedAt !== was.updatedAt;
    const after = drainedById.get(entry.id);
    if (after === undefined) return changed ? [entry] : [];
    if (!changed) return [after];

    const kept: OutboxEntry = {
      ...entry,
      attempts: after.attempts,
      nextAttemptAt: after.nextAttemptAt,
      state: after.state,
    };
    if (after.parked !== undefined) kept.parked = after.parked;
    if (after.lastError !== undefined) kept.lastError = after.lastError;
    return [kept];
  });

  return { ...live, entries };
}

/** Every entry for one session — what "this meeting has not been saved" means. */
export function pendingFor(outbox: Outbox, sessionId: string): OutboxEntry[] {
  return outbox.entries.filter((entry) => entry.sessionId === sessionId);
}

/**
 * DROP THE WORDS A QUEUE IS HOLDING FOR THE WRONG MEETING.
 *
 * Run once when the queue is read off disk, because a queue written by an
 * earlier build can be holding rows `queueWrite` would refuse today, and a
 * **parked** entry never gets another write to be cleaned up by: parking is
 * terminal in this app, so those rows would sit in somebody's queue file
 * forever, and the meeting they are attached to would go on reporting a
 * refusal about words that are not missing from anything.
 *
 * Measured, on the owner's Mac: eight parked `segments` entries, each holding
 * a *later* meeting's transcript, put there by a leaked recorder subscription
 * in the console app. Every one of those rows had also been folded into the
 * meeting that produced it and had gone out under that meeting's own id, so the
 * words are in the right note — these are duplicates addressed to the wrong
 * session, and nothing else.
 *
 * **Which is why this may drop them at all**, against this file's own first
 * rule that nothing is ever dropped: that rule is about a queued transcript
 * being *the only copy of something that was said in a room*. A row minted for
 * another meeting is not the only copy of anything — it is a second copy of
 * words the meeting that owns them already sent. An entry left with nothing of
 * its own meeting is dropped whole, because there is nothing left in it to
 * send; an entry with some of its own rows keeps them, and keeps its state
 * exactly as it was, parked included. Nothing is un-parked here: new content
 * does not make a rejected write acceptable, and removing content does not
 * either.
 *
 * Answers `{outbox, dropped}` rather than just the queue, so the caller can log
 * that it happened. `dropped` counts rows, never text.
 */
export function dropMisaddressed(outbox: Outbox): { outbox: Outbox; dropped: number } {
  let dropped = 0;
  const entries = outbox.entries.flatMap((entry): OutboxEntry[] => {
    if (entry.kind !== "segments") return [entry];
    const held = entry.body["segments"];
    if (!Array.isArray(held)) return [entry];
    const kept = addressedTo(entry.sessionId, held as TranscriptSegment[]);
    if (kept.length === held.length) return [entry];
    dropped += held.length - kept.length;
    if (kept.length === 0) return [];
    return [{ ...entry, body: { ...entry.body, segments: kept } }];
  });
  return { outbox: { ...outbox, entries }, dropped };
}

/** A person deleted a meeting. The only path that discards queued content. */
export function forgetSession(outbox: Outbox, sessionId: string): Outbox {
  return { ...outbox, entries: outbox.entries.filter((entry) => entry.sessionId !== sessionId) };
}

/**
 * Act on every `finalize` entry that has been sitting too long, per
 * `checkFinalizeTimeout` — the pure rule this function is glue around.
 *
 * Called on a drain tick and once on launch, both with the same function:
 * "on app launch, any `finalizing` session older than the bound is handled
 * the same way" is true for free when launch is just another tick with a
 * queue that survived a restart on disk.
 *
 * **`retry`** forces the entry back to `pending` with its backoff cleared and
 * stamps `retriedAt`, so the very next drain sends it again regardless of how
 * much of its backoff window remains — a stuck entry does not get to wait out
 * a minute of exponential backoff on top of the ten it has already lost.
 *
 * **`fail`** queues a `session` write carrying a `fail` event — `session`
 * drains ahead of `finalize` in `KIND_ORDER`, so the gateway learns the
 * session failed before anything else about it is attempted — and then drops
 * the stale `finalize` entry. Left in place, that entry would ask this
 * function to fail the same session again on every future tick forever: once
 * a client has said `fail`, an entry proposing to retry the *original*
 * finalize is superseded, not merely postponed. A person pressing Retry from
 * here on queues a fresh finalize the ordinary way, through `end()`.
 */
export function recoverStaleFinalize(
  outbox: Outbox,
  now: number,
  options: { timeoutMs?: number } = {},
): Outbox {
  let next = outbox;
  for (const entry of outbox.entries) {
    if (entry.kind !== "finalize") continue;
    const endedAt = typeof entry.body["endedAt"] === "string" ? (entry.body["endedAt"] as string) : null;
    const outcome = checkFinalizeTimeout(
      { state: "finalizing", endedAt },
      now,
      { timeoutMs: options.timeoutMs, retriedAt: entry.retriedAt ?? null },
    );

    if (outcome.action === "none") continue;

    if (outcome.action === "retry") {
      next = {
        ...next,
        entries: next.entries.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, retriedAt: now, state: "pending" as const, nextAttemptAt: now, attempts: 0 }
            : candidate,
        ),
      };
      continue;
    }

    next = queueWrite(next, {
      sessionId: entry.sessionId,
      kind: "session",
      context: entry.context,
      body: {
        id: entry.sessionId,
        events: [{ type: "fail", at: new Date(now).toISOString(), reason: outcome.reason }],
      },
      now,
    });
    next = { ...next, entries: next.entries.filter((candidate) => candidate.id !== entry.id) };
  }
  return next;
}
