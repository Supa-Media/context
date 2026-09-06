import type { MeetingDestination } from "./destination";
import { MeetingGatewayError, type MeetingsGateway } from "./gateway";
import { ERRORS } from "./protocol";
import type {
  IngestAck,
  MeetingSession,
  MeetingSessionSummary,
  TranscriptSegment,
} from "./protocol";

/**
 * A gateway that keeps meetings in a `Map`, and refuses on request.
 *
 * The counterpart to `useDemoFileBrowser`: the real implementation's shape with
 * none of its transport, so the interesting cases are ordinary tests. It is
 * **not** a stub that always says yes — the cases worth covering are the ones
 * where it says no, and each is programmable:
 *
 *  - `failNext(code)` — refuse the next call with one of the protocol's codes,
 *    so a transient failure mid-drain and a permanent refusal are both drivable.
 *  - `offlineUntil(n)` — refuse the first `n` calls as `unavailable`, which is
 *    the phone-in-a-pocket case the queue exists for.
 *
 * It enforces the protocol's idempotency claims rather than assuming them,
 * which is what makes it worth writing: "the same session id upserts, the same
 * segment id replaces, and finalize on an already-complete session returns the
 * note path it already wrote rather than writing a second note". A test that
 * re-sends a batch and asserts one note path is asserting something real.
 */
export interface FakeGateway extends MeetingsGateway {
  /** Every session the fake gateway holds, by id. */
  readonly held: Map<string, MeetingSession>;
  /** Route names in the order they were called. */
  readonly calls: string[];
  /** Refuse the next call with this code. */
  failNext(code: string, message?: string): void;
  /** Refuse the next `count` calls as `unavailable`. */
  offlineFor(count: number): void;
  /** How many notes this gateway has written. Idempotency's observable. */
  notesWritten(): number;
}

