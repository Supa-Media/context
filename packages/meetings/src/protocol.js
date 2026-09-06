// The contract between every meeting client and the gateway.
//
// Three clients capture meetings — the phone, the desktop app, and (soon) the
// watch — and one gateway writes them into the customer's own bucket. This file
// is the only place that says what a meeting *is*, so a change here is a change
// every surface has to agree to. Implementations live in sibling modules; the
// types, the wire shapes and the endpoint names live here.
//
// Plain ESM with JSDoc types rather than TypeScript: the gateway is a
// dependency-free Workers bundle and imports this directly, and Metro and
// esbuild both take it as-is.

/** Protocol version. Bumped when a client and gateway can no longer agree. */
export const PROTOCOL_VERSION = 1;

// --- the meeting -----------------------------------------------------------

/**
 * The kinds of meeting a note may say it was.
 *
 * A frozen list rather than only a JSDoc union, because a union is invisible at
 * runtime and every consumer that had to check one wrote its own copy —
 * `SOURCE_KINDS` in session.js was one, and a list kept in two files is a list
 * that drifts. Order is the union's; the first entry is not a default and
 * `unknown` is.
 *
 * @type {readonly MeetingSource["kind"][]}
 */
export const MEETING_SOURCE_KINDS = Object.freeze([
  "in-person",
  "zoom",
  "meet",
  "teams",
  "slack-huddle",
  "webex",
  "discord",
  "facetime",
  "phone",
  "unknown",
]);

/**
 * What a transcript segment may be labelled as coming from. See
 * `MEETING_SOURCE_KINDS` for why this is exported rather than only described.
 *
 * @type {readonly TranscriptSegment["channel"][]}
 */
export const TRANSCRIPT_CHANNELS = Object.freeze(["mic", "system", "mixed"]);

/**
 * The engines that may have produced a meeting's words.
 *
 * A note has to say how it was made — `transcription: on-device` means the
 * audio never left the machine, `transcription: cloud` means it was streamed to
 * a service that is neither the customer nor us. That is the one place this
 * product's promise needs a footnote, and the footnote belongs in the document
 * somebody opens eight months later rather than in their billing history.
 *
 * **The third legal value is `null`, and it is not in this list.** `null` is
 * *no engine* — a meeting somebody typed and never recorded, which is a real
 * and common session rather than a missing field — so it is the absence of a
 * member, not a member. Putting it in a frozen list of engines would make every
 * membership check answer "yes, null is an engine", which is exactly the null
 * sentinel this repo does not do. `MeetingSession.transcription` is therefore
 * `TranscriptionEngine|null`, required and explicit: a session carries the
 * answer, and "nobody said" is not one of the answers it may carry.
 *
 * @type {readonly TranscriptionEngine[]}
 */
export const TRANSCRIPTION_ENGINES = Object.freeze(["on-device", "cloud"]);

/**
 * @typedef {"on-device"|"cloud"} TranscriptionEngine
 */

/**
 * The platforms a client may say it is. `watchos` is here because the watch is
 * a remote control that identifies itself, not because it records.
 *
 * @type {readonly MeetingDevice["platform"][]}
 */
export const DEVICE_PLATFORMS = Object.freeze([
  "ios",
  "android",
  "web",
  "macos",
  "windows",
  "linux",
  "watchos",
]);

/**
 * Where the audio came from. `kind` is what the note says; `app` and `url` are
 * the evidence the detector had, kept so a wrong guess can be explained.
 *
 * @typedef {Object} MeetingSource
 * @property {"in-person"|"zoom"|"meet"|"teams"|"slack-huddle"|"webex"|"discord"|"facetime"|"phone"|"unknown"} kind
 * @property {string} [app]              Application name the detector matched.
 * @property {string} [url]              Conference URL, when a browser tab gave one.
 * @property {string} [calendarEventId]  Calendar event this was correlated to.
 */

/**
 * @typedef {Object} Attendee
 * @property {string} name
 * @property {string} [email]
 * @property {boolean} [self]     True for the person holding the device.
 * @property {"calendar"|"platform"|"manual"|"diarization"} [via]
 */

