/**
 * A meeting before it is a note: where an in-flight session lives, and why it
 * lives there.
 *
 * A session accumulates for the length of a meeting — forty minutes of
 * transcript arriving in batches from a phone that may lose signal twice — and
 * only becomes Markdown when a client finalizes it. That intermediate state has
 * to be somewhere, and there were three candidates:
 *
 *  - **The control plane.** Refused by the first non-negotiable. Convex holds
 *    accounts, workspaces, bindings, grants and audit, and *never note
 *    content* — and a transcript is note content in the strongest sense
 *    available: it is the meeting, verbatim, before anyone has summarised it.
 *    Parking it there for the duration of a meeting would put the customer's
 *    own words in the one place they neither own nor can revoke us out of, and
 *    "only for forty minutes" is not a property of storage, it is a hope.
 *  - **A Durable Object, KV, or anything else Worker-side.** The same objection
 *    one layer down: it is our storage, not theirs. A session interrupted by a
 *    deploy or an eviction strands somebody's meeting somewhere they cannot
 *    reach with their own credentials, which is exactly the arrangement this
 *    product exists to end. It also invents a second consistency story for
 *    content whose only durable home is the bucket anyway.
 *  - **The customer's own bucket, under a dot-prefixed plumbing key.** Chosen.
 *
 * So an in-flight session is one JSON object at `.meetings/sessions/<id>.json`
 * in the customer's bucket, and it is the folded `MeetingSession` the shared
 * reducer produces — not a log, and not a second shape. Four properties come
 * with that, and each is the reason it is not somewhere more convenient:
 *
 *  - **Nothing is ever stranded outside the bucket.** Every byte a client sends
 *    lands in storage the customer owns, on the request that sent it. Revoke
 *    our credential mid-meeting and the transcript so far is still theirs, in a
 *    plain JSON file they can read.
 *  - **It is reconstructible.** The record is the whole session — metadata, the
 *    human's Markdown, every segment merged by id, and the reducer's own
 *    `appliedAt`/`recordingSince` — so any gateway isolate, in any region,
 *    after any deploy, picks a meeting up by reading one key. The gateway is
 *    the thing that holds the fold *between* requests, which is why those two
 *    derived fields are persisted rather than dropped as internal.
 *  - **It is not note surface.** `isPlumbing` in `index.js` refuses every
 *    dot-prefixed segment at every scope, personal included, so an in-flight
 *    session is invisible to `read_note`, `list_notes` and search until it is
 *    finalized into a real note whose visibility `privacy.md` decides. The
 *    precedent is `.granola-events/pending/`, which already accumulates
 *    in-flight ingestion state in the bucket for exactly this reason.
 *  - **Tenancy is structural.** The store this module is handed is the one
 *    `storeForSession` built for one workspace, so a session id is reachable
 *    only from the bucket it was written into. Workspace B asking for
 *    workspace A's id is not refused by a check that could be forgotten — it
 *    reads B's bucket, finds nothing, and gets the answer a never-issued id
 *    gets.
 *
 * ## What finalize leaves behind
 *
 * On finalize the record is replaced by a completion receipt: state, title,
 * times, attendee names, the note path and its etag — and **no transcript, no
 * notes and no summary**. The note is canonical; a `.meetings/` copy of the
 * same words would be a permanent second copy of note content in the customer's
 * bucket, synced down to every Obsidian vault and paid for by them, which is
 * the write-amplification argument that removed `.history/`. The receipt is
 * what makes finalize idempotent forever.
 *
 * `list_meetings` does not read receipts at all: the notes are canonical and
 * `isMeetingNotePath` finds them, so there is no second index to drift.
 */

import { ERRORS, isMeetingId } from "../../../../packages/meetings/src/protocol.js";
import { applyEvent, applyLog, createSession } from "../../../../packages/meetings/src/session.js";
import { normalizeSegment } from "../../../../packages/meetings/src/transcript.js";

/** In-flight sessions and completion receipts. Dot-prefixed, so never a note. */
export const MEETING_PREFIX = ".meetings/sessions/";

/**
 * Caps. Every one is a bound on what one authenticated client can be made to
 * store in somebody's bucket — a limit on a mistake and on a hostile client,
 * never a judgement about how long a meeting may be.
 *
 * They live here rather than in the shared core deliberately: the core is a
 * reducer that four surfaces run, and a phone folding its own log offline has
 * no business refusing its owner's meeting. Refusing is the gateway's job,
 * because the gateway is the one writing into storage somebody pays for.
 */
