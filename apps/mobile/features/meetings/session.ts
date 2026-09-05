import { MEETING_TRANSITIONS } from "./protocol";
import type {
  Attendee,
  MeetingDevice,
  MeetingEvent,
  MeetingSession,
  MeetingSource,
  MeetingState,
  TranscriptSegment,
} from "./protocol";

/**
 * The fold from a meeting's event log onto the session the screens render.
 *
 * ## Why this lives here and not in `@context/meetings`
 *
 * It should not. `protocol.js` names `applyEvent` in `session.js` as the
 * canonical reducer, and two implementations of one fold is exactly the
 * duplication this repo keeps paying for. This copy exists because the package
 * ships `protocol.js` and nothing else yet, and the phone cannot draw a
 * recording screen without a projection.
 *
 * So it is written to be **deleted**, not to be lived with:
 * `__tests__/meetingsSession.test.ts` fails the day `@context/meetings` starts
 * exporting `applyEvent`, and says to delete this file and import that one. The
 * rules below are the protocol's own words, not new decisions — every paragraph
 * of this header points at the sentence in `protocol.js` it implements.
 *
 * ## The three rules the protocol states, implemented here
 *
 * **"Every one is idempotent or additive: replaying the log must land on the
 * same session."** An offline client replays its log on reconnect, and the app
 * being killed mid-meeting means the log is re-read and re-folded from the
 * beginning. So `start` twice is one start, a segment id seen twice replaces
 * rather than appends, `notes` and `title` are wholesale replacements, and
 * `end` on an already-ended session changes nothing.
 *
 * **"A client that cannot make its move here has a bug, and the reducer refuses
 * rather than guessing."** A state event whose transition is not in
 * `MEETING_TRANSITIONS` returns the session **unchanged**. It does not throw:
 * this fold runs while restoring a log written by an older build, and taking
 * the app down on launch over one bad entry loses the whole meeting to save a
 * field. It does not guess a legal intermediate state either — that would
 * invent a pause nobody made. The UI never generates one, because every control
 * is drawn from `can()` below; the refusal is the backstop, and
 * `meetingsSession.test.ts` drives each illegal move.
 *
 * **`recordedMs` is "audio actually captured, excluding pauses".** It is
 * therefore derived from the log rather than counted by a timer: a timer stops
 * when the app is killed and a log does not, and the number has to survive
 * exactly that. Each `pause`/`end` closes the interval opened by the preceding
 * `start`/`resume` and adds its length. `runningSince` is the open interval's
 * start and is *not* part of `MeetingSession` — it is bookkeeping this fold
 * carries beside the session, so the wire shape stays the protocol's.
 *
 * ## The clock is an argument, never `Date.now()`
 *
 * Elapsed time is `recordedMs` plus however long the open interval has been
 * open, and the second half needs a "now". Passing it in is what makes a
 * 41-minute meeting a test that runs in a millisecond, and it is the same
 * choice `features/offline/sync.ts` makes with `deps.now`.
 */

/** The projection plus the one piece of bookkeeping the wire shape has no room for. */
export interface MeetingProjection {
  session: MeetingSession;
  /**
   * ISO timestamp the currently-open recording interval started at, or `null`
   * when nothing is running. See the header: this is what makes `recordedMs`
   * survive the app being killed.
   */
  runningSince: string | null;
}

export interface SeedInput {
  id: string;
  title: string;
  startedAt: string;
  source: MeetingSource;
  device: MeetingDevice;
  attendees?: Attendee[];
  /** The `PROTOCOL_VERSION` the client wrote with. */
  version: number;
}

/** A session in `idle`, before anything has been recorded into it. */
export function seedSession(input: SeedInput): MeetingSession {
  return {
    id: input.id,
    version: input.version,
    title: input.title,
    state: "idle",
    startedAt: input.startedAt,
    endedAt: null,
    recordedMs: 0,
    source: input.source,
    attendees: input.attendees ?? [],
    notes: "",
    transcript: [],
    enhanced: null,
    templateId: null,
    device: input.device,
    notePath: null,
    failureReason: null,
  };
}

export function seedProjection(input: SeedInput): MeetingProjection {
  return { session: seedSession(input), runningSince: null };
}

/** Whether `MEETING_TRANSITIONS` allows this move. The UI draws its controls from this. */
export function can(from: MeetingState, to: MeetingState): boolean {
  return MEETING_TRANSITIONS[from].includes(to);
}

/**
 * Apply one event.
 *
 * Returns the projection unchanged for a move `MEETING_TRANSITIONS` refuses —
 * see the header for why that is a refusal rather than a throw or a guess.
 */
