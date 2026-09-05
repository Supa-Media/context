import { ERRORS } from "./protocol";
import type { MeetingSession, TranscriptSegment } from "./protocol";

/**
 * What one meeting looks like on this device, and what still has to reach the
 * gateway.
 *
 * ## Why a record and an acknowledgement rather than an event queue
 *
 * `features/offline/outbox.ts` queues *writes* because a note write is a single
 * conditional PUT and the queue's whole job is to make it later. A meeting is
 * not one write: it is four idempotent upserts against four routes
 * (`session`, `segments`, `notes`, `finalize`), and the protocol says so in
 * words — "the same session id upserts, the same segment id replaces, and
 * finalize on an already-complete session returns the note path it already
 * wrote".
 *
 * That changes what is worth storing. A log of forty `notes` events is forty
 * round trips for a result identical to sending the last one, which is the
 * argument `outbox.ts` makes for "one entry per note, and the last text wins" —
 * applied here to a session rather than to a file. So what is written down is
 * the **projection** plus what the gateway has already acknowledged, and the
 * steps to send are the difference between the two. Replaying is then
 * subtraction, not a tape.
 *
 * ## What is never dropped
 *
 * The human's notes and the transcript are the only copy of something that
 * happened once. Nothing in this feature evicts, ages out or bounds a record
 * that has not reached the bucket — the same rule `features/offline/cache.ts`
 * draws between a disposable copy and somebody's typing. A record leaves only
 * when its note is in the bucket (`state: "complete"`, with a `notePath`) and a
 * person has had a chance to see that, or when the person discards it.
 *
 * ## What an acknowledgement is, and what it is not
 *
 * `acked` is a claim about the **gateway**, not about the bucket. The gateway
 * holding a segment is not the same as the customer's bucket holding the note,
 * and only `notePath` says the second. So nothing here is drawn as "saved":
 * `copy.ts` renders a synced-but-unfinalised meeting as still on the device.
 *
 * That distinction — "the finalize was accepted and the note is not there yet",
 * which is `acked.finalized` with a null `notePath` — is **client-local by the
 * contract**, and `protocol.js` says so outright under "what is client-local".
 * It is this device's knowledge of a request it made, not a state of the
 * meeting: it is never sent, there is no `MeetingState` for it, and `notePath`
 * from the gateway stays the only answer to "is this meeting in the bucket".
 */

/** A fingerprint of the metadata the `session` route carries. */
export type MetadataFingerprint = string;

export interface MeetingAck {
  /** The metadata fingerprint the gateway last acknowledged, or `null`. */
  metadata: MetadataFingerprint | null;
  /** Segment ids the gateway has confirmed holding. */
  segmentIds: string[];
  /** The exact Markdown the gateway last acknowledged, or `null` for none. */
  notes: string | null;
  /** Finalize has been accepted; the gateway owns the note from here. */
  finalized: boolean;
}

export interface MeetingRecord {
  /** Bumped when this shape changes; a record from another version is discarded. */
  version: 1;
  workspaceId: string;
  session: MeetingSession;
  acked: MeetingAck;
  /** ISO timestamp the currently-open recording interval started at. */
  runningSince: string | null;
  /** When anything about this record last changed, for ordering a restore. */
  updatedAt: number;
  /** Sync attempts that reached the gateway and were refused or failed. */
  attempts: number;
  /** Set when the gateway refused for a reason retrying will not fix. */
  rejection?: { code: string; message: string; noticedAt: number };
  /** The last transient failure, for the person who asks why it is still here. */
  lastError?: string;
}

export const MEETING_RECORD_VERSION = 1;

export function emptyAck(): MeetingAck {
  return { metadata: null, segmentIds: [], notes: null, finalized: false };
}

/**
 * Everything the `session` route carries, as one comparable string.
 *
 * Deliberately built from named fields rather than `JSON.stringify(session)`:
 * the transcript and the notes have their own routes, and folding them in here
 * would re-send the whole session's metadata on every keystroke.
 *
 * `enhanced` and `notePath` are excluded for the opposite reason — they are
 * things the *gateway* tells the client, so including them would make every
 * answer from the gateway look like a local change to be sent back.
 */
