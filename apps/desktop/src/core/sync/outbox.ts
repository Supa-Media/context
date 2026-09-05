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
 */

import { ERRORS } from "../contract.ts";
import type { TranscriptSegment } from "../contract.ts";

export type OutboxKind = "session" | "segments" | "notes" | "finalize";

/** Contract order. Index in this array is the drain order within a session. */
const KIND_ORDER: readonly OutboxKind[] = ["session", "segments", "notes", "finalize"];

export type EntryState = "pending" | "parked";

export interface OutboxEntry {
  /** `${sessionId}:${kind}` — stable, so a collapse can find its predecessor. */
  id: string;
  sessionId: string;
  kind: OutboxKind;
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

export interface QueueInput {
  sessionId: string;
  kind: OutboxKind;
  body: Record<string, unknown>;
  now: number;
}

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

  if (!existing) {
    const entry: OutboxEntry = {
      id,
      sessionId: input.sessionId,
      kind: input.kind,
      body: input.body,
      queuedAt: input.now,
      updatedAt: input.now,
      attempts: 0,
      state: "pending",
      nextAttemptAt: input.now,
    };
    return { ...outbox, entries: [...outbox.entries, entry] };
  }

  const body =
    input.kind === "segments"
      ? {
          ...existing.body,
          ...input.body,
          segments: mergeSegments(
            (existing.body["segments"] as TranscriptSegment[] | undefined) ?? [],
            (input.body["segments"] as TranscriptSegment[] | undefined) ?? [],
          ),
        }
      : { ...input.body };

  const next: OutboxEntry = {
    ...existing,
    body,
    updatedAt: input.now,
    ...(existing.state === "parked"
      ? {}
      : { attempts: 0, nextAttemptAt: input.now, lastError: undefined }),
  };
  return { ...outbox, entries: outbox.entries.map((entry) => (entry.id === id ? next : entry)) };
}

/**
 * The next entry to send, or null.
 *
 * Head-of-session only, ordered by kind; among sessions, the one whose head has
 * waited longest. A parked head blocks its own session and nothing else — the
 * meeting that cannot be sent must not stop the next one from going out.
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
    .sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  return ready[0] ?? null;
}

/** How long to wait after `attempts` failures. Capped, so a queue never stalls. */
export function backoffMs(attempts: number, jitter = 0): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (1 + jitter));
}

export type DrainResult =
  | { ok: true }
  | { ok: false; code: string; message: string; retryable: boolean };

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

/** Every entry for one session — what "this meeting has not been saved" means. */
export function pendingFor(outbox: Outbox, sessionId: string): OutboxEntry[] {
  return outbox.entries.filter((entry) => entry.sessionId === sessionId);
}

/** A person deleted a meeting. The only path that discards queued content. */
export function forgetSession(outbox: Outbox, sessionId: string): Outbox {
  return { ...outbox, entries: outbox.entries.filter((entry) => entry.sessionId !== sessionId) };
}