/**
 * One utterance. `id` is client-generated and stable: re-sending a segment must
 * not duplicate it, because a phone that lost signal mid-meeting will re-send.
 *
 * @typedef {Object} TranscriptSegment
 * @property {string} id
 * @property {number} startMs      Milliseconds from session start.
 * @property {number} endMs
 * @property {string} text
 * @property {string|null} speaker Diarization label, or null when unknown.
 * @property {"mic"|"system"|"mixed"} channel
 * @property {number|null} confidence  0..1, or null when the engine gives none.
 */

/**
 * @typedef {Object} MeetingDevice
 * @property {"ios"|"android"|"web"|"macos"|"windows"|"linux"|"watchos"} platform
 * @property {string} [name]      Human-readable device name, for "which device recorded this".
 * @property {string} [appVersion]
 */

/**
 * A moment the wearer marked, mid-sentence, without breaking eye contact.
 *
 * `flag` is the verb that only exists because of the wrist, and this is where
 * one lands. `WatchCommand` had it and `WatchState` counted them and nothing
 * carried one: there was no `flag` event and no field on the session, so a
 * press could not reach the note it was pressed for.
 *
 * **`at` is milliseconds from the start of the session, computed at press time
 * on the device that pressed.** Not on arrival: the transport between a watch
 * and a phone is intermittent by design, so a queued command can drain a minute
 * late — and a flag timestamped on arrival lands on the wrong sentence, which
 * is the one thing a flag has to get right. It is the same clock
 * `TranscriptSegment.startMs` uses, which is what lets the note put a flag
 * beside the turn it belongs to.
 *
 * @typedef {Object} MeetingFlag
 * @property {number} at        Milliseconds from session start, at press time.
 * @property {string} [label]   At most `WATCH_FLAG_LABEL_MAX` characters.
 */

/**
 * `notes` is what the human typed — it is theirs and is never rewritten by the
 * enhancement pass. `enhanced` is the generated note, and it is regenerable, so
 * losing it is never data loss.
 *
 * @typedef {Object} MeetingSession
 * @property {string} id                 See {@link isMeetingId}.
 * @property {number} version            PROTOCOL_VERSION the client wrote with.
 * @property {string} title
 * @property {MeetingState} state
 * @property {string} startedAt          ISO 8601, UTC, with a `Z`.
 * @property {string|null} endedAt
 * @property {number} recordedMs         Audio actually captured, excluding pauses.
 * @property {MeetingSource} source
 * @property {Attendee[]} attendees
 * @property {string} notes              The human's own Markdown.
 * @property {TranscriptSegment[]} transcript
 * @property {MeetingFlag[]} flags       Moments the wearer marked, oldest first.
 *   Additive and deduped on `at`, so a replayed log does not double them.
 * @property {string|null} enhanced      Generated Markdown, null until enhanced.
 * @property {string|null} templateId    Enhancement template used.
 * @property {MeetingDevice} device
 * @property {TranscriptionEngine|null} transcription  Which engine produced the
 *   words, and `null` when nothing did. Never absent: an absent key and
 *   `transcription: none` are the same sentence to a reader, and only one of
 *   them is a promise the note is keeping. It is set when the session is opened
 *   — like `device`, and for the same reason — because the recorder that is
 *   about to run is what knows where the audio is going.
 * @property {string|null} notePath      Bucket path once written, else null.
 * @property {string|null} failureReason Why the session is in `failed`, and null
 *   in every other state: it is set on the way into `failed` and cleared on the
 *   way out, so a session that says it failed and a session that carries a
 *   reason are the same session. A client that wants to keep a capture problem
 *   visible after the meeting recovered — a refused microphone, an interrupted
 *   recorder — is holding a fact about the *device*, which is client-local
 *   state and does not belong on the session that lands in somebody's bucket.
 * @property {string|null} [recordingSince] The open recording span: when the
 *   current stretch of capture began, or null when nothing is running. Derived
 *   state — a holder that loses it rebuilds it by replaying the log — and the
 *   reason `recordedMs` can count audio rather than wall clock across a pause.
 *   The gateway persists it with the session because it is the thing that holds
 *   the fold *between* requests; a client that carries it beside the session
 *   instead is doing the same thing under another name.
 * @property {Object<string, number>} [appliedAt] Per event type, the newest `at`
 *   already folded in, so an event no newer than that is dropped rather than
 *   re-run. Also derived, also persisted, and the whole of why replaying an
 *   offline log twice is a no-op.
 */

