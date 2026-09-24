/**
 * `MeetingsController`'s snapshot/typing half: the event reducer (`apply`),
 * typed notes and title, the activity-control token, and the small snapshot
 * helpers (`set`, `setEnding`, `setTranscribing`, `find`, `nowIso`, `require`).
 *
 * Split out of `controller.ts` the same way `lifecycle.ts` is — see its
 * header for the mechanism (`applyMixins`, `controller/shape.ts`) and the
 * guarantee (no behaviour change, only file location).
 */
import type { MeetingsControllerShape } from "./shape";
import { emptyAck, type MeetingRecord } from "../record";
import { type MeetingEvent, foreignSegmentSessions } from "../protocol";
import { applyMeetingEvent, isLive } from "../session";
import { type MeetingsSnapshot, type ConfigureInput } from "./types";

function constantTimeEqual(expected: string, supplied: string): boolean {
  if (expected.length !== supplied.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The transcript rows an event carries, for the address check in `apply`.
 *
 * Both spellings, because both reach the reducer: a live recorder emits one
 * `segment` at a time and a replay folds a `segments` batch. Everything else is
 * an empty list, so the check costs one `Array.isArray` on a `notes` keystroke.
 */
function segmentsIn(event: MeetingEvent): unknown[] {
  if (event.type === "segment") return [event.segment];
  if (event.type === "segments") return Array.isArray(event.segments) ? event.segments : [];
  return [];
}

export class SnapshotTypingMixin {

  /**
   * The human's own Markdown.
   *
   * Never rewritten by anything else in this feature — "it is theirs and is
   * never rewritten by the enhancement pass" — and never read back into the
   * text input the person is typing in. See `NotesPad`.
   */
  setNotes(this: MeetingsControllerShape, meetingId: string, markdown: string): void {
    this.apply(meetingId, { type: "notes", markdown });
  }

  setTitle(this: MeetingsControllerShape, meetingId: string, title: string): void {
    this.apply(meetingId, { type: "title", title });
    this.updateMeetingActivity(meetingId);
  }

  /** Mirror the controller's truth into optional native lock-screen chrome. */
  updateMeetingActivity(this: MeetingsControllerShape, meetingId: string): void {
    const record = this.find(meetingId);
    if (record === undefined || !isLive(record.session.state)) return;
    let controlToken: string;
    try {
      controlToken = this.activityToken();
    } catch {
      // A control surface without a cryptographic capability is unsafe.
      this.activityControlTokens.delete(meetingId);
      this.activity.end(meetingId);
      return;
    }
    this.activityControlTokens.set(meetingId, controlToken);
    this.activity.update({
      meetingId,
      controlToken,
      title: record.session.title,
      phase: record.session.state === "paused" ? "paused" : "recording",
      // `recordedMs` is the closed intervals; the native timer adds the open
      // interval beginning at `runningSince` without double-counting it.
      recordedMs: record.session.recordedMs,
      recordingSince:
        record.session.state === "recording" && record.runningSince !== null
          ? Date.parse(record.runningSince)
          : null,
    });
  }

  /** Atomically verify and consume the current lock-screen control capability. */
  consumeActivityControl(this: MeetingsControllerShape, meetingId: string, suppliedToken: string): boolean {
    if (this.snapshot.live?.session.id !== meetingId) return false;
    const expected = this.activityControlTokens.get(meetingId);
    if (expected === undefined || !constantTimeEqual(expected, suppliedToken)) return false;
    this.activityControlTokens.delete(meetingId);
    return true;
  }

  invalidateMeetingActivity(this: MeetingsControllerShape, meetingId: string): void {
    this.activityControlTokens.delete(meetingId);
    this.activity.end(meetingId);
  }

  /* ------------------------------- internals ------------------------------ */

  /** The one path by which a session changes. */
  apply(this: MeetingsControllerShape, meetingId: string, event: MeetingEvent): void {
    const config = this.config;
    if (config === null) return;
    const before = this.projections.get(meetingId);
    if (before === undefined) return;

    /*
      WORDS ARE FOLDED INTO THE MEETING THAT PRODUCED THEM, OR INTO NOTHING.

      The envelope says which meeting this event is for; the segment's own id
      says which meeting minted it. When those disagree the id is right — see
      `segmentSessionId` in the contract — and the disagreement is a bug in
      whatever routed the event, never a reason to write one meeting's
      transcript into another's note.

      Refused loudly and dropped, rather than re-addressed: a segment belonging
      to a meeting this record is not is not this record's to keep, and quietly
      moving it would resurrect a meeting somebody may have finished with. The
      line names both meetings and the count and carries **no text**, because
      the whole failure is about whose words these are and the words themselves
      are the one thing a log may not hold.
    */
    const misaddressed = foreignSegmentSessions(meetingId, segmentsIn(event));
    if (misaddressed.length > 0) {
      console.warn(
        `meeting_segment_misaddressed to=${meetingId} from=${misaddressed.join(",")} kind=${event.type}`,
      );
      return;
    }

    const after = applyMeetingEvent(before, event);
    // Identity, not deep equality: `applyMeetingEvent` returns the same object
    // for a refused move, so this is exactly "the reducer refused" and costs
    // nothing to check.
    if (after === before) return;
    this.projections.set(meetingId, after);

    const existing = this.find(meetingId);
    const record: MeetingRecord = {
      version: 1,
      workspaceId: config.workspaceId,
      session: after.session,
      // Carried, not re-derived: every event rebuilds this record, and a
      // destination that survived only the first one would be dropped by the
      // `start` event immediately after it was set. The same goes for what the
      // gateway said about it — the `written` event that arrives from a
      // finalize would otherwise erase the flag that came back with it.
      destination: existing?.destination ?? null,
      ...(existing?.folderRejected === true ? { folderRejected: true as const } : {}),
      // Carried for `folderRejected`'s reason, and one of its own: the `end`
      // that closes an interrupted recording is itself an event through here,
      // so a flag set beside it would be erased by the fold that set it.
      ...(existing?.interrupted === true ? { interrupted: true as const } : {}),
      // Carried for the same reason, and the cost of dropping it is worse: a
      // part that forgot what it continues is filed as a second note of the
      // same meeting. `meetingsResume.test.ts` fails if this goes.
      ...(existing?.continues === undefined ? {} : { continues: existing.continues }),
      acked: existing?.acked ?? emptyAck(),
      runningSince: after.runningSince,
      updatedAt: config.now?.() ?? Date.now(),
      attempts: existing?.attempts ?? 0,
      rejection: existing?.rejection,
      lastError: existing?.lastError,
    };
    // A state change is written through; typing is debounced. See the header.
    this.put(record, { immediate: event.type !== "notes" && event.type !== "title" });
  }

  find(this: MeetingsControllerShape, meetingId: string): MeetingRecord | undefined {
    return this.snapshot.records.find((record) => record.session.id === meetingId);
  }

  nowIso(this: MeetingsControllerShape): string {
    return new Date(this.config?.now?.() ?? Date.now()).toISOString();
  }

  require(this: MeetingsControllerShape): ConfigureInput {
    if (this.config === null) {
      throw new Error("MeetingsController used before configure()");
    }
    return this.config;
  }

  /**
   * Publish, or withdraw, "this device is stopping that recording".
   *
   * A no-op when nothing changes, because `end()` clears it unconditionally in
   * a `finally` and every `set` wakes every subscriber — a notification that
   * carries no new fact is a render of the recording bar and both meeting
   * screens for nothing.
   */
  setEnding(this: MeetingsControllerShape, meetingId: string | null): void {
    if (this.snapshot.ending === meetingId) return;
    this.set({ ...this.snapshot, ending: meetingId });
  }

  /** The same, for the wait after the meeting has ended. See the field. */
  setTranscribing(this: MeetingsControllerShape, meetingId: string | null): void {
    if (this.snapshot.transcribing === meetingId) return;
    this.set({ ...this.snapshot, transcribing: meetingId });
  }

  set(this: MeetingsControllerShape, snapshot: MeetingsSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
