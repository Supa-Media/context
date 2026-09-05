// The meeting reducer.
//
// Every client — phone, desktop, watch — keeps an append-only log of events and
// replays it at the gateway when it reconnects. That is the whole reason this
// file is a pure fold rather than a mutable object: `applyEvent` must be safe
// to run over the same log twice and land on the same session, or a client that
// dropped its wifi in the middle of a meeting corrupts the note it comes back
// to.
//
// Two fields exist for that replay and for nothing else, and the note renderer
// ignores both:
//
//   `recordingSince`  the open recording span, so `recordedMs` counts audio and
//                     not wall-clock time across a pause.
//   `appliedAt`       per event type, the newest `at` already folded in. An
//                     event no newer than that has already been applied, so it
//                     is dropped rather than re-run. Both are derived state: a
//                     client that loses them can rebuild them by replaying.
//
// The contract names both of them now — they were this file's private
// bookkeeping while the gateway was persisting them with every session, which
// is a field on the wire whichever file declares it.
//
// An illegal transition throws. It is a client bug, and a reducer that guessed
// would turn it into a wrong note that nobody notices.

import {
  DEVICE_PLATFORMS,
  ERRORS,
  MEETING_ID_ALPHABET,
  MEETING_ID_LENGTH,
  MEETING_ID_PREFIX,
  MEETING_SOURCE_KINDS,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  WATCH_FLAG_LABEL_MAX,
  isMeetingId,
} from "./protocol.js";
import { mergeSegments } from "./transcript.js";

/** @typedef {import("./protocol.js").MeetingSession} MeetingSession */
/** @typedef {import("./protocol.js").MeetingEvent} MeetingEvent */
/** @typedef {import("./protocol.js").MeetingState} MeetingState */
/** @typedef {import("./protocol.js").MeetingSource} MeetingSource */
/** @typedef {import("./protocol.js").Attendee} Attendee */

/** What a meeting is called before anybody, or any detector, names it. */
export const DEFAULT_TITLE = "Untitled meeting";

/*
  The three lists this file used to keep its own copies of. They are the
  contract's now — `MEETING_SOURCE_KINDS`, `DEVICE_PLATFORMS` and the id
  alphabet — and are turned into `Set`s here only because that is what a
  membership check wants. `Object.freeze` does not stop a `Set` being added to,
  so the frozen thing stays the array in protocol.js and this is a local view of
  it.
*/
const SOURCE_KINDS = new Set(MEETING_SOURCE_KINDS);

const PLATFORMS = new Set(DEVICE_PLATFORMS);

/** Thrown when a client asks for a move `MEETING_TRANSITIONS` does not allow. */
export class MeetingTransitionError extends Error {
  /**
   * @param {MeetingState} from
   * @param {MeetingState} to
   */
  constructor(from, to) {
    super(`illegal meeting transition: ${from} -> ${to}`);
    this.name = "MeetingTransitionError";
    /** Maps straight onto the wire error, so the gateway does not translate. */
    this.code = ERRORS.invalid;
    this.from = from;
    this.to = to;
  }
}

/** Thrown when an event is malformed — a missing timestamp, an unknown type. */
export class MeetingEventError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MeetingEventError";
    this.code = ERRORS.invalid;
  }
}

/**
 * Bytes for `newMeetingId`. Web Crypto on the Workers runtime, in Electron and
 * in a modern React Native; the `Math.random` branch is a last resort so this
 * module never fails to load on a host that lacks it. Meeting ids are not
 * secrets — they are addressed inside an already-authenticated workspace — so
 * that fallback degrades collision resistance, not security.
 *
 * @param {number} n
 * @returns {Uint8Array}
 */