/*
 * WHAT IS CLIENT-LOCAL, AND IS NOT A SESSION FIELD
 *
 * A client knows things about its own requests that are not facts about the
 * meeting, and the two have to stay apart or the record that lands in the
 * customer's bucket starts describing a phone.
 *
 * The one worth naming, because a person genuinely sees it: **"the gateway
 * accepted the finalize, and the note is not in the bucket yet."** That is a
 * real state on a device — the phone draws the meeting as still on the device
 * rather than saved — and it is not a `MeetingState`. It is the client's own
 * bookkeeping about a request it made: it has no place in `MeetingSession`, it
 * is never sent, and there is deliberately no transition for it. `notePath` is
 * the only answer to "is this meeting in the bucket", it comes from the
 * gateway, and a client that inferred it from its own request would be claiming
 * a write it never saw land.
 *
 * The same goes for a capture problem — a refused microphone, a recorder
 * interrupted by a phone call. That is a fact about the device, not about the
 * meeting, and putting it in `failureReason` would either lose it one event
 * later or leave a session marked `failed` that is not.
 */

/**
 * @typedef {"idle"|"recording"|"paused"|"finalizing"|"complete"|"failed"} MeetingState
 */

/**
 * Legal transitions. A client that cannot make its move here has a bug, and the
 * reducer refuses rather than guessing.
 *
 * Three of these moves are here because a client genuinely needs them, and each
 * was reached by a client faking an event to get around the table — which is
 * the shape of a table that is wrong rather than of a client that is:
 *
 *  - **`idle -> finalizing`.** A meeting nobody recorded is still a meeting: the
 *    person typed notes and never got audio, because they said no to the
 *    microphone or because there was never anything to capture. Their typed
 *    words are the one thing in a meeting that cannot be regenerated, so
 *    refusing to write them out until a synthetic `start` has been forged would
 *    lose the only copy of the only irreplaceable half. The note renders with
 *    `_No transcript was captured._`, which `note.js` already writes on purpose.
 *  - **`finalizing -> recording`.** A finalize the gateway has not answered yet
 *    is not a finished meeting. The person is still in the room and presses
 *    record again; the alternative was a client fabricating a `fail` to get
 *    back, which puts a failure nobody had into the record. Safe by
 *    construction: `complete` is a separate state and is terminal, and finalize
 *    reuses the note path it already claimed, so a re-finalize rewrites one note.
 *  - **`failed -> finalizing`.** A recording that failed mid-meeting holds a
 *    partial transcript, and that partial transcript is somebody's meeting.
 *    Without this move the only way out of `failed` is to record again, so a
 *    session that cannot record again can never be written out at all — the one
 *    outcome a meeting recorder may not have.
 *
 * `complete` stays terminal, and nothing returns from it: once the note is in
 * the customer's bucket, the note is the meeting and it is edited as a note.
 *
 * @type {Readonly<Record<MeetingState, readonly MeetingState[]>>}
 */
export const MEETING_TRANSITIONS = Object.freeze({
  idle: ["recording", "finalizing", "failed"],
  recording: ["paused", "finalizing", "failed"],
  paused: ["recording", "finalizing", "failed"],
  finalizing: ["recording", "complete", "failed"],
  complete: [],
  failed: ["recording", "finalizing"],
});

/**
 * Session events, applied by `applyEvent` in session.js. Every one is
 * idempotent or additive: replaying the log must land on the same session,
 * because an offline client replays its log on reconnect.
 *
 * **`written` is the one event a client may never send.** It is the gateway's
 * own: the gateway is the only party that can know a note exists, and `written`
 * is the event that moves a session to `complete`. A client able to send it
 * could mark a meeting finished that was never written out — the session would
 * answer `complete` with a note path pointing at nothing, and the recording
 * would be lost in silence, which is the one outcome this feature exists to
 * prevent. Clients *fold* the `written` the gateway sends back; the gateway
 * refuses one that arrives from a client, and that refusal is a security
 * control rather than a tidiness rule.
 *
 * @typedef {{type:"start", at:string}
 *   | {type:"pause", at:string}
 *   | {type:"resume", at:string}
 *   | {type:"segment", segment:TranscriptSegment}
 *   | {type:"segments", segments:TranscriptSegment[]}
 *   | {type:"flag", at:number, label?:string}
 *   | {type:"notes", markdown:string}
 *   | {type:"title", title:string}
 *   | {type:"attendee", attendee:Attendee}
 *   | {type:"source", source:MeetingSource}
 *   | {type:"end", at:string}
 *   | {type:"enhanced", markdown:string, templateId:string}
 *   | {type:"written", notePath:string}
 *   | {type:"fail", at:string, reason:string}} MeetingEvent
 */

