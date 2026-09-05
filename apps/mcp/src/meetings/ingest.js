/**
 * Meeting ingestion: the routes a phone, a desktop app and (soon) a watch send
 * a meeting to, and the one place a meeting becomes a note in the customer's
 * own bucket.
 *
 * `packages/meetings/src/protocol.js` is the contract and this file implements
 * it rather than restating it: the routes come from `ROUTES`, the error codes
 * from `ERRORS`, the legal state moves from `MEETING_TRANSITIONS` by way of the
 * shared reducer, and the Markdown from `renderMeetingNote`. Nothing here
 * decides what a meeting *is*.
 *
 * ## Idempotency, end to end
 *
 * Every route is safe to send twice, because every client will:
 *
 *  - **the session** upserts by id, and re-sending metadata folds to the same
 *    record;
 *  - **segments** merge by client-generated segment id, so a phone that lost
 *    signal and re-sends everything it buffered does not duplicate a word;
 *  - **notes** replace, because that text is the human's and last write wins;
 *  - **finalize** on an already-complete session answers with the note path it
 *    already wrote and never writes a second note.
 *
 * The fold itself is `applyEvent`'s, which drops an event no newer than the one
 * it already applied — so a reconnecting client may replay its whole log in
 * `events` and land exactly where it was.
 *
 * ## What a refusal says, and what it must never say
 *
 * A session id from another workspace, an id that never existed, and an id its
 * owner deleted are **one answer**: `404` with `meeting_forbidden`. That is not
 * a rule someone has to remember — it is one code path. The store this handler
 * is given was built by `storeForSession` for exactly one workspace, so a
 * session id is only ever reachable from the bucket it was written into, and
 * the gateway could not distinguish the three cases if it wanted to. Answering
 * `403` where `404` belongs would turn the route into an existence oracle over
 * every id anybody has ever recorded.
 *
 * Scope is checked before any lookup, so "you cannot write here" is decided
 * without reading anything and therefore discloses nothing either.
 */

import { ERRORS, ROUTES, isMeetingId } from "../../../../packages/meetings/src/protocol.js";
import { renderMeetingNote } from "../../../../packages/meetings/src/note.js";
import { meetingNotePath } from "../../../../packages/meetings/src/paths.js";
import { normalizeFlag } from "../../../../packages/meetings/src/session.js";
import { SCOPE_READ, SCOPE_WRITE, hasScope } from "../session.js";
import {
  LIMITS,
  MeetingRefusal,
  assertEventWithinLimits,
  assertSegmentsWithinLimits,
  assertSessionWithinLimits,
  completionReceipt,
  conflictSafeWrites,
  countUnusable,
  fold,
  foldLog,
  invalid,
  listSessions,
  openSession,
  readSession,
  sessionNotFound,
  sessionSummary,
  updateSession,
  writeSession,
} from "./state.js";

const BASE = ROUTES.sessions;

/**
 * The sub-route names, read off the contract rather than spelled again here.
 *
 * `ROUTES.segments("<id>")` is the only statement of what that path looks like;
 * taking the suffix from it means a rename in `protocol.js` moves this route
 * with it instead of leaving two spellings that agree until they do not. The
 * part that is cut off is `ROUTES.session("id")` — the contract's own spelling
 * of "one session" — so the collection, one session and its sub-routes cannot
 * drift from each other here either.
 */
function suffixOf(route) {
  return route("id").slice(ROUTES.session("id").length);
}

const SUB_ROUTES = new Map([
  [suffixOf(ROUTES.segments), "segments"],
  [suffixOf(ROUTES.notes), "notes"],
  [suffixOf(ROUTES.finalize), "finalize"],
]);

/**
 * Does this path address meeting ingestion at all?
 *
 * Exported for `index.js`, which asks it of the path *after* the workspace
 * selector has come off — so `/@seyi/meetings/sessions` is a meeting path in
 * `@seyi`'s context, and `/meetings/sessions` is one in the caller's own.
 * `index.js` uses it to decide that these routes are guarded on the same
 * `Origin` terms as the MCP transport: they are authenticated, state-changing
 * and reachable from a browser.
 *
 * It used to be asked of the raw pathname instead, because `meetings` was not
 * one of `session.js`'s reserved first segments; it is now, so the selector
 * leaves the path alone by itself.
 */
export function isMeetingPath(path) {
  return path === BASE || path.startsWith(`${BASE}/`);
}

/**
 * Which meeting route this is, or `null`.
 *
 * The method is deliberately not part of the match: a known path reached with
 * the wrong method is a `405` that names the route, not a `404` that pretends
 * it is not there.
 */
