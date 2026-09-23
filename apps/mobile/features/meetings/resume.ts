import type { MeetingDestination } from "./destination";
import { meetingNoteFacts } from "./note";
import type { MeetingContinuation, MeetingRecord } from "./record";

/**
 * WHEN A STOPPED MEETING IS OFFERED BACK, AND WHAT PICKING IT UP CONTINUES.
 *
 * Three surfaces offer Resume — the note, the meeting's own page with the
 * console's panel, and the floating bar — and every one of them asks the
 * questions here rather than answering them itself. A control that appears on
 * a meeting it cannot actually continue is worse than no control, and deciding
 * that per surface is how the console once came to offer nothing for states
 * the note screen had always offered a Retry for (`landing.ts`).
 *
 * ## Which meetings can be picked back up
 *
 * One that is **saved**: its note is in the bucket. That is the ordinary case
 * and it includes a recording the device cut short, which files itself
 * (`recoverInterruptedRecordings`) and is the case the feature is most for.
 *
 * Not one that is **still on its way or stuck**. A part that has not landed
 * belongs to the red bar and its Retry, and piling a second part on top of a
 * first that is not in the note would splice them out of order — or into a
 * note that does not exist yet.
 *
 * Not one that **captured nothing**. `empty` has no note and nothing to
 * continue; the offer there is a new meeting, which the page already makes.
 *
 * And none of it while **anything is recording**: one device records one
 * meeting, and the recording in progress is the one that must not be
 * interrupted.
 *
 * Nothing here imports a screen or a router, for `route.ts`'s reason.
 */

/** The meeting a record is part of: its own id, or the first part's when it continues one. */
export function meetingIdOf(record: MeetingRecord): string {
  return record.continues?.meetingId ?? record.session.id;
}

/** Whether any part of this meeting is still recording, being written, or stuck. */
function partInFlight(records: readonly MeetingRecord[], meetingId: string): boolean {
  return records.some(
    (record) =>
      meetingIdOf(record) === meetingId &&
      record.session.state !== "complete" &&
      record.session.state !== "empty",
  );
}

/**
 * The newest part of this meeting that landed, or `null`.
 *
 * Newest by when it stopped, because the next part continues from the end of
 * the last one — resuming from the first part's page after a second part
 * landed must still start at the end of the second.
 */
export function latestLandedPart(
  records: readonly MeetingRecord[],
  meetingId: string,
): MeetingRecord | null {
  let latest: MeetingRecord | null = null;
  for (const record of records) {
    if (meetingIdOf(record) !== meetingId) continue;
    if (record.session.state !== "complete" || record.session.notePath === null) continue;
    if (latest === null || stoppedAt(record) > stoppedAt(latest)) latest = record;
  }
  return latest;
}