/**
 * The events a client is allowed to send, which is every one above except
 * `written`.
 *
 * Exported frozen and consulted by the gateway rather than restated there: the
 * refusal above is only worth as much as the list it is checked against, and a
 * list kept in two files is a list that will one day have `written` in it in
 * one of them.
 *
 * @type {readonly string[]}
 */
export const CLIENT_EVENT_TYPES = Object.freeze([
  "start",
  "pause",
  "resume",
  "segment",
  "segments",
  "flag",
  "notes",
  "title",
  "attendee",
  "source",
  "end",
  "enhanced",
  "fail",
]);

/** The events only the gateway may emit. See `CLIENT_EVENT_TYPES`. */
export const GATEWAY_EVENT_TYPES = Object.freeze(["written"]);

// --- identity --------------------------------------------------------------

/** Session ids are `mtg_` plus 20 lowercase base32 characters. */
export const MEETING_ID_PREFIX = "mtg_";

/**
 * Crockford's base32 without `i`, `l`, `o` and `u`, so an id read aloud or
 * re-typed off a screen survives.
 *
 * Exported because two clients mint ids and both had their own copy of this
 * string — session.js's `MEETING_ID_ALPHABET` and the phone's `ALPHABET` — each
 * with a comment saying nothing would notice them drifting from the regex
 * below. Now nothing can: the regex is built from this.
 */
export const MEETING_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Characters after the prefix. */
export const MEETING_ID_LENGTH = 20;

const MEETING_ID_RE = new RegExp(
  `^${MEETING_ID_PREFIX}[${MEETING_ID_ALPHABET}]{${MEETING_ID_LENGTH}}$`
);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isMeetingId(value) {
  return typeof value === "string" && MEETING_ID_RE.test(value);
}

// --- the wire --------------------------------------------------------------

/**
 * Gateway routes, relative to the workspace root the caller is authenticated
 * for.
 *
 * The collection and one session are **different paths**, because they answer
 * different questions and one GET cannot do both. `sessions` is the collection:
 * POST upserts one session into it, GET lists the recent ones. `session(id)`
 * is one session: GET reads it back. Reading one wants the id in the path, and
 * this file said so in two names that were the same string until the day
 * somebody believed it.
 *
 * Ingestion is idempotent end to end: the same session id upserts, the same
 * segment id replaces, and finalize on an already-complete session returns the
 * note path it already wrote rather than writing a second note.
 */
export const ROUTES = Object.freeze({
  /** POST /meetings/sessions — upsert one session. GET — list recent ones. */
  sessions: "/meetings/sessions",
  /** GET /meetings/sessions/:id — read one session back. */
  session: (id) => `/meetings/sessions/${id}`,
  /** POST /meetings/sessions/:id/segments — append transcript segments. */
  segments: (id) => `/meetings/sessions/${id}/segments`,
  /** POST /meetings/sessions/:id/notes — replace the human's Markdown. */
  notes: (id) => `/meetings/sessions/${id}/notes`,
  /** POST /meetings/sessions/:id/finalize — end, enhance, write to the bucket. */
  finalize: (id) => `/meetings/sessions/${id}/finalize`,
});