export function fakeGateway(
  options: {
    notePathFor?: (session: MeetingSession, destination: MeetingDestination | null) => string;
  } = {},
): FakeGateway {
  const held = new Map<string, MeetingSession>();
  const segments = new Map<string, Map<string, TranscriptSegment>>();
  const calls: string[] = [];
  let queuedFailure: { code: string; message: string } | null = null;
  let offlineCalls = 0;
  let written = 0;

  /**
   * Where this fake writes a note.
   *
   * It **honours the folder it is handed**, which is the behaviour the real
   * gateway will have once `FinalizeBody` carries one (see `finalizeBody` in
   * `gateway.ts` for what is missing and where). A fake that ignored it could
   * not tell a client that threads the destination through from one that drops
   * it on the floor, which is the whole thing worth testing here.
   *
   * With no destination it is the gateway's own default, unchanged, so every
   * test written before this question existed still asserts what it did.
   */
  const notePathFor =
    options.notePathFor ??
    ((session: MeetingSession, destination: MeetingDestination | null) => {
      const folder = destination?.folder ?? "0-inbox";
      return folder === ""
        ? `meetings/${session.id}.md`
        : `${folder}/meetings/${session.id}.md`;
    });

  function gate(route: string): void {
    calls.push(route);
    if (offlineCalls > 0) {
      offlineCalls -= 1;
      throw new MeetingGatewayError(ERRORS.unavailable, "Your context could not be reached.");
    }
    if (queuedFailure !== null) {
      const failure = queuedFailure;
      queuedFailure = null;
      throw new MeetingGatewayError(failure.code, failure.message);
    }
  }

  function require(sessionId: string): MeetingSession {
    const session = held.get(sessionId);
    if (session === undefined) {
      throw new MeetingGatewayError(
        ERRORS.forbidden,
        "That meeting does not belong to this context.",
      );
    }
    return session;
  }

  function ack(session: MeetingSession): IngestAck {
    return {
      sessionId: session.id,
      state: session.state,
      segmentCount: segments.get(session.id)?.size ?? 0,
      notePath: session.notePath,
      /*
        A bucket that honours a conditional write, because that is the ordinary
        case and a fake that reported the degraded one everywhere would make
        every test assert the exception. `conflictSafe` is part of `IngestAck`
        now rather than an undocumented extra the real gateway happened to send.
      */
      conflictSafe: true,
    };
  }

  /** What the listing route answers with: no transcript, and a count instead. */
  function summarize(session: MeetingSession): MeetingSessionSummary {
    return {
      id: session.id,
      version: session.version,
      title: session.title,
      state: session.state,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      recordedMs: session.recordedMs,
      source: session.source,
      attendees: session.attendees,
      device: session.device,
      // Carried, like the device: a summary is what a client lists without
      // opening a note, and "where did this meeting's audio go" is exactly the
      // question a list should be able to answer.
      transcription: session.transcription,
      segmentCount: segments.get(session.id)?.size ?? session.transcript.length,
      notePath: session.notePath,
      failureReason: session.failureReason,
    };
  }

  return {
    held,
    calls,
    failNext(code, message = "refused") {
      queuedFailure = { code, message };
    },
    offlineFor(count) {
      offlineCalls = count;
    },
    notesWritten: () => written,

    async putSession(session) {
      gate("session");
      /*
        Upsert: the id is the identity, and a second write of the same id is the
        same meeting told again rather than a second meeting.

        **A client may not walk the session backwards.** `state` and `notePath`
        belong to the gateway once it has written the note, so a re-sent record
        that still says `finalizing` — which is exactly what a phone replaying
        its log after a lost connection sends — does not undo a `complete`. Not
        pedantry in a fake: without this rule the replay test passes and a
        second note is written into the customer's bucket, which is the failure
        the protocol's idempotency claim exists to prevent.
      */
      const already = held.get(session.id);
      const next: MeetingSession =
        already?.state === "complete"
          ? { ...session, state: already.state, notePath: already.notePath, enhanced: already.enhanced }
          : { ...session, notePath: already?.notePath ?? session.notePath };
      held.set(session.id, next);
      return ack(next);
    },

    async putSegments(sessionId, incoming) {
      gate("segments");
      const session = require(sessionId);
      const bucket = segments.get(sessionId) ?? new Map<string, TranscriptSegment>();
      // Replace by id, never append by arrival: a phone that lost signal
      // re-sends, and a duplicated utterance in somebody's note is the bug
      // this rule exists to prevent.
      for (const segment of incoming) bucket.set(segment.id, segment);
      segments.set(sessionId, bucket);
      return ack(session);
    },

    async putNotes(sessionId, markdown) {
      gate("notes");
      const session = require(sessionId);
      const next = { ...session, notes: markdown };
      held.set(sessionId, next);
      return ack(next);
    },

    async finalize(sessionId, destination) {
      gate("finalize");
      const session = require(sessionId);
      if (session.state === "complete" && session.notePath !== null) {
        // Already written. The path it already wrote, and no second note.
        // Deliberately before the destination is read: a re-finalize with a
        // different folder rewrites one note, it does not move or fork one.
        return ack(session);
      }
      written += 1;
      const next: MeetingSession = {
        ...session,
        state: "complete",
        notePath: notePathFor(session, destination),
        enhanced: session.enhanced ?? enhancedFrom(session),
      };
      held.set(sessionId, next);
      return ack(next);
    },

    async list() {
      gate("list");
      return [...held.values()]
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .map(summarize);
    },
  };
}

/**
 * A stand-in for the enhancement pass, and deliberately a dumb one.
 *
 * The real pass is the gateway's and is a language model's job. What a test in
 * this app needs from it is only that the finalized note *follows the shape of
 * what the human wrote* and keeps their words — so this echoes the notes under
 * a heading and says nothing clever. A cleverer fake would be a second, silent
 * specification of a feature this app does not own.
 */
function enhancedFrom(session: MeetingSession): string {
  return `## Summary\n\n${session.notes}\n`;
}
