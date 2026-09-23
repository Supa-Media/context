import type { MeetingDestination } from "./destination";
import type { ContinueInput } from "./controller";
import { endedAgo } from "./format";
import { meetingNoteFacts } from "./note";
import type { MeetingContinuation, MeetingRecord } from "./record";

/**
 * WHEN A STOPPED MEETING IS OFFERED BACK, AND WHAT PICKING IT UP CONTINUES.
 *
 * Two places offer Resume — the meeting itself (its page on a phone, the
 * console's Meetings panel) and the `+`, where a meeting is started — and both
 * ask the questions here rather than answering them itself. Nothing else does:
 * no bar follows somebody around and no band sits on the note, because an
 * offer that costs nothing until somebody reaches to record never needs a
 * dismiss (`docs/decisions/meetings.md`). A control that appears on
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
 * How long after a meeting stops the `+` keeps offering it by name.
 *
 * The row exists for the break in the middle of a meeting: somebody reaching
 * for New meeting when the meeting they stopped ten minutes ago is starting
 * again. A meeting that stopped hours ago is not on a break, and is still one
 * press away on its own page, in the panel, and from the `+` with its note open.
 */
export const RESUME_RECENT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * The most recent meeting on this device, if it may be picked back up, or
 * `null`.
 *
 * Only the one that most recently started: recording something else is what
 * retires the offer, so the `+` never names a meeting from before the one
 * somebody just had. Then the same rules as everywhere else, and the window.
 */
export function recentMeetingToResume(input: {
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
  if (input.now - stoppedAt(newest) > RESUME_RECENT_WINDOW_MS) return null;
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

/** What the `+`'s Resume row needs: the line under it, and what pressing it continues. */
export interface ResumeRow {
  detail: string;
  input: ContinueInput;
}

/**
 * The `+`'s Resume meeting row, or `null` for no row.
 *
 * The open note first: when it is a meeting note that may be continued, the
 * row continues *it* — which also covers a meeting another device recorded,
 * one this device holds no record of. Otherwise the meeting that just stopped
 * (`recentMeetingToResume`), named, so the row says which meeting it means.
 */
export function resumeRowFor(input: {
  records: readonly MeetingRecord[];
  live: MeetingRecord | null;
  canContinue: boolean;
  now: number;
  openNote: { contextSlug: string; path: string; markdown: string } | null;
}): ResumeRow | null {
  const rules = { records: input.records, live: input.live, canContinue: input.canContinue };
  if (input.openNote !== null) {
    const found = continuationFromNote(input.openNote.path, input.openNote.markdown);
    if (found !== null && mayResume({ ...rules, meetingId: found.continues.meetingId })) {
      return {
        detail: "Adds to this note.",
        input: {
          continues: found.continues,
          title: found.title,
          destination: destinationForNote(input.openNote.contextSlug, input.openNote.path),
        },
      };
    }
  }
  const recent = recentMeetingToResume({ ...rules, now: input.now });
  if (recent === null) return null;
  const continues = continuationFromRecord(input.records, recent);
  if (continues === null) return null;
  const ago = endedAgo(recent.session.endedAt, input.now);
  return {
    detail: ago === "" ? recent.session.title : `${recent.session.title} · ${ago}`,
    input: { continues, title: recent.session.title, destination: recent.destination },
  };
}

/**
 * One row per meeting, for the lists: the newest part stands for the meeting.
 *
 * A resumed meeting is one meeting in one note, and a list that drew a row per
 * part would show the same title twice, both opening the same file. Order is
 * kept — the records arrive newest first, so the first part of each meeting
 * met is its newest.
 */
export function oneRowPerMeeting(records: readonly MeetingRecord[]): MeetingRecord[] {
  const seen = new Set<string>();
  const rows: MeetingRecord[] = [];
  for (const record of records) {
    const id = meetingIdOf(record);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(record);
  }
  return rows;
}

/** How much of a meeting this device knows was recorded, across its parts. */
export function recordedSoFarMs(record: MeetingRecord): number {
  return (record.continues?.offsetMs ?? 0) + record.session.recordedMs;
}