/**
 * WHAT GOES ON THE WIRE.
 *
 * The routes above name the paths; these name the bodies, which were left to be
 * read out of a gateway implementation until now — so a second client had to
 * guess at the one thing a contract exists to settle.
 *
 * Every POST answers with an `IngestAck`, or with one of the `ERRORS` codes and
 * a `error_description`. Every body is a JSON object; an empty body is "no
 * fields", which is exactly what a bare finalize is.
 *
 * @typedef {Partial<MeetingSession> & {id: string, events?: MeetingEvent[], markdown?: string}} SessionUpsert
 *   `POST /meetings/sessions`. The id is required and is the client's own — the
 *   same id upserts. Everything else is optional and a field the body does not
 *   carry leaves the stored value alone, because a phone re-sending what it
 *   knows after a reconnect must not erase a title the watch set.
 *
 *   `state` is deliberately **not** one of them: every state move needs the
 *   client's own timestamp to be replay-safe, so moves arrive in `events` —
 *   the log the client is keeping anyway — as `start`, `pause`, `resume`,
 *   `end` and `fail`. `markdown` is accepted as a synonym for `notes`, because
 *   that is what the event calls it.
 *
 * @typedef {Object} SegmentsBody
 * @property {TranscriptSegment[]} segments  `POST …/segments`. Merged by id, so
 *   re-sending a batch after a timeout nobody saw the answer to is free.
 *
 * @typedef {Object} NotesBody
 * @property {string} [notes]     `POST …/notes`. The human's Markdown, wholesale.
 * @property {string} [markdown]  The event's name for the same field; either.
 *
 * @typedef {Object} FinalizeBody
 * @property {string} [endedAt]      `POST …/finalize`. Defaults to the gateway's
 *   clock only when the client sent no `end` event and no time of its own.
 * @property {string} [enhanced]     The generated summary. The gateway does not
 *   enhance — it has no model and no key — so this arrives from the client that
 *   did, and a meeting with none gets the note's own placeholder.
 * @property {string} [folder]       Where this meeting's note goes: the folder
 *   the person picked on the device, replacing `MEETINGS_FOLDER` whole.
 *   `paths.js` owns what a legal one is (`normalizeMeetingFolder`) and the
 *   bound (`MAX_FOLDER_LENGTH`).
 *
 *   **Optional is load-bearing.** A body that carries no `folder` gets the
 *   default path byte for byte, because the meetings list screen's one-tap
 *   record sends exactly that and a new field must not move where it files.
 *
 *   **It is read on the finalize that claims the path, and only then.** The
 *   note path is written into the session record under a conditional write and
 *   reused by every retry, so a second finalize naming a different folder
 *   answers with the note that exists rather than writing a second one. That is
 *   idempotency, not a special case for this field: a meeting is one note, and
 *   moving it afterwards is `move_note`'s job, which is also the only way it
 *   stays moved.
 *
 *   **A folder the gateway will not file into does not lose the meeting.** It
 *   falls back to `MEETINGS_FOLDER`, and the ack says `folderRejected` so the
 *   client can tell — the same shape as a segment batch's `rejected` count, for
 *   the same reason: `meeting_invalid` is the code a client does not retry, so
 *   refusing the request would park a whole meeting over one bad string. The
 *   refusal never quotes the value back.
 * @property {string} [templateId]
 * @property {MeetingEvent[]} [events]
 * @property {string} [title]
 * @property {MeetingSource} [source]
 * @property {Attendee[]} [attendees]
 * @property {string} [notes]
 *
 * @typedef {Object} SessionRead
 * @property {MeetingSessionSummary} session  `GET /meetings/sessions/:id`.
 * @property {string} [etag]                  Of the session record, not of a note.
 * @property {TranscriptSegment[]} [transcript]  Only with `?transcript=true`:
 *   forty minutes of speech is about forty kilobytes, and a client checking
 *   whether its session is still alive should not have to download the meeting.
 *
 * @typedef {Object} SessionList
 * @property {MeetingSessionSummary[]} sessions  `GET /meetings/sessions`, newest
 *   first. `?limit=` bounds it.
 * @property {number} scanned  Records **returned** to this caller — not records
 *   read. **A floor, never a total**: the scan is bounded, and the count is
 *   taken after the caller's tier has filtered it, so it is not a count of the
 *   meetings in the context and must never be drawn as one. Reporting the raw
 *   scan width would hand a team connection an exact count of the private
 *   meetings it was just filtered out of. It therefore carries no information
 *   beyond `sessions.length` today, and a client that needs to know its page
 *   was thinned needs a cursor rather than this number.
 *
 * @typedef {Object} MeetingSessionSummary
 * @property {string} id
 * @property {number} version
 * @property {string} title
 * @property {MeetingState} state
 * @property {string} startedAt
 * @property {string|null} endedAt
 * @property {number} recordedMs
 * @property {MeetingSource} source
 * @property {Attendee[]} attendees
 * @property {MeetingDevice} device
 * @property {TranscriptionEngine|null} transcription  As on the session: a
 *   client listing what it recorded can tell where each meeting's audio went
 *   without opening the note.
 * @property {number} segmentCount   The transcript is never in a summary.
 * @property {string|null} notePath
 * @property {string|null} failureReason
 */