export function matchMeetingRoute(path) {
  if (path === BASE) return { kind: "collection", id: null };
  if (!isMeetingPath(path)) return null;
  const rest = path.slice(BASE.length + 1);
  const slash = rest.indexOf("/");
  const id = slash === -1 ? rest : rest.slice(0, slash);
  if (!isMeetingId(id)) return null;
  if (slash === -1) return { kind: "session", id };
  const kind = SUB_ROUTES.get(rest.slice(slash));
  return kind ? { kind, id } : null;
}

/** POST changes a meeting; GET reads one back. Nothing here is capture-only. */
export function scopeForMeetingRequest(method) {
  return method === "POST" ? SCOPE_WRITE : SCOPE_READ;
}

/* ------------------------------- responses -------------------------------- */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * A refusal on the wire.
 *
 * `code` is a key of `ERRORS` and is mapped here, so this is the only place in
 * the gateway that spells a meeting error string — a typo is a missing key at
 * this line rather than a code no client has ever heard of.
 */
function refusal(error) {
  const code = ERRORS[error.code];
  if (!code) throw new Error(`unknown meeting error code: ${error.code}`);
  const body = { error: code, error_description: error.description };
  if (Array.isArray(error.scope)) body.scope = error.scope;
  return json(body, error.status);
}

function notFound() {
  // One answer for another workspace's id, an id that never existed, an id
  // whose record its owner deleted, and an id this connection's tier may not
  // see. See the file header. Spelled in `state.js` so the refusal
  // `updateSession` raises for the last of those is the same object.
  return sessionNotFound();
}

/**
 * The refusal for a connection whose grant, or whose role in this context, does
 * not carry the scope this route needs.
 *
 * Exported because `index.js` checks scope before it builds a store — the same
 * order `/inbox` uses — and a meeting client is owed a meeting error rather
 * than the OAuth-shaped one the MCP transport answers with. The missing scope
 * is named so a client can re-authorize for that one thing.
 */
export function meetingScopeRefusal(needed) {
  const error = new MeetingRefusal(
    403,
    "forbidden",
    `This connection does not hold the ${needed} scope for this context.`
  );
  error.scope = [needed];
  return refusal(error);
}

/**
 * The ack every route answers with, in the contract's `IngestAck` shape.
 *
 * `conflictSafe` and `rejected` are the contract's now — they were sent from
 * here before `IngestAck` had room for them, which made two of the three things
 * this response says undocumented. The first is the one that matters: B2 and
 * Wasabi accept a conditional put and ignore it, and a client whose session is
 * being written last-writer-wins is told rather than left to assume the
 * guarantee it read about. Never dropping the guarantee silently is the
 * standard; this line is how it is not silent.
 */
function ack(store, session, extra = {}) {
  const summary = sessionSummary(session);
  return json({
    sessionId: summary.id,
    state: summary.state,
    segmentCount: summary.segmentCount,
    notePath: summary.notePath,
    conflictSafe: conflictSafeWrites(store),
    ...extra,
  });
}

/* --------------------------------- bodies --------------------------------- */

async function readJsonBody(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > LIMITS.requestBytes) {
    throw new MeetingRefusal(413, "invalid", "the request body is too large");
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > LIMITS.requestBytes) {
    throw new MeetingRefusal(413, "invalid", "the request body is too large");
  }
  // An empty body is "no fields", which is exactly what a bare finalize is.
  if (bytes.byteLength === 0) return {};
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalid("the request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("the request body must be a JSON object");
  }
  return body;
}

/**
 * Fold the metadata a body carries into a session, as contract events.
 *
 * Convenience fields, not a second shape: `title`, `source`, `attendees` and
 * `notes` each become the event `applyEvent` already knows, so there is exactly
 * one implementation of what each of them means. A field the body does not
 * carry leaves the stored value alone — a phone re-sending what it knows after
 * a reconnect must not erase a title the watch set.
 *
 * `state` is deliberately **not** one of them. Every state move needs the
 * client's own timestamp to be replay-safe, so moves arrive as `start`,
 * `pause`, `resume` and `end` events in `events`, which is the log the client
 * is keeping anyway.
 */