export function metadataFingerprint(session: MeetingSession): MetadataFingerprint {
  return JSON.stringify([
    session.id,
    session.version,
    session.title,
    // Flags ride on the session route, so a moment the wearer marked has to
    // change this or it never syncs.
    session.flags,
    session.state,
    session.startedAt,
    session.endedAt,
    session.recordedMs,
    session.source,
    session.attendees,
    session.device,
  ]);
}

/** One request the gateway still owes an answer to. */
export type SyncStep =
  | { kind: "session" }
  | { kind: "segments"; segments: TranscriptSegment[] }
  | { kind: "notes"; markdown: string }
  | { kind: "finalize" };

/**
 * What this record still has to send, in the order it has to be sent in.
 *
 * The order is a correctness rule, not a preference. `segments`, `notes` and
 * `finalize` are all addressed to `/meetings/sessions/:id/…`, so the session
 * has to exist at the gateway before any of them mean anything — and `finalize`
 * is last because it is what turns everything sent before it into a note. A
 * finalize that overtook the last batch of segments would write a note missing
 * the end of the meeting.
 */
export function pendingSteps(record: MeetingRecord): SyncStep[] {
  const steps: SyncStep[] = [];
  const { session, acked } = record;

  if (metadataFingerprint(session) !== acked.metadata) steps.push({ kind: "session" });

  const held = new Set(acked.segmentIds);
  const unsent = session.transcript.filter((segment) => !held.has(segment.id));
  if (unsent.length > 0) steps.push({ kind: "segments", segments: unsent });

  /*
    `?? ""` rather than a plain comparison against `null`. A meeting nobody
    typed into has `notes: ""` and has never been acknowledged, and the two are
    the same fact — so comparing them as different values makes every silent
    meeting POST an empty body to somebody's gateway for nothing. Deleting
    everything you typed still syncs, because the acknowledgement then holds
    the old text and `"" !== "what I typed"`.
  */
  if (session.notes !== (acked.notes ?? "")) {
    steps.push({ kind: "notes", markdown: session.notes });
  }

  /*
    Only `finalizing` finalizes. A `complete` session has already been through
    it and would get its own note path back — harmless, but a request nobody
    needs against somebody's gateway — and a `recording` one is still going.
  */
  if (session.state === "finalizing" && !acked.finalized) steps.push({ kind: "finalize" });

  return steps;
}

/** Whether anything about this record still has to reach the gateway. */
export function isSynced(record: MeetingRecord): boolean {
  return pendingSteps(record).length === 0;
}

/** Record the gateway's acknowledgement of one step. */
export function ackStep(record: MeetingRecord, step: SyncStep, now: number): MeetingRecord {
  const acked = { ...record.acked };
  if (step.kind === "session") acked.metadata = metadataFingerprint(record.session);
  if (step.kind === "segments") {
    acked.segmentIds = [...new Set([...acked.segmentIds, ...step.segments.map((s) => s.id)])];
  }
  if (step.kind === "notes") acked.notes = step.markdown;
  if (step.kind === "finalize") acked.finalized = true;
  return { ...record, acked, updatedAt: now, attempts: 0, lastError: undefined };
}

/* ------------------------------- failures -------------------------------- */

export type SyncOutcome =
  | { kind: "acked" }
  /** Retrying will not change the answer. Parked, and said out loud. */
  | { kind: "rejected"; code: string; message: string }
  /** Might work next time: the connection, the bucket, a lost conditional put. */
  | { kind: "failed"; message: string };