/**
 * What every route answers with.
 *
 * `conflictSafe` is the part that is easy to leave out and must not be. R2 and
 * AWS S3 honour a conditional put; Backblaze B2 and Wasabi accept the header
 * and write anyway, so on those backends a session is written last-writer-wins.
 * The rule is that the guarantee is never *silently* dropped — so the ack says,
 * on every request, whether this bucket can do it at all, and a client that is
 * not getting conflict safety is told rather than left to assume the guarantee
 * it read about. An ack with no way to report a degraded write is an ack that
 * makes the gateway claim a guarantee it does not have.
 *
 * @typedef {Object} IngestAck
 * @property {string} sessionId
 * @property {MeetingState} state
 * @property {number} segmentCount     Segments the gateway now holds.
 * @property {string|null} notePath
 * @property {boolean} conflictSafe    Whether this bucket honours a conditional
 *   write. False is not an error: it is this context's storage, degraded
 *   honestly and said out loud.
 * @property {number} [rejected]       Rows of a segment batch the merge could
 *   not use — no id, no text, a clock that ran backwards. Present only when
 *   some were dropped, so a client can tell forty-nine stored from fifty.
 * @property {boolean} [folderRejected] **The folder this finalize named is not
 *   where this note is.** Two ways that happens, and the contract states both
 *   because a second client must not have to guess the second: the folder is
 *   one this gateway will not file into, so the note went to the default; *or*
 *   the folder was perfectly legal and a different one had already been claimed
 *   — a second finalize naming somewhere else, or a retry after a failed note
 *   write — so the note is where the claim put it, which is neither the default
 *   nor the folder on this request.
 *
 *   **This line used to describe only the first case**, while `folderFlag` in
 *   the gateway has always set the flag for both, and `handleMeetings`' own
 *   header states the wider rule. A client trusting the narrow version tells
 *   somebody "this is the default folder" over a note that is nowhere near it,
 *   which is exactly what the phone's screen said until this was corrected. The
 *   field *name* stays narrow-sounding and that is fine: "rejected" is what a
 *   client does about it either way.
 *
 *   Present only when it happened, and carrying no copy of what was sent.
 *   Without it the destination control would be back to appearing to work and
 *   doing nothing — which is the whole reason the field exists rather than a
 *   nicety.
 * @property {string} [etag]           Bucket etag of the written note.
 */

/**
 * Every gateway error carries one of these, so clients can retry correctly.
 *
 * **There is deliberately no not-found code, and there must not be one.** A
 * session id from another workspace, an id that never existed, and an id whose
 * record its owner deleted are one answer: HTTP 404 carrying `forbidden`. They
 * are not distinguishable to the gateway even in principle — the store it holds
 * was built for exactly one workspace, so another workspace's id is simply an
 * id its bucket does not have — and a code that told them apart would turn the
 * route into an existence oracle over every meeting anybody has ever recorded.
 * A client cannot act on the difference either: the response to all three is to
 * stop sending this session.
 */
export const ERRORS = Object.freeze({
  /** Malformed body. Do not retry unchanged. */
  invalid: "meeting_invalid",
  /**
   * Not yours, or not writable by this grant — and also the answer for an id
   * that does not exist here. See above: unknown, another workspace's, and
   * deleted are one code with one status.
   */
  forbidden: "meeting_forbidden",
  /** Bucket write lost a conditional put. Re-read and retry. */
  conflict: "meeting_conflict",
  /** Storage is down. Retry with backoff; the client keeps its log. */
  unavailable: "meeting_unavailable",
});

// --- detection -------------------------------------------------------------