function foldMetadata(session, body) {
  let next = session;
  if (typeof body.title === "string") next = fold(next, { type: "title", title: body.title });
  if (body.source !== undefined && body.source !== null) {
    next = fold(next, { type: "source", source: body.source });
  }
  if (body.attendees !== undefined && body.attendees !== null) {
    if (!Array.isArray(body.attendees)) throw invalid("attendees must be an array");
    for (const attendee of body.attendees.slice(0, LIMITS.attendees)) {
      next = fold(next, { type: "attendee", attendee });
    }
  }
  /*
    Flags fold the same way, and for the same reason attendees do: a client that
    holds the session holds its flags, and a re-send after a reconnect carries
    them in the body rather than as events. Without this, a moment the wearer
    marked reached the gateway only if it happened to be in the request that
    *created* the session — every later press was accepted with a 200 and
    dropped.
  */
  if (body.flags !== undefined && body.flags !== null) {
    if (!Array.isArray(body.flags)) throw invalid("flags must be an array");
    for (const flag of body.flags.slice(0, LIMITS.flags)) {
      // A row the core cannot read is skipped rather than failing the request,
      // for `normalizeSegment`'s reason one field over: a client re-sending
      // everything it holds, with one unreadable entry in it, should land the
      // rest — and `meeting_invalid` is the code clients do not retry, so
      // refusing here parks a whole meeting over one bad number.
      if (normalizeFlag(flag)) next = fold(next, { type: "flag", at: flag.at, label: flag.label });
    }
  }
  const markdown = notesFrom(body);
  if (markdown !== null) {
    assertEventWithinLimits({ type: "notes", markdown });
    next = fold(next, { type: "notes", markdown });
  }
  return next;
}

/** `notes` is the session's field name and `markdown` the event's; both are accepted. */
function notesFrom(body) {
  if (typeof body.notes === "string") return body.notes;
  if (typeof body.markdown === "string") return body.markdown;
  return null;
}

/* -------------------------------- handlers -------------------------------- */

/**
 * One meeting request.
 *
 * `publishNote` is injected rather than imported: the privacy engine, the
 * exact-visibility ACL and the audit trail live in `index.js`, and a second
 * implementation of "what visibility does a new note get" is the drift that
 * privacy bugs are made of. This module decides *what* Markdown to write and
 * where; `index.js` decides what writing it means.
 */
export async function handleMeetings(request, path, store, session, { publishNote }) {
  const route = matchMeetingRoute(path);
  if (!route) return json({ error: ERRORS.invalid, error_description: "no such meeting route" }, 404);

  try {
    /*
      The tier this connection reads at, threaded into every handler.

      A meeting is note content before it is a note: `publishMeetingNote` files a
      personal connection's meeting as private and a team connection's as team,
      so the record it is filed *from* answers at the same tier. Passed
      explicitly rather than read off `store` so that a handler cannot be written
      that forgets to ask.
    */
    const tier = session.scope;
    if (route.kind === "collection") {
      if (request.method === "GET") return await listMeetingSessions(request, store, tier);
      if (request.method === "POST") return await upsertSession(request, store, tier);
      return methodNotAllowed();
    }
    if (route.kind === "session") {
      if (request.method === "GET") return await readOneSession(request, store, route.id, tier);
      return methodNotAllowed();
    }
    if (request.method !== "POST") return methodNotAllowed();
    if (route.kind === "segments") return await appendSegments(request, store, route.id, tier);
    if (route.kind === "notes") return await replaceNotes(request, store, route.id, tier);
    return await finalizeSession(request, store, session, route.id, publishNote);
  } catch (error) {
    if (error instanceof MeetingRefusal) return refusal(error);
    /*
      Everything else is storage. The client keeps its log and retries with
      backoff, which is the correct behaviour for a bucket that is down, a
      credential that stopped working, and a bug in this handler alike — the
      first two because they are true, and the third because dropping a
      meeting on the floor is worse than one retry that also fails.

      The class name is logged and nothing else, the same line
      `index.js`'s top-level guard draws: a storage error's message can quote a
      key, and a key is the customer's own note path.
    */
    try {
      console.error("meeting_ingest", error instanceof Error ? String(error.name).slice(0, 64) : typeof error);
    } catch {
      console.error("meeting_ingest", "unknown");
    }
    return refusal(
      new MeetingRefusal(503, "unavailable", "this context's storage did not accept the write; retry with backoff")
    );
  }
}

function methodNotAllowed() {
  return json({ error: ERRORS.invalid, error_description: "that method is not allowed on this route" }, 405);
}

/**
 * `POST /meetings/sessions` — upsert one session.
 *
 * A complete session is not re-opened. The metadata of a finalized meeting
 * lives in its note, which its owner may have edited; folding a phone's stale
 * copy of the title back over it would let a client that reconnected an hour
 * late quietly rewrite a note. It is not an error either — the client is
 * replaying a log it correctly kept — so the ack says `complete` and the note
 * path, and the client stops.
 */
