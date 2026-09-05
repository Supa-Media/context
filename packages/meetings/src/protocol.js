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
 * @property {string|null} enhanced      Generated Markdown, null until enhanced.
 * @property {string|null} templateId    Enhancement template used.
 * @property {MeetingDevice} device
 * @property {string|null} notePath      Bucket path once written, else null.
 * @property {string|null} failureReason
 */

/**
 * @typedef {"idle"|"recording"|"paused"|"finalizing"|"complete"|"failed"} MeetingState
 */

/**
 * Legal transitions. A client that cannot make its move here has a bug, and the
 * reducer refuses rather than guessing.
 *
 * @type {Readonly<Record<MeetingState, readonly MeetingState[]>>}
 */
export const MEETING_TRANSITIONS = Object.freeze({
  idle: ["recording", "failed"],
  recording: ["paused", "finalizing", "failed"],
  paused: ["recording", "finalizing", "failed"],
  finalizing: ["complete", "failed"],
  complete: [],
  failed: ["recording"],
});

/**
 * Session events, applied by `applyEvent` in session.js. Every one is
 * idempotent or additive: replaying the log must land on the same session,
 * because an offline client replays its log on reconnect.
 *
 * @typedef {{type:"start", at:string}
 *   | {type:"pause", at:string}
 *   | {type:"resume", at:string}
 *   | {type:"segment", segment:TranscriptSegment}
 *   | {type:"segments", segments:TranscriptSegment[]}
 *   | {type:"notes", markdown:string}
 *   | {type:"title", title:string}
 *   | {type:"attendee", attendee:Attendee}
 *   | {type:"source", source:MeetingSource}
 *   | {type:"end", at:string}
 *   | {type:"enhanced", markdown:string, templateId:string}
 *   | {type:"written", notePath:string}
 *   | {type:"fail", reason:string}} MeetingEvent
 */

// --- identity --------------------------------------------------------------

/** Session ids are `mtg_` plus 20 lowercase base32 characters. */
export const MEETING_ID_PREFIX = "mtg_";
const MEETING_ID_RE = /^mtg_[0-9a-hjkmnp-tv-z]{20}$/;

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
 * for. All are POST except `session`, which is also a GET.
 *
 * Ingestion is idempotent end to end: the same session id upserts, the same
 * segment id replaces, and finalize on an already-complete session returns the
 * note path it already wrote rather than writing a second note.
 */
export const ROUTES = Object.freeze({
  /** POST: upsert session metadata. GET: read one back. */
  session: "/meetings/sessions",
  /** POST /meetings/sessions/:id/segments — append transcript segments. */
  segments: (id) => `/meetings/sessions/${id}/segments`,
  /** POST /meetings/sessions/:id/notes — replace the human's Markdown. */
  notes: (id) => `/meetings/sessions/${id}/notes`,
  /** POST /meetings/sessions/:id/finalize — end, enhance, write to the bucket. */
  finalize: (id) => `/meetings/sessions/${id}/finalize`,
  /** GET /meetings/sessions — list recent sessions for this workspace. */
  list: "/meetings/sessions",
});

/**
 * @typedef {Object} IngestAck
 * @property {string} sessionId
 * @property {MeetingState} state
 * @property {number} segmentCount     Segments the gateway now holds.
 * @property {string|null} notePath
 * @property {string} [etag]           Bucket etag of the written note.
 */

/** Every gateway error carries one of these, so clients can retry correctly. */
export const ERRORS = Object.freeze({
  /** Malformed body. Do not retry unchanged. */
  invalid: "meeting_invalid",
  /** Session id belongs to another workspace, or the grant cannot write. */
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
 * @typedef {{type:"start", title?:string}
 *   | {type:"stop"}
 *   | {type:"pause"}
 *   | {type:"resume"}
 *   | {type:"flag", at:number, label?:string}} WatchCommand
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
 * @property {number} flags        Moments the wearer marked.
 * @property {boolean} reachable   Phone is in range and recording is live.
 */

/** Session-scoped moments the wearer flagged, folded into the note as `> [!flag]`. */
export const WATCH_FLAG_LABEL_MAX = 40;