export function applyMeetingEvent(
  projection: MeetingProjection,
  event: MeetingEvent,
): MeetingProjection {
  const { session } = projection;

  switch (event.type) {
    case "start": {
      // Idempotent: a log replayed from disk starts once. A `failed` session
      // may start again, which is the one legal re-entry `MEETING_TRANSITIONS`
      // allows and is how a refused finalize is retried.
      if (session.state === "recording") return projection;
      if (!can(session.state, "recording")) return projection;
      return {
        session: {
          ...session,
          state: "recording",
          // `startedAt` is the seed's and is not moved by a restart: it is when
          // the meeting began, not when capture last resumed.
          failureReason: null,
        },
        runningSince: event.at,
      };
    }

    case "pause": {
      if (!can(session.state, "paused")) return projection;
      return {
        session: { ...session, state: "paused", recordedMs: closed(projection, event.at) },
        runningSince: null,
      };
    }

    case "resume": {
      if (!can(session.state, "recording")) return projection;
      return { session: { ...session, state: "recording" }, runningSince: event.at };
    }

    case "end": {
      if (!can(session.state, "finalizing")) return projection;
      return {
        session: {
          ...session,
          state: "finalizing",
          endedAt: event.at,
          recordedMs: closed(projection, event.at),
        },
        runningSince: null,
      };
    }

    case "segment":
      return withSegments(projection, [event.segment]);

    case "segments":
      return withSegments(projection, event.segments);

    case "notes":
      // Wholesale replacement, and never touched by anything else in this file:
      // "`notes` is what the human typed — it is theirs and is never rewritten
      // by the enhancement pass."
      return { ...projection, session: { ...session, notes: event.markdown } };

    case "title":
      return { ...projection, session: { ...session, title: event.title } };

    case "attendee": {
      // Additive, and de-duplicated on the pair that identifies a person. Two
      // detectors reporting the same person — the calendar and the platform —
      // must not become two rows, and a replayed log must not double the list.
      const already = session.attendees.some((a) => sameAttendee(a, event.attendee));
      if (already) return projection;
      return {
        ...projection,
        session: { ...session, attendees: [...session.attendees, event.attendee] },
      };
    }

    case "source":
      return { ...projection, session: { ...session, source: event.source } };

    case "enhanced":
      // Deliberately does not move the state. Enhancement is one step of
      // finalizing and the session is `complete` only once the note is in the
      // bucket — `written` is what says so.
      return {
        ...projection,
        session: { ...session, enhanced: event.markdown, templateId: event.templateId },
      };

    case "written": {
      if (session.state === "complete") {
        // Idempotent: "finalize on an already-complete session returns the note
        // path it already wrote rather than writing a second note."
        return { ...projection, session: { ...session, notePath: event.notePath } };
      }
      if (!can(session.state, "complete")) return projection;
      return {
        ...projection,
        session: { ...session, state: "complete", notePath: event.notePath },
      };
    }

    case "fail": {
      if (!can(session.state, "failed")) return projection;
      /*
        The open interval is deliberately left open. A failure is not an end —
        `MEETING_TRANSITIONS` allows `failed -> recording`, which is how a
        refused finalize or a dropped recorder is retried — so closing the
        interval here would silently drop the seconds between the failure and
        the retry from `recordedMs`.
      */
      return {
        ...projection,
        session: { ...session, state: "failed", failureReason: event.reason },
      };
    }

    default:
      // `MeetingEvent` is a closed union, so this is only reachable from a log
      // written by a newer build. Unchanged rather than thrown: an event this
      // version does not understand is not a reason to lose the meeting.
      return projection;
  }
}

/** Fold a whole log. What a restore from disk and a replay on reconnect both do. */
export function projectLog(
  seed: MeetingProjection,
  events: readonly MeetingEvent[],
): MeetingProjection {
  return events.reduce(applyMeetingEvent, seed);
}

/**
 * How long this meeting has been recording, in milliseconds.
 *
 * `recordedMs` plus the open interval. `now` is an argument — see the header.
 */
export function elapsedMs(projection: MeetingProjection, now: number): number {
  const { session, runningSince } = projection;
  if (runningSince === null) return session.recordedMs;
  const open = now - Date.parse(runningSince);
  // A clock that went backwards (an NTP correction mid-meeting, a device whose
  // time was wrong until it found a network) must not make the counter run
  // backwards in front of somebody. It costs the seconds it corrected by.
  return session.recordedMs + Math.max(0, open);
}

/** Whether this meeting is still capturing, for the persistent bar. */
export function isLive(state: MeetingState): boolean {
  return state === "recording" || state === "paused";
}

/* -------------------------------------------------------------------------- */

function closed(projection: MeetingProjection, at: string): number {
  if (projection.runningSince === null) return projection.session.recordedMs;
  const open = Date.parse(at) - Date.parse(projection.runningSince);
  return projection.session.recordedMs + Math.max(0, open);
}

/**
 * Segments, upserted by id.
 *
 * "`id` is client-generated and stable: re-sending a segment must not duplicate
 * it, because a phone that lost signal mid-meeting will re-send." A later
 * version of the same id wins — that is how a provisional transcript is
 * corrected by a better pass over the same audio.
 *
 * The result is sorted by `startMs`, because segments do not always arrive in
 * order: a cloud transcriber returns a batch while an on-device pass is still
 * emitting, and a transcript that reads out of order is one nobody trusts.
 */
function withSegments(
  projection: MeetingProjection,
  incoming: readonly TranscriptSegment[],
): MeetingProjection {
  if (incoming.length === 0) return projection;
  const byId = new Map(projection.session.transcript.map((s) => [s.id, s]));
  for (const segment of incoming) byId.set(segment.id, segment);
  const transcript = [...byId.values()].sort(
    (a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id),
  );
  return { ...projection, session: { ...projection.session, transcript } };
}

function sameAttendee(a: Attendee, b: Attendee): boolean {
  if (a.email !== undefined && b.email !== undefined) {
    return a.email.toLowerCase() === b.email.toLowerCase();
  }
  return a.email === b.email && a.name === b.name;
}