/**
 * Which gateway errors are worth trying again, and why this is an allowlist of
 * the *transient* ones rather than a list of the permanent ones.
 *
 * The same argument `features/offline/sync.ts` makes: a code this build has not
 * heard of — a new one, a refusal added next year — retried on every
 * reconnection forever spends the customer's request quota on something that
 * was never going to succeed, and nobody can see it happening. Unknown
 * therefore means parked and reported, which one press undoes.
 *
 * `conflict` is transient here on the protocol's own instruction — "Bucket
 * write lost a conditional put. Re-read and retry." — and unlike a note save it
 * is not a person's decision to make: two clients finalizing one meeting are
 * writing the same note from the same log, not two divergent drafts.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([ERRORS.unavailable, ERRORS.conflict]);

export function classifySyncFailure(
  error: { code: string; message: string },
): Exclude<SyncOutcome, { kind: "acked" }> {
  if (TRANSIENT_CODES.has(error.code)) return { kind: "failed", message: error.message };
  return { kind: "rejected", code: error.code, message: error.message };
}

/**
 * How many transient failures a record takes before it is parked.
 *
 * Counted across reconnections, exactly as `MAX_ATTEMPTS` in
 * `features/offline/sync.ts` is: a drain stops at the first transient failure,
 * so reaching this means six separate occasions on which the app believed it
 * was online and the gateway disagreed.
 */
export const MAX_SYNC_ATTEMPTS = 6;

export function markSyncFailed(
  record: MeetingRecord,
  message: string,
  now: number,
): MeetingRecord {
  const attempts = record.attempts + 1;
  if (attempts >= MAX_SYNC_ATTEMPTS) {
    return {
      ...record,
      attempts,
      rejection: {
        code: "RETRIES_EXHAUSTED",
        message:
          "This meeting has failed to reach your context several times. It is still on this device — try again, or copy your notes out.",
        noticedAt: now,
      },
    };
  }
  return { ...record, attempts, lastError: message };
}

export function markSyncRejected(
  record: MeetingRecord,
  rejection: { code: string; message: string },
  now: number,
): MeetingRecord {
  return {
    ...record,
    attempts: record.attempts + 1,
    rejection: { ...rejection, noticedAt: now },
    lastError: undefined,
  };
}

/** Put a parked record back in the queue, unchanged, at the person's request. */
export function retrySync(record: MeetingRecord): MeetingRecord {
  if (record.rejection === undefined) return record;
  return { ...record, attempts: 0, rejection: undefined, lastError: undefined };
}

/**
 * Read a record back off the store.
 *
 * Anything that is not exactly this version's shape comes back `null` rather
 * than as a throw or a half-parsed session, for `parseOutbox`'s reason: a
 * record we cannot read is a record we cannot send, and crashing the app on
 * launch over one helps nobody. The caller keeps the raw key so a person can
 * still be told a meeting could not be restored.
 */
export function parseRecord(raw: string | null, workspaceId: string): MeetingRecord | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<MeetingRecord>;
  if (record.version !== MEETING_RECORD_VERSION) return null;
  if (record.workspaceId !== workspaceId) return null;
  if (!isSession(record.session)) return null;
  const acked = isAck(record.acked) ? record.acked : emptyAck();
  return {
    version: MEETING_RECORD_VERSION,
    workspaceId,
    /*
      A record written before the contract carried flags reads as one with
      none. Not a version bump: bumping discards the record, and discarding a
      record is discarding somebody's meeting to avoid an empty array.
    */
    session: { ...record.session, flags: record.session.flags ?? [] },
    acked,
    runningSince: typeof record.runningSince === "string" ? record.runningSince : null,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    attempts: typeof record.attempts === "number" ? record.attempts : 0,
    rejection: record.rejection,
    lastError: record.lastError,
  };
}

function isSession(value: unknown): value is MeetingSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<MeetingSession>;
  return (
    typeof session.id === "string" &&
    typeof session.title === "string" &&
    typeof session.state === "string" &&
    typeof session.startedAt === "string" &&
    typeof session.notes === "string" &&
    Array.isArray(session.transcript) &&
    Array.isArray(session.attendees)
  );
}

function isAck(value: unknown): value is MeetingAck {
  if (typeof value !== "object" || value === null) return false;
  const ack = value as Partial<MeetingAck>;
  return Array.isArray(ack.segmentIds) && typeof ack.finalized === "boolean";
}
