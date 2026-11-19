import { isMeetingNotePath } from "@context/meetings/paths";

import type { ListNote, PropertyValue } from "../console/files/listBlock/model";

/**
 * The meetings a workspace has notes for, read from the tree's parsed front
 * matter, for the Meetings panel's Past list (owner, 2026-11-19: "it should
 * show past meetings with a button to open up where the note lives").
 *
 * The panel used to list `snapshot.records` alone, which is the meetings
 * recorded *on this device*: a browser that recorded nothing showed none, while
 * every meeting the desktop app or the phone filed sat in the person's notes.
 * So a meeting is recognised where it lies, the way the gateway's
 * `list_meetings` recognises it (`apps/mcp/src/tools/meetings.js`):
 *
 *  - its front matter says `type: meeting`, which every recorder writes; or
 *  - it is a dated note in a folder named for meetings; or
 *  - it has the recorder's own name in the default folder.
 *
 * A date alone is never enough, for that file's reason: any dated note would
 * be called a meeting.
 */

export interface PastMeeting {
  /** The workspace the note is in, and its `@slug` for the note's address. */
  readonly workspaceId: string;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  /** ISO time or `YYYY-MM-DD`; what the list is sorted on. Empty when undated. */
  readonly when: string;
  /** "59m", "1h 10m", or null when the note does not say. */
  readonly duration: string | null;
  /** The folder it is filed in, named the way the tree names it: last segment, no sort number. */
  readonly folder: string;
}

const DATED_NAME = /(\d{4}-\d{2}-\d{2})/;
const MEETINGS_FOLDER_NAME = /(^|\/)[^/]*meeting[^/]*\//i;

function text(value: PropertyValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value).trim();
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `areas/ministry/public-worship/x.md` → `public-worship`; `1-projects/x.md` → `projects`. */
export function folderLabel(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return "";
  const folder = path.slice(0, slash);
  const last = folder.slice(folder.lastIndexOf("/") + 1);
  return last.replace(/^\d+-/, "");
}

/** A title from the file name, for a note whose heading the facts have not read: `2026-10-12-charisma-seyi-380xy9bq.md` → `charisma seyi 380xy9bq`. */
function titleFromName(path: string): string {
  return fileName(path)
    .replace(/\.md$/, "")
    .replace(DATED_NAME, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

export function meetingsFromNotes(
  notes: readonly ListNote[],
  workspace: { id: string; slug: string },
): PastMeeting[] {
  const out: PastMeeting[] = [];
  for (const note of notes) {
    if (!note.path.endsWith(".md")) continue;
    const typed = text(note.properties.type).toLowerCase() === "meeting";
    const named =
      isMeetingNotePath(note.path) ||
      (MEETINGS_FOLDER_NAME.test(note.path) && DATED_NAME.test(fileName(note.path)));
    if (!typed && !named) continue;
    const started = text(note.properties.started);
    const filed = DATED_NAME.exec(fileName(note.path))?.[1] ?? "";
    out.push({
      workspaceId: workspace.id,
      slug: workspace.slug,
      path: note.path,
      title: (note.heading ?? "").trim() || titleFromName(note.path) || "Untitled meeting",
      when: started || filed,
      duration: text(note.properties.duration) || null,
      folder: folderLabel(note.path),
    });
  }
  return out;
}

/** Newest first, one row per note, at most `limit`, never one that has not started yet. */
export function newestMeetings(meetings: readonly PastMeeting[], now: number, limit: number): PastMeeting[] {
  const seen = new Set<string>();
  return meetings
    .filter((meeting) => {
      const key = `${meeting.workspaceId}\n${meeting.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const at = Date.parse(meeting.when);
      return !Number.isFinite(at) || at <= now;
    })
    .sort((a, b) => b.when.localeCompare(a.when) || a.path.localeCompare(b.path))
    .slice(0, limit);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The short column a past row leads with: a time today, "Yesterday", a
 * weekday this week, a date before that. A bare `YYYY-MM-DD` is read as that
 * local day rather than UTC midnight, which would be the evening before
 * anywhere west of Greenwich.
 */
export function pastWhenLabel(when: string, now: number, locale?: string): string {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when);
  const at = bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])).getTime() : Date.parse(when);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (at >= today) {
    return bare ? "Today" : date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  if (at >= today - DAY_MS) return "Yesterday";
  if (at >= today - 6 * DAY_MS) return DAYS[date.getDay()];
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${date.getDate()} ${MONTHS[date.getMonth()]}` : `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}