/**
 * What a desktop poll observed. Deliberately dumb data: the platform-specific
 * code collects it, and every judgement is made by pure functions in detect.js
 * so the rules are testable without a running meeting.
 *
 * @typedef {Object} DetectionSignals
 * @property {string} now                     ISO 8601.
 * @property {string[]} processes             Process or bundle names.
 * @property {WindowSignal[]} windows
 * @property {boolean} microphoneInUse        Another app holds the mic.
 * @property {CalendarEvent[]} calendarEvents Events near `now`.
 */

/**
 * @typedef {Object} WindowSignal
 * @property {string} app
 * @property {string} title
 * @property {string} [url]      Browser tabs only.
 * @property {boolean} [focused]
 */

/**
 * @typedef {Object} CalendarEvent
 * @property {string} id
 * @property {string} title
 * @property {string} startsAt
 * @property {string} endsAt
 * @property {Attendee[]} attendees
 * @property {string} [conferenceUrl]
 */

/**
 * @typedef {Object} DetectionResult
 * @property {boolean} detected
 * @property {number} confidence          0..1.
 * @property {MeetingSource} source
 * @property {string} reason              Why, in words, for the tray tooltip and the logs.
 * @property {string|null} suggestedTitle
 * @property {Attendee[]} suggestedAttendees
 */

/**
 * Hysteresis state. A meeting app that flickers for one poll must not start a
 * recording, and a two-second network blip must not end one.
 *
 * @typedef {Object} DetectorState
 * @property {boolean} active
 * @property {number} positives   Consecutive polls that saw a meeting.
 * @property {number} negatives   Consecutive polls that did not.
 * @property {MeetingSource|null} source
 * @property {string|null} since
 */

/** Polls of agreement before a detector fires or clears. */
export const DETECTOR_THRESHOLDS = Object.freeze({
  pollMs: 5000,
  toActive: 2,
  toInactive: 4,
  /** A calendar event counts as "now" from this long before it starts... */
  calendarLeadMs: 5 * 60 * 1000,
  /** ...until this long after it ends. */
  calendarTrailMs: 15 * 60 * 1000,
});

// --- the watch -------------------------------------------------------------

/**
 * The watch is a remote control, never a recorder: it has no microphone worth
 * using and no room for a transcript. It sends commands and renders state.
 *
 * **Every command about an existing session names it.** A watch shows the
 * session it last heard about, and a wrist is reachable when a pocket is not:
 * the transport drops, the phone starts a second meeting, and the pause the
 * wearer presses on a stale face would land on a meeting they are not looking
 * at. So `sessionId` is on the command, the phone refuses one that does not
 * name the session it is actually running, and "the phone is the authority"
 * becomes something the wire can be checked against rather than a sentence in a
 * design document. `start` carries none because there is nothing to name yet —
 * the phone mints the id.
 *
 * **The verb is `end`, not `stop`.** The wrist and the event log now say one
 * word for one transition; `stop` was a second name for `MeetingEvent`'s `end`
 * across a boundary, which is the drift this file exists to prevent. The watch
 * UI may still say "Stop" to a wearer — a label is not a protocol.
 *
 * A command is a **request**. The phone's state machine may refuse it per
 * `MEETING_TRANSITIONS`, and a refusal is the correct outcome, never a state
 * the watch performs on its own.
 *
 * @typedef {{type:"start", title?:string}
 *   | {type:"end", sessionId:string}
 *   | {type:"pause", sessionId:string}
 *   | {type:"resume", sessionId:string}
 *   | {type:"flag", sessionId:string, at:number, label?:string}} WatchCommand
 */

/**
 * What the phone pushes to the watch face, the complication and the Live
 * Activity. Small on purpose: this crosses a constrained transport.
 *
 * @typedef {Object} WatchState
 * @property {string|null} sessionId
 * @property {MeetingState} state
 * @property {string} title
 * @property {number} elapsedMs
 * @property {number} flags        How many moments the wearer has marked — a
 *   count, not a list: the wearer needs to know the press registered, not to
 *   read back what they flagged. It is `MeetingSession.flags.length`.
 * @property {boolean} reachable   Phone is in range and recording is live.
 */

/**
 * The longest label a flag may carry.
 *
 * A flag is folded into the note as a `> [!flag]` callout beside the turn it
 * was pressed during — `MeetingFlag`, and `note.js` renders it — so the label
 * is a few words on a wrist, not a note of its own.
 */
export const WATCH_FLAG_LABEL_MAX = 40;