async function upsertSession(request, store, tier) {
  const body = await readJsonBody(request);
  if (!isMeetingId(body.id)) throw invalid("id must be a meeting id");

  let observed = null;
  const result = await updateSession(store, body.id, (current) => {
    observed = current;
    if (current && current.state === "complete") return null;
    let next = current ? foldMetadata(current, body) : openSession({ ...body, id: body.id });
    next = foldLog(next, body.events);
    return assertSessionWithinLimits(next);
  }, tier);
  return ack(store, result ? result.session : observed);
}

/**
 * `POST /meetings/sessions/:id/segments` — append transcript.
 *
 * Segments on an `idle` or `paused` session are accepted rather than refused:
 * the state machine is the client's business, transcription lags the audio, and
 * refusing a batch because a pause event arrived first would lose the words
 * spoken before it. Segments on a **complete** session are refused, because
 * that meeting is a note now and there is nothing left that would ever write
 * them out — losing them silently is the one outcome worth an error.
 */
async function appendSegments(request, store, id, tier) {
  const body = await readJsonBody(request);
  const segments = Array.isArray(body.segments) ? body.segments : null;
  if (!segments) throw invalid("segments must be an array");
  assertSegmentsWithinLimits(segments);
  const unusable = countUnusable(segments);

  const result = await updateSession(store, id, (current) => {
    if (!current) throw notFound();
    if (current.state === "complete") {
      throw invalid("this session is already complete; its transcript is in the note");
    }
    return assertSessionWithinLimits(fold(current, { type: "segments", segments }));
  }, tier);
  return ack(store, result.session, unusable ? { rejected: unusable } : {});
}

/** `POST /meetings/sessions/:id/notes` — replace the human's Markdown. */
async function replaceNotes(request, store, id, tier) {
  const body = await readJsonBody(request);
  const markdown = notesFrom(body);
  if (markdown === null) throw invalid("notes must be a string");
  assertEventWithinLimits({ type: "notes", markdown });

  const result = await updateSession(store, id, (current) => {
    if (!current) throw notFound();
    if (current.state === "complete") {
      throw invalid("this session is already complete; edit the note instead");
    }
    return fold(current, { type: "notes", markdown });
  }, tier);
  return ack(store, result.session);
}

/**
 * `POST /meetings/sessions/:id/finalize` — end the session and write the note.
 *
 * Three steps, in this order, and the order is the whole design:
 *
 * 1. **Claim.** The session moves to `finalizing` and the note path it will
 *    occupy is written into the record, under a conditional write. A second
 *    finalize racing the first loses that write and is told `meeting_conflict`
 *    rather than writing a second note — and a retry after a crash re-reads the
 *    *same* claimed path, so it overwrites its own note instead of scattering
 *    near-duplicates through the customer's bucket.
 * 2. **Write the note.** `renderMeetingNote` produces one file — summary, the
 *    human's notes, and the transcript appended under `## Transcript` — and
 *    `publishNote` decides its visibility from `privacy.md` and records the
 *    audit event.
 * 3. **Receipt.** The record becomes a small completion receipt carrying the
 *    note path and its etag, and the transcript is dropped from it: the note is
 *    canonical and a second copy in the customer's bucket is somebody else's
 *    storage bill.
 *
 * The gateway does not enhance. A summary needs a model, and this worker has no
 * npm dependencies, no key, and no business sending a customer's meeting
 * anywhere they did not choose — so `enhanced` arrives from the client that did
 * it, and a meeting with none gets the note's own placeholder. It is
 * regenerable by definition, so nothing is lost either way.
 */