function stoppedAt(record: MeetingRecord): number {
  const at = Date.parse(record.session.endedAt ?? record.session.startedAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * Whether this meeting may be offered for resuming on this device right now.
 *
 * `canContinue` is the writer's answer (`MeetingsGateway.canContinue`): a
 * writer that cannot add a part to the note would file the part as a second
 * note, and an offer that says "same file, one meeting" may not be made over
 * it.
 */
export function mayResume(input: {
  records: readonly MeetingRecord[];
  live: MeetingRecord | null;
  canContinue: boolean;
  meetingId: string;
}): boolean {
  if (!input.canContinue || input.live !== null) return false;
  return !partInFlight(input.records, input.meetingId);
}

/**
 * What resuming continues, from this device's own record of the meeting.
 *
 * Built from the newest part that landed, so the clocks of the next part begin
 * where the last one ended. The note itself is the better answer when it is to
 * hand — another device may have added a part this one never saw — and
 * `continuationFromNote` is that answer; this is for the surfaces that hold a
 * record and not the file.
 */
export function continuationFromRecord(
  records: readonly MeetingRecord[],
  record: MeetingRecord,
): MeetingContinuation | null {
  const meetingId = meetingIdOf(record);
  const latest = latestLandedPart(records, meetingId);
  if (latest === null || latest.session.notePath === null) return null;
  return {
    path: latest.session.notePath,
    meetingId,
    offsetMs: (latest.continues?.offsetMs ?? 0) + latest.session.recordedMs,
    previousEndedAt: latest.session.endedAt,
    part: (latest.continues?.part ?? 1) + 1,
  };
}

/**
 * What resuming continues, from the note itself: the file is the meeting.
 *
 * `null` for a note that is not a meeting note — which is what keeps the offer
 * off every other note in somebody's context.
 */
export function continuationFromNote(
  path: string,
  markdown: string,
): { continues: MeetingContinuation; title: string } | null {
  const facts = meetingNoteFacts(markdown);
  if (facts === null) return null;
  return {
    continues: {
      path,
      meetingId: facts.meetingId,
      offsetMs: facts.recordedMs,
      previousEndedAt: facts.endedAt,
      part: facts.parts + 1,
    },
    title: facts.title,
  };
}

/**
 * The offer drawn on an open meeting note, as the note's pane needs it.
 *
 * The pane is the console's, and the console's file pane is rendered on the
 * landing page and by two fixtures as well, none of which has a meeting
 * recorder behind it. So the pane is handed this — built by the console
 * layout, which holds the controller — rather than importing the recorder into
 * a module graph that has no business with a microphone. `VoiceHost` carries
 * it, for the reason it carries `onRecordMeeting`.
 */
export interface NoteResumeOffer {
  /** How much of the meeting the note holds. */
  recordedMs: number;
  /** Which part pressing it would record — 2 for a note with one. */
  part: number;
  onResume: () => void;
}

/**
 * Where a part started from the note is addressed: the context the note is
 * in, and the note's own folder.
 *
 * The folder only matters if the note is gone by the time the part is written
 * — the part is then filed as a note of its own, and beside where the first
 * one was is the least surprising place for it.
 */
export function destinationForNote(contextSlug: string, path: string): MeetingDestination {
  const slash = path.lastIndexOf("/");
  return {
    kind: "currentPage",
    contextSlug: contextSlug.startsWith("@") ? contextSlug.slice(1) : contextSlug,
    folder: slash === -1 ? "" : path.slice(0, slash),
    label: "The meeting's note",
  };
}

/**
 * How long after a meeting stops the floating bar keeps offering it.
 *
 * The bar is the impatient offer. The note and the meeting's page offer Resume
 * for as long as the meeting exists — one from March can still be continued —
 * but a bar that follows somebody around the app is for the break in the
 * middle of a meeting, and a meeting that stopped hours ago is not on a break.
 */
export const RESUME_BAR_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * The meeting the floating bar offers to pick back up, or `null`.
 *
 * The most recent meeting on this device, and only if it is the one that most
 * recently stopped: recording something else is what retires the offer, so the
 * bar never offers a meeting from before the one somebody just had. Then the
 * same rules as everywhere else, the person's own dismissal, and the window.
 */
export function resumeBarOffer(input: {
  records: readonly MeetingRecord[];
  live: MeetingRecord | null;
  canContinue: boolean;
  now: number;
}): MeetingRecord | null {
  let newest: MeetingRecord | null = null;
  for (const record of input.records) {
    const started = Date.parse(record.session.startedAt);
    if (!Number.isFinite(started)) continue;
    if (newest === null || started > Date.parse(newest.session.startedAt)) newest = record;
  }
  if (newest === null) return null;
  if (newest.session.state !== "complete" || newest.session.notePath === null) return null;
  if (newest.resumeDismissed === true) return null;
  if (input.now - stoppedAt(newest) > RESUME_BAR_WINDOW_MS) return null;
  if (
    !mayResume({
      records: input.records,
      live: input.live,
      canContinue: input.canContinue,
      meetingId: meetingIdOf(newest),
    })
  ) {
    return null;
  }
  return newest;
}

/** How much of a meeting this device knows was recorded, across its parts. */
export function recordedSoFarMs(record: MeetingRecord): number {
  return (record.continues?.offsetMs ?? 0) + record.session.recordedMs;
}