function defaultRandom(n) {
  const bytes = new Uint8Array(n);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/**
 * A new session id.
 *
 * The alphabet has exactly 32 characters, so `byte % 32` is uniform over a
 * uniform byte and no rejection sampling is needed. `random` is injected so a
 * test can pin the output.
 *
 * @param {(n: number) => Uint8Array} [random]
 * @returns {string}
 */
export function newMeetingId(random = defaultRandom) {
  const bytes = random(MEETING_ID_LENGTH);
  if (!bytes || bytes.length < MEETING_ID_LENGTH) {
    throw new MeetingEventError(`randomness source returned ${bytes?.length ?? 0} of ${MEETING_ID_LENGTH} bytes`);
  }
  let out = MEETING_ID_PREFIX;
  for (let i = 0; i < MEETING_ID_LENGTH; i += 1) {
    out += MEETING_ID_ALPHABET[bytes[i] % MEETING_ID_ALPHABET.length];
  }
  return out;
}

/**
 * @param {unknown} at
 * @param {string} where
 * @returns {string} Normalized to UTC ISO 8601 with a `Z`, per the protocol.
 */
function toIso(at, where) {
  const parsed = typeof at === "string" || typeof at === "number" ? Date.parse(String(at)) : NaN;
  if (!Number.isFinite(parsed)) throw new MeetingEventError(`${where} is not an ISO 8601 timestamp`);
  return new Date(parsed).toISOString();
}

/**
 * @param {unknown} source
 * @returns {MeetingSource}
 */
export function normalizeSource(source) {
  const raw = source && typeof source === "object" ? /** @type {Record<string, unknown>} */ (source) : {};
  /** @type {MeetingSource} */
  const out = { kind: typeof raw.kind === "string" && SOURCE_KINDS.has(raw.kind) ? raw.kind : "unknown" };
  if (typeof raw.app === "string" && raw.app.trim()) out.app = raw.app.trim();
  if (typeof raw.url === "string" && raw.url.trim()) out.url = raw.url.trim();
  if (typeof raw.calendarEventId === "string" && raw.calendarEventId.trim()) {
    out.calendarEventId = raw.calendarEventId.trim();
  }
  return out;
}

/**
 * @param {unknown} attendee
 * @returns {Attendee|null}
 */
export function normalizeAttendee(attendee) {
  const raw = attendee && typeof attendee === "object" ? /** @type {Record<string, unknown>} */ (attendee) : null;
  if (!raw) return null;
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  // A calendar invite often carries an address and no display name. Falling
  // back to the address beats dropping the attendee entirely.
  const label = name || email;
  if (!label) return null;
  /** @type {Attendee} */
  const out = { name: label };
  if (email) out.email = email;
  if (raw.self === true) out.self = true;
  if (raw.via === "calendar" || raw.via === "platform" || raw.via === "manual" || raw.via === "diarization") {
    out.via = raw.via;
  }
  return out;
}

/** Identity for dedupe: the address when there is one, else the display name. */
function attendeeKey(attendee) {
  return attendee.email ? `e:${attendee.email}` : `n:${attendee.name.toLowerCase()}`;
}

/**
 * Additive union. The same person arriving twice — once from the calendar, once
 * from diarization — is one attendee with whichever fields are known.
 *
 * @param {Attendee[]} list
 * @param {Attendee} attendee
 * @returns {Attendee[]}
 */
function withAttendee(list, attendee) {
  const key = attendeeKey(attendee);
  const index = list.findIndex((existing) => attendeeKey(existing) === key);
  if (index === -1) return [...list, attendee];
  const merged = { ...list[index], ...attendee };
  // A name we already had is better than an address we just re-derived one from.
  if (list[index].name && attendee.name === attendee.email) merged.name = list[index].name;
  const next = [...list];
  next[index] = merged;
  return next;
}

/**
 * One flagged moment, or `null` when there is no usable offset in it.
 *
 * @param {unknown} flag
 * @returns {import("./protocol.js").MeetingFlag|null}
 */
export function normalizeFlag(flag) {
  const raw = flag && typeof flag === "object" ? /** @type {Record<string, unknown>} */ (flag) : {};
  const at = raw.at;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return null;
  /** @type {import("./protocol.js").MeetingFlag} */
  const out = { at: Math.round(at) };
  const label = typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim() : "";
  if (label) out.label = label.slice(0, WATCH_FLAG_LABEL_MAX);
  return out;
}

/**
 * Additive, deduped on `at`, oldest first.
 *
 * Deduped rather than appended because a client replays its log: the same press
 * arriving twice is one moment, and the offset is what identifies it. Two
 * presses inside the same millisecond would be one flag, which is a wrist, a
 * finger and a millisecond away from being a problem.
 *
 * The first one seen wins, so a replay cannot rewrite a label either.
 *
 * @param {import("./protocol.js").MeetingFlag[]} list
 * @param {import("./protocol.js").MeetingFlag} flag
 */
function withFlag(list, flag) {
  const existing = list ?? [];
  if (existing.some((entry) => entry.at === flag.at)) return existing;
  return [...existing, flag].sort((a, b) => a.at - b.at);
}

/**
 * @param {unknown} device
 * @returns {import("./protocol.js").MeetingDevice}
 */
function normalizeDevice(device) {
  const raw = device && typeof device === "object" ? /** @type {Record<string, unknown>} */ (device) : {};
  const out = { platform: typeof raw.platform === "string" && PLATFORMS.has(raw.platform) ? raw.platform : "web" };
  if (typeof raw.name === "string" && raw.name.trim()) out.name = raw.name.trim();
  if (typeof raw.appVersion === "string" && raw.appVersion.trim()) out.appVersion = raw.appVersion.trim();
  return /** @type {import("./protocol.js").MeetingDevice} */ (out);
}

/** @param {unknown} title */
function normalizeTitle(title) {
  // Newlines would break the `# <title>` heading the note is built around.
  const cleaned = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  return cleaned || DEFAULT_TITLE;
}

/**
 * A fresh session, `idle`, with everything the protocol requires present.
 *
 * @param {Partial<MeetingSession> & {random?: (n: number) => Uint8Array}} [input]
 * @returns {MeetingSession}
 */
export function createSession(input = {}) {
  const id = input.id ?? newMeetingId(input.random);
  if (!isMeetingId(id)) throw new MeetingEventError(`not a meeting id: ${JSON.stringify(id)}`);

  let attendees = [];
  for (const attendee of Array.isArray(input.attendees) ? input.attendees : []) {
    const normalized = normalizeAttendee(attendee);
    if (normalized) attendees = withAttendee(attendees, normalized);
  }

  return {
    id,
    version: PROTOCOL_VERSION,
    title: normalizeTitle(input.title),
    state: "idle",
    startedAt: toIso(input.startedAt ?? new Date().toISOString(), "startedAt"),
    endedAt: input.endedAt ? toIso(input.endedAt, "endedAt") : null,
    recordedMs: typeof input.recordedMs === "number" && input.recordedMs >= 0 ? Math.round(input.recordedMs) : 0,
    source: normalizeSource(input.source),
    attendees,
    notes: typeof input.notes === "string" ? input.notes : "",
    transcript: mergeSegments([], Array.isArray(input.transcript) ? input.transcript : []),
    flags: (Array.isArray(input.flags) ? input.flags : []).reduce((list, flag) => {
      const normalized = normalizeFlag(flag);
      return normalized ? withFlag(list, normalized) : list;
    }, /** @type {import("./protocol.js").MeetingFlag[]} */ ([])),
    enhanced: typeof input.enhanced === "string" ? input.enhanced : null,
    templateId: typeof input.templateId === "string" ? input.templateId : null,
    device: normalizeDevice(input.device),
    notePath: typeof input.notePath === "string" ? input.notePath : null,
    failureReason: typeof input.failureReason === "string" ? input.failureReason : null,
    recordingSince: null,
    appliedAt: {},
  };
}

/**
 * Has this event already been folded in?
 *
 * Per event type we keep the newest `at` seen. A second pass over the log
 * offers each event again with the same timestamp, which is not newer, so it is
 * dropped — while a genuinely new pause after an earlier one still lands. This
 * is what makes `applyLog(applyLog(s, log), log)` equal `applyLog(s, log)`.
 *
 * @param {MeetingSession} session
 * @param {string} type
 * @param {string} at
 */
function alreadyApplied(session, type, at) {
  const seen = session.appliedAt?.[type];
  return typeof seen === "number" && Date.parse(at) <= seen;
}

/** @param {MeetingSession} session */
function stamp(session, type, at) {
  return { ...session, appliedAt: { ...session.appliedAt, [type]: Date.parse(at) } };
}

/**
 * @param {MeetingSession} session
 * @param {MeetingState} target
 * @returns {MeetingState}
 */
function transitionTo(session, target) {
  // Landing where you already are is idempotent by construction, and the
  // transition table does not list self-edges.
  if (session.state === target) return target;
  const allowed = MEETING_TRANSITIONS[session.state] ?? [];
  if (!allowed.includes(target)) throw new MeetingTransitionError(session.state, target);
  return target;
}

/**
 * Close the open recording span at `at`, folding it into `recordedMs`.
 *
 * A negative span means the client's clock moved backwards between events;
 * counting zero is the only honest answer.
 *
 * @param {MeetingSession} session
 * @param {string} at
 */
function closeSpan(session, at) {
  if (!session.recordingSince) return { recordedMs: session.recordedMs, recordingSince: null };
  const span = Date.parse(at) - Date.parse(session.recordingSince);
  return {
    recordedMs: session.recordedMs + (Number.isFinite(span) && span > 0 ? span : 0),
    recordingSince: null,
  };
}

/**
 * Fold one event into a session and return a NEW session. The input is never
 * mutated, including its arrays.
 *
 * @param {MeetingSession} session
 * @param {MeetingEvent} event
 * @returns {MeetingSession}
 */
export function applyEvent(session, event) {
  if (!session || typeof session !== "object") throw new MeetingEventError("applyEvent needs a session");
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new MeetingEventError("applyEvent needs an event with a type");
  }

  switch (event.type) {
    case "start": {
      const at = toIso(event.at, "start.at");
      if (alreadyApplied(session, "start", at)) return session;
      const state = transitionTo(session, "recording");
      // A second `start` while recording is a client that lost track of itself.
      // Restarting the span would inflate `recordedMs`, so only the stamp moves.
      if (session.state === "recording") return stamp(session, "start", at);
      return stamp(
        {
          ...session,
          state,
          // The first start defines when the meeting began; a restart after a
          // failure keeps the original, because that is what the note is filed
          // under and the path must not move.
          startedAt: session.state === "idle" ? at : session.startedAt,
          // A meeting that is recording again has not ended and is not failed.
          // `failureReason` describes the `failed` state and nothing else, and
          // `endedAt` would otherwise sit in the frontmatter of a note whose
          // meeting was still going on.
          endedAt: null,
          failureReason: null,
          recordingSince: at,
        },
        "start",
        at
      );
    }

    case "pause": {
      const at = toIso(event.at, "pause.at");
      if (alreadyApplied(session, "pause", at)) return session;
      const state = transitionTo(session, "paused");
      if (session.state === "paused") return stamp(session, "pause", at);
      return stamp({ ...session, state, ...closeSpan(session, at) }, "pause", at);
    }

    case "resume": {
      const at = toIso(event.at, "resume.at");
      if (alreadyApplied(session, "resume", at)) return session;
      const state = transitionTo(session, "recording");
      if (session.state === "recording") return stamp(session, "resume", at);
      return stamp({ ...session, state, failureReason: null, recordingSince: at }, "resume", at);
    }

    case "end": {
      const at = toIso(event.at, "end.at");
      if (alreadyApplied(session, "end", at)) return session;
      // The protocol promises finalize is idempotent end to end: a session that
      // already wrote its note answers with that note rather than re-ending.
      if (session.state === "complete") return session;
      const state = transitionTo(session, "finalizing");
      if (session.state === "finalizing") return stamp({ ...session, endedAt: at }, "end", at);
      // A failed recording being written out with what it captured is no longer
      // in `failed`, so it no longer carries a reason for being there.
      return stamp(
        { ...session, state, endedAt: at, failureReason: null, ...closeSpan(session, at) },
        "end",
        at
      );
    }

    case "segment":
      return { ...session, transcript: mergeSegments(session.transcript, [event.segment]) };

    case "segments": {
      if (!Array.isArray(event.segments)) throw new MeetingEventError("segments.segments must be an array");
      return { ...session, transcript: mergeSegments(session.transcript, event.segments) };
    }

    case "flag": {
      // No state moves and no transition is consulted: a flag is a mark on the
      // timeline, not a thing that happens to the recording. It is legal while
      // recording, while paused, and on a session that never recorded at all —
      // the wearer pressed the button, and refusing to carry that because the
      // state machine was somewhere else would lose the one thing the wrist is
      // for.
      const flag = normalizeFlag(event);
      if (!flag) throw new MeetingEventError("flag.at must be milliseconds from the session start");
      return { ...session, flags: withFlag(session.flags ?? [], flag) };
    }

    case "notes": {
      if (typeof event.markdown !== "string") throw new MeetingEventError("notes.markdown must be a string");
      // Last write wins, verbatim. This text is the human's and nothing in this
      // package rewrites it.
      return { ...session, notes: event.markdown };
    }

    case "title": {
      // Refused rather than coerced, for the same reason `notes` is: a client
      // sending the wrong shape should hear about it, not quietly rename
      // somebody's meeting to "Untitled meeting" — the note path is derived
      // from this.
      if (typeof event.title !== "string") throw new MeetingEventError("title.title must be a string");
      return { ...session, title: normalizeTitle(event.title) };
    }

    case "attendee": {
      const attendee = normalizeAttendee(event.attendee);
      if (!attendee) throw new MeetingEventError("attendee needs a name or an email");
      return { ...session, attendees: withAttendee(session.attendees, attendee) };
    }

    case "source":
      return { ...session, source: normalizeSource(event.source) };

    case "enhanced": {
      if (typeof event.markdown !== "string") throw new MeetingEventError("enhanced.markdown must be a string");
      // Regenerable by definition, so last write wins and no state moves: a
      // meeting can be re-enhanced with another template long after it closed.
      return {
        ...session,
        enhanced: event.markdown,
        templateId: typeof event.templateId === "string" ? event.templateId : session.templateId,
      };
    }

    case "written": {
      if (typeof event.notePath !== "string" || !event.notePath) {
        throw new MeetingEventError("written.notePath must be a non-empty string");
      }
      const state = transitionTo(session, "complete");
      return { ...session, state, notePath: event.notePath, recordingSince: null };
    }

    case "fail": {
      const at = toIso(event.at, "fail.at");
      if (typeof event.reason !== "string" || !event.reason) {
        throw new MeetingEventError("fail.reason must be a non-empty string");
      }
      // Deduped by its own clock like every other state-changing event. It used
      // to carry no timestamp, so a replay could only be recognised by the
      // reason it left behind — which meant `failureReason` had to survive a
      // restart to keep the reducer honest, and a session that had recovered
      // still said why it had once failed.
      if (alreadyApplied(session, "fail", at)) return session;
      const state = transitionTo(session, "failed");
      if (session.state === "failed") return stamp({ ...session, failureReason: event.reason }, "fail", at);
      // The open span is closed *at the failure*, not dropped and not left
      // open: the audio captured up to the moment the recorder died is audio
      // that was captured, and the seconds between the failure and a retry are
      // not.
      return stamp(
        { ...session, state, failureReason: event.reason, ...closeSpan(session, at) },
        "fail",
        at
      );
    }

    default:
      throw new MeetingEventError(`unknown meeting event: ${String(event.type)}`);
  }
}

/**
 * Fold a whole log. `applyLog(applyLog(s, log), log)` must deep-equal
 * `applyLog(s, log)` — that property is the reason this package exists in the
 * shape it does, and it is asserted in the tests.
 *
 * @param {MeetingSession} session
 * @param {MeetingEvent[]} events
 * @returns {MeetingSession}
 */
export function applyLog(session, events) {
  let next = session;
  for (const event of events ?? []) next = applyEvent(next, event);
  return next;
}

/**
 * Audio actually captured. Includes the span still open when a meeting is
 * asked about mid-recording, which is why `now` is a parameter.
 *
 * @param {MeetingSession} session
 * @param {string|number} [now]
 * @returns {number}
 */
export function recordedMsAt(session, now) {
  if (!session.recordingSince) return session.recordedMs;
  const at = now === undefined ? Date.now() : Date.parse(String(now));
  const span = at - Date.parse(session.recordingSince);
  return session.recordedMs + (Number.isFinite(span) && span > 0 ? span : 0);
}