async function finalizeSession(request, store, session, id, publishNote) {
  const body = await readJsonBody(request);

  let alreadyComplete = null;
  const claim = await updateSession(store, id, async (current) => {
    if (!current) throw notFound();
    if (current.state === "complete") {
      alreadyComplete = current;
      return null;
    }
    let next = foldMetadata(current, body);
    if (typeof body.enhanced === "string") {
      assertEventWithinLimits({ type: "enhanced", markdown: body.enhanced });
      next = fold(next, { type: "enhanced", markdown: body.enhanced, templateId: body.templateId });
    }
    next = foldLog(next, body.events);
    if (next.state !== "finalizing") {
      const at = typeof body.endedAt === "string" ? body.endedAt : new Date().toISOString();
      next = fold(next, { type: "end", at });
    }
    if (!next.notePath) {
      let candidate;
      try {
        candidate = meetingNotePath(next);
      } catch {
        // The path is derived from `startedAt`, and a record whose timestamp
        // somebody edited by hand cannot produce one. That is a refusal the
        // owner can act on, not a storage failure to retry forever.
        throw invalid("this session's start time is not a timestamp, so it has no note path");
      }
      next = { ...next, notePath: await unclaimedNotePath(store, candidate) };
    }
    return assertSessionWithinLimits(next);
  }, session.scope);

  // Idempotent by the contract: answer with the note that was already written.
  if (alreadyComplete) return ack(store, alreadyComplete, { etag: alreadyComplete.noteEtag ?? undefined });

  // Marked complete *before* it is rendered, so the note's own frontmatter says
  // what the meeting is rather than what it was in the middle of. The path is
  // the one the claim reserved, which is what makes the `written` fold legal
  // here and the retry above land on the same file.
  const complete = fold(claim.session, { type: "written", notePath: claim.session.notePath });
  const published = await writeNoteFor(store, session, complete, publishNote);

  let receipt = completionReceipt(complete, published.path, published.etag);
  let stored = await writeSession(store, receipt, claim.etag);
  if (stored === false) {
    // Somebody wrote to this record between the claim and the note.
    const fresh = await readSession(store, id, session.scope);
    if (fresh?.session.state === "complete") {
      // The other writer finalized first. Answer with their note rather than
      // overwriting a meeting that is already closed.
      return ack(store, fresh.session, { etag: fresh.session.noteEtag ?? undefined });
    }
    if (fresh) {
      const merged = fold(fresh.session, { type: "written", notePath: published.path });
      /*
        A segment batch that landed between the claim and the note write is in
        the record and not in the file. Folding it into a receipt that drops the
        transcript would lose those words permanently — the one failure a
        meeting recorder may not have — so the note is written again over the
        path this session already claimed, which is ours to overwrite.
      */
      const republished =
        merged.transcript.length > complete.transcript.length
          ? await writeNoteFor(store, session, merged, publishNote)
          : published;
      receipt = completionReceipt(merged, republished.path, republished.etag);
    }
    stored = await writeSession(store, receipt, fresh ? fresh.etag : null);
  }
  if (stored === false) {
    throw new MeetingRefusal(409, "conflict", "this session changed while it was being finalized");
  }
  return ack(store, receipt, { etag: receipt.noteEtag });
}

/** Render one session and hand it to the note writer `index.js` owns. */
function writeNoteFor(store, session, meeting, publishNote) {
  return publishNote(store, session.scope, {
    path: meeting.notePath,
    markdown: renderMeetingNote(meeting),
    segmentCount: meeting.transcript.length,
  });
}

/**
 * The path this meeting will occupy, avoiding one that is already taken.
 *
 * `meetingNotePath` already ends in a short form of the session id, so a
 * collision means either a retry of this same session — which reuses the path
 * out of the record and never reaches here — or a note somebody else's tooling
 * put there. Suffixing rather than overwriting mirrors `uniqueSessionPath` in
 * `index.js`: a gateway that overwrites an unrelated note to file a meeting has
 * destroyed something no version history of ours can give back.
 */
async function unclaimedNotePath(store, candidate) {
  if (!(await store.get(candidate))) return candidate;
  return candidate.replace(/\.md$/, `-${crypto.randomUUID().slice(0, 8)}.md`);
}

/**
 * `GET /meetings/sessions/:id`
 *
 * The transcript is omitted unless it is asked for, for the reason
 * `read_meeting` omits it: forty minutes of speech is about forty kilobytes,
 * and a client checking whether its session is still alive should not have to
 * download the meeting to find out. `?transcript=true` includes it.
 */
async function readOneSession(request, store, id, tier) {
  const record = await readSession(store, id, tier);
  if (!record) throw notFound();
  const url = new URL(request.url);
  const wanted = url.searchParams.get("transcript");
  const body = { session: sessionSummary(record.session), etag: record.etag };
  if (wanted === "true" || wanted === "1") body.transcript = record.session.transcript;
  return json(body);
}

/** `GET /meetings/sessions` — what this context has recorded, newest first. */
async function listMeetingSessions(request, store, tier) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 20);
  const { records, scanned } = await listSessions(store, Number.isFinite(limit) ? limit : 20, tier);
  return json({
    sessions: records.map(sessionSummary),
    /**
     * A floor, never a total: the scan is bounded, and it counts only the
     * meetings this connection's tier may see — so it cannot be subtracted
     * from anything to learn how many private ones were filtered out.
     */
    scanned,
  });
}