export const LIMITS = Object.freeze({
  /** One POST body: a batch of segments, never a whole meeting. */
  requestBytes: 2_000_000,
  segmentsPerRequest: 1_000,
  /** Roughly a day of continuous speech at a segment every four seconds. */
  segmentsPerSession: 20_000,
  segmentTextChars: 4_000,
  /** The human's own Markdown, which they typed. */
  notesChars: 200_000,
  /** The generated note, which is regenerable. */
  enhancedChars: 200_000,
  /** Events one replay may carry. A reconnecting client sends its log, not its life. */
  eventsPerRequest: 1_000,
  attendees: 200,
  /** Records read to answer one recent-sessions listing. */
  listScan: 200,
  listLimit: 50,
});

/**
 * The events a *client* may send.
 *
 * Everything the contract defines except `written`, which is the gateway's own:
 * it is the only party that can know a note exists, and it is the event that
 * moves a session to `complete`. A client able to send it could mark a meeting
 * finished that was never written — the session would answer `complete` with a
 * note path pointing at nothing, and the recording would be lost in silence,
 * which is the one outcome this whole feature exists to prevent.
 */
const CLIENT_EVENT_TYPES = new Set([
  "start",
  "pause",
  "resume",
  "segment",
  "segments",
  "notes",
  "title",
  "attendee",
  "source",
  "end",
  "enhanced",
  "fail",
]);

/**
 * A refusal a meeting client may see.
 *
 * `code` is the key of one of the contract's `ERRORS`, mapped to the wire
 * string at the response boundary in `ingest.js` — one place that spells the
 * error codes, so a typo is a missing key rather than a code no client knows.
 */
export class MeetingRefusal extends Error {
  constructor(status, code, description) {
    super(code);
    this.name = "MeetingRefusal";
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

export function invalid(description) {
  return new MeetingRefusal(400, "invalid", description);
}

export function sessionKey(id) {
  return `${MEETING_PREFIX}${id}.json`;
}

/* ------------------------------ the reducer ------------------------------- */

/**
 * Fold one event, translating the core's refusals into wire refusals.
 *
 * `MeetingTransitionError` and `MeetingEventError` both carry `code:
 * ERRORS.invalid` — "Maps straight onto the wire error, so the gateway does not
 * translate", as the core puts it — so this adds a status and a description and
 * changes nothing else. The message is the core's own and names a state or a
 * field, never note content.
 */
export function fold(session, event) {
  try {
    return applyEvent(session, event);
  } catch (error) {
    if (error?.code) throw new MeetingRefusal(400, refusalKeyFor(error.code), error.message);
    throw error;
  }
}

/**
 * The `ERRORS` key for a wire code the shared core produced.
 *
 * Both of its error classes carry `ERRORS.invalid` today, and this reads the
 * value back rather than assuming it — a core that grew a `conflict` would
 * otherwise be relabelled as a client bug, sending a client that should re-read
 * into a retry loop it cannot win.
 */
function refusalKeyFor(code) {
  for (const [key, value] of Object.entries(ERRORS)) if (value === code) return key;
  return "invalid";
}

/** The same, for a client replaying its log. */
export function foldLog(session, events) {
  if (events === undefined || events === null) return session;
  if (!Array.isArray(events)) throw invalid("events must be an array");
  if (events.length > LIMITS.eventsPerRequest) {
    throw invalid(`at most ${LIMITS.eventsPerRequest} events per request`);
  }
  for (const event of events) {
    assertEventWithinLimits(event);
    if (!CLIENT_EVENT_TYPES.has(event.type)) throw invalid(`a client may not send a ${event.type} event`);
  }
  try {
    return applyLog(session, events);
  } catch (error) {
    if (error?.code) throw new MeetingRefusal(400, refusalKeyFor(error.code), error.message);
    throw error;
  }
}

/** Open a session from an upsert body, refusing the same way the fold does. */
export function openSession(body) {
  try {
    return createSession(body);
  } catch (error) {
    if (error?.code) throw new MeetingRefusal(400, refusalKeyFor(error.code), error.message);
    if (error instanceof TypeError) throw invalid("the session body is not a session");
    throw error;
  }
}

/**
 * The bounds, checked before anything is folded.
 *
 * Checked on the way in rather than on the folded result, because the honest
 * answer to "this batch is too big" is a refusal the client can act on — not a
 * silently truncated transcript, which is the one failure mode a meeting
 * recorder must never have.
 */
export function assertEventWithinLimits(event) {
  if (!event || typeof event !== "object") throw invalid("each event must be an object");
  switch (event.type) {
    case "segments":
      if (!Array.isArray(event.segments)) throw invalid("segments.segments must be an array");
      assertSegmentsWithinLimits(event.segments);
      return;
    case "segment":
      assertSegmentsWithinLimits([event.segment]);
      return;
    case "notes":
      if (typeof event.markdown === "string" && event.markdown.length > LIMITS.notesChars) {
        throw invalid("notes are too long");
      }
      return;
    case "enhanced":
      if (typeof event.markdown === "string" && event.markdown.length > LIMITS.enhancedChars) {
        throw invalid("the enhanced note is too long");
      }
      return;
    default:
      return;
  }
}

export function assertSegmentsWithinLimits(segments) {
  if (!Array.isArray(segments)) throw invalid("segments must be an array");
  if (segments.length > LIMITS.segmentsPerRequest) {
    throw invalid(`at most ${LIMITS.segmentsPerRequest} segments per request`);
  }
  for (const segment of segments) {
    if (segment && typeof segment === "object" && typeof segment.text === "string") {
      if (segment.text.length > LIMITS.segmentTextChars) throw invalid("a transcript segment is too long");
    }
  }
}

/** How many rows of a batch the merge could not use: no id, no text, a bad clock. */
export function countUnusable(segments) {
  return (segments || []).filter((segment) => normalizeSegment(segment) === null).length;
}

export function assertSessionWithinLimits(session) {
  if (session.transcript.length > LIMITS.segmentsPerSession) {
    throw invalid(`a session holds at most ${LIMITS.segmentsPerSession} segments`);
  }
  if (session.attendees.length > LIMITS.attendees) throw invalid("too many attendees");
  return session;
}

/* -------------------------------- storage --------------------------------- */

/**
 * Whether a write to this bucket can be made conflict-safe at all.
 *
 * R2 and AWS S3 honour a conditional put; B2 and Wasabi accept the header and
 * ignore it, which is why the capability is probed at connect time and why the
 * answer is read off the store rather than assumed. Every ack carries it, so a
 * client on a backend that cannot do it is *told* rather than quietly given
 * last-writer-wins. That is the whole of degrading honestly: the guarantee is
 * not silently dropped, it is reported absent.
 */
export function conflictSafeWrites(store) {
  return store?.capabilities?.conditionalWrite === true;
}

export async function readSession(store, id) {
  const object = await store.get(sessionKey(id));
  if (!object) return null;
  let record;
  try {
    record = JSON.parse(await object.text());
  } catch {
    // A record somebody edited by hand into something unparseable. It is in
    // their bucket and it is theirs; refusing is the only answer that does not
    // overwrite whatever they were trying to keep.
    throw new MeetingRefusal(409, "conflict", "this session record could not be read");
  }
  if (!record || typeof record !== "object" || record.id !== id || !isMeetingId(record.id)) {
    throw new MeetingRefusal(409, "conflict", "this session record could not be read");
  }
  record.transcript = Array.isArray(record.transcript) ? record.transcript : [];
  record.attendees = Array.isArray(record.attendees) ? record.attendees : [];
  record.appliedAt = record.appliedAt && typeof record.appliedAt === "object" ? record.appliedAt : {};
  return { session: record, etag: object.etag };
}

/**
 * Write a session record back, guarding the read it was derived from.
 *
 * Returns `false` when a conditional write was lost — a phone and a watch, or
 * two retries of one batch, racing on the same session. The caller re-reads and
 * re-folds rather than retrying blind: the merge is by segment id, so a re-fold
 * after a lost race is the same answer plus whatever the other writer added.
 */
export async function writeSession(store, session, etag) {
  const body = JSON.stringify({ ...session, updatedAt: new Date().toISOString() });
  if (etag && conflictSafeWrites(store)) {
    const put = await store.put(sessionKey(session.id), body, { onlyIf: { etagMatches: etag } });
    return put ? put.etag : false;
  }
  const put = await store.put(sessionKey(session.id), body);
  return put ? put.etag : false;
}

/**
 * Read, fold, write, and retry a lost race a bounded number of times.
 *
 * `mutate` receives the current session (or `null` when there is none) and
 * returns the next one, or `null` to write nothing. It runs again from a fresh
 * read on every attempt, so it must not close over anything the previous read
 * produced.
 */
export async function updateSession(store, id, mutate, { attempts = 4 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await readSession(store, id);
    const next = await mutate(current ? current.session : null);
    if (next === null) return null;
    const etag = await writeSession(store, next, current ? current.etag : null);
    if (etag !== false) return { session: next, etag };
  }
  throw new MeetingRefusal(409, "conflict", "this session changed while you were writing to it");
}

/**
 * The completion receipt: what stays behind once a meeting is a note.
 *
 * No transcript, no `notes`, no `enhanced` — the note holds all three and is
 * canonical. Attendee *names* stay, so a client can list what it recorded
 * without opening every note; addresses do not, because the note has them and a
 * second copy of somebody's email is a second thing to leak.
 */
export function completionReceipt(session, notePath, noteEtag) {
  return {
    id: session.id,
    version: session.version,
    title: session.title,
    state: "complete",
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    recordedMs: session.recordedMs ?? 0,
    source: session.source ?? { kind: "unknown" },
    attendees: (session.attendees ?? []).map((attendee) => ({ name: attendee.name })),
    segmentCount: (session.transcript ?? []).length,
    device: session.device ?? { platform: "web" },
    notePath,
    noteEtag,
    finalizedAt: new Date().toISOString(),
    transcript: [],
    notes: "",
    enhanced: null,
    templateId: session.templateId ?? null,
    failureReason: null,
    recordingSince: null,
    appliedAt: session.appliedAt ?? {},
  };
}

/**
 * Recent sessions in this context, newest first.
 *
 * Bounded twice: the listing, and the number of records read to sort it.
 * Session ids are random, so key order says nothing about time and the records
 * have to be read — one subrequest each, which is why this is capped well below
 * what a busy context could hold. It answers "what has my device sent", which
 * is a client question; `list_meetings` answers the AI client's question from
 * the notes themselves.
 */
export async function listSessions(store, limit) {
  const wanted = Math.min(Math.max(1, limit || 20), LIMITS.listLimit);
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix: MEETING_PREFIX, cursor });
    for (const object of page.objects) {
      if (object.key.endsWith(".json")) keys.push({ key: object.key, uploaded: object.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && keys.length < LIMITS.listScan);

  /*
    Session ids are random, so key order says nothing about time and the records
    themselves have to be read — one subrequest each, inside an invocation with
    a subrequest ceiling. So the *listing* orders the candidates by when they
    were last written, which costs nothing and is already in hand, and only the
    page being returned is read. Each record's own `startedAt` then orders the
    answer, because "when the meeting was" and "when the phone last synced" are
    different questions and the client asked the first.
  */
  keys.sort((a, b) => Number(b.uploaded || 0) - Number(a.uploaded || 0));
  const page = keys.slice(0, wanted);

  const records = [];
  for (let start = 0; start < page.length; start += 20) {
    const objects = await Promise.all(page.slice(start, start + 20).map(({ key }) => store.get(key)));
    for (const object of objects) {
      if (!object) continue;
      try {
        const record = JSON.parse(await object.text());
        if (record && typeof record === "object" && isMeetingId(record.id)) records.push(record);
      } catch {
        // One unreadable record does not take the listing down with it.
      }
    }
  }
  records.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return { records, scanned: keys.length };
}

/** What a client is told about a session — everything except the transcript. */
export function sessionSummary(session) {
  return {
    id: session.id,
    version: session.version,
    title: session.title,
    state: session.state,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    recordedMs: session.recordedMs ?? 0,
    source: session.source ?? { kind: "unknown" },
    attendees: session.attendees ?? [],
    device: session.device ?? { platform: "web" },
    segmentCount: Array.isArray(session.transcript) && session.transcript.length
      ? session.transcript.length
      : (session.segmentCount ?? 0),
    notePath: session.notePath ?? null,
    failureReason: session.failureReason ?? null,
  };
}
