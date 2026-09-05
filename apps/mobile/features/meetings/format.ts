import type { Attendee, CalendarEvent, MeetingSession, MeetingSource } from "./protocol";

/**
 * Turning a meeting into the words on a row.
 *
 * Pure, and every function takes its clock: "Earlier today" is a claim about
 * the reader's day, and a module that read `Date.now()` would be untestable at
 * exactly the boundaries that matter — a meeting at 23:58, a session that
 * started yesterday and is still running, the first minute after midnight.
 *
 * The strings here are the mockup's, kept in one file so the list, the live
 * screen and the persistent bar cannot drift into three vocabularies for one
 * state. `console/format.ts` is the same idea for the console.
 */

/* ------------------------------- durations ------------------------------- */

/**
 * The running clock: `41:06`, `1:02:11`.
 *
 * Colon-separated and zero-padded from the right, because it is read as a
 * *timer* — the eye tracks the last two digits changing — and because it is set
 * in the tabular monospace face so the row does not jitter every second.
 * Hours appear only when there are hours.
 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, "0")}`
    : `${mm}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The settled length: `41 min`, `1 h 04`.
 *
 * A different format from `clock` on purpose. A finished meeting's length is
 * read once, in prose, beside a time and an attendee count — seconds are noise
 * there, and `41:06` in a sentence reads as a time of day.
 */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, "0")}`;
}

/* --------------------------------- times --------------------------------- */

/**
 * A time of day, in the reader's own locale.
 *
 * `Intl` rather than a hand-rolled 12-hour clock: the mockup shows `7:43 PM`
 * because it was drawn in an English locale, and hardcoding that would print an
 * afternoon meeting as `7:43 PM` to somebody whose phone has said `19:43` for
 * their whole life. The mockup is the design, not the locale.
 *
 * `locale` is an argument so a test is not at the mercy of the machine it runs
 * on — the same reason the clock is.
 */
export function timeOfDay(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** `Tue 1 Sep` — the heading over a previous day's meetings. */
export function dayHeading(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
}

/** `In 12 min`, `Now`, `In 2 h 05` — how far off a calendar event is. */
export function startsIn(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "Now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `In ${minutes} min`;
  return `In ${duration(ms)}`;
}

/* -------------------------------- grouping ------------------------------- */

/**
 * The list's sections, in the order the mockup puts them: what is about to
 * happen, then today, then each previous day.
 *
 * "Coming up" is calendar events rather than meetings, because a meeting that
 * has not happened is not a meeting — it has no session, no notes and nothing
 * in a bucket. Modelling it as one would put a row on this screen that looks
 * like something you can open.
 */
export interface MeetingListSection {
  /** Stable across renders and across a day boundary: a key, not a heading. */
  id: string;
  heading: string;
  kind: "upcoming" | "today" | "day";
  meetings: MeetingSession[];
  upcoming: CalendarEvent[];
}

export interface GroupInput {
  meetings: readonly MeetingSession[];
  upcoming?: readonly CalendarEvent[];
  now: number;
  locale?: string;
}

export function groupMeetings(input: GroupInput): MeetingListSection[] {
  const sections: MeetingListSection[] = [];
  const upcoming = [...(input.upcoming ?? [])]
    .filter((event) => Date.parse(event.endsAt) > input.now)
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  if (upcoming.length > 0) {
    sections.push({
      id: "upcoming",
      heading: "Coming up",
      kind: "upcoming",
      meetings: [],
      upcoming,
    });
  }

  const byDay = new Map<string, MeetingSession[]>();
  for (const meeting of [...input.meetings].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
  )) {
    const key = dayKey(meeting.startedAt);
    if (key === null) continue;
    const bucket = byDay.get(key);
    if (bucket === undefined) byDay.set(key, [meeting]);
    else bucket.push(meeting);
  }

  const today = dayKey(new Date(input.now).toISOString());
  for (const [key, meetings] of [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const isToday = key === today;
    sections.push({
      id: key,
      heading: isToday ? "Earlier today" : dayHeading(meetings[0].startedAt, input.locale),
      kind: isToday ? "today" : "day",
      meetings,
      upcoming: [],
    });
  }

  return sections;
}

/**
 * The local calendar day a timestamp falls in.
 *
 * Local, not UTC, and that is the whole point of it being its own function: a
 * meeting at 8pm on the 4th in a UTC-7 zone is `2026-09-05` in UTC, so grouping
 * on the ISO string's date would file yesterday evening's meeting under today
 * for anybody west of Greenwich. `null` for an unparseable timestamp, which is
 * then dropped rather than filed under a day nobody had.
 */
function dayKey(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const day = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/* --------------------------------- rows ---------------------------------- */

/** `7:43 PM · 41 min · In person`, the second line of a row. */
export function meetingSubtitle(
  meeting: MeetingSession,
  options: { locale?: string } = {},
): string {
  const parts = [timeOfDay(meeting.startedAt, options.locale)];
  if (meeting.recordedMs > 0) parts.push(duration(meeting.recordedMs));
  const people = attendeeCount(meeting.attendees);
  parts.push(people === 0 ? sourceLabel(meeting.source) : `${people} ${people === 1 ? "person" : "people"}`);
  return parts.filter((part) => part !== "").join(" · ");
}

/**
 * How many people were in the meeting.
 *
 * Counts everybody the session knows about, the person holding the device
 * included — a two-person call reads "2 people", which is what somebody looking
 * at the row expects, rather than "1 other person". `self` is on the protocol's
 * `Attendee` so a screen that needs the distinction can still make it.
 */
export function attendeeCount(attendees: readonly Attendee[]): number {
  return attendees.length;
}

const SOURCE_LABELS: Record<MeetingSource["kind"], string> = {
  "in-person": "In person",
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Teams",
  "slack-huddle": "Slack huddle",
  webex: "Webex",
  discord: "Discord",
  facetime: "FaceTime",
  phone: "Phone",
  unknown: "Unknown",
};

/**
 * What the note calls the source.
 *
 * A `Record` over the protocol's union rather than a `switch` with a default,
 * so a `kind` added to `protocol.js` is a compile error here — the alternative
 * is a new platform silently rendering as "Unknown" on every row.
 */
export function sourceLabel(source: MeetingSource): string {
  return SOURCE_LABELS[source.kind] ?? SOURCE_LABELS.unknown;
}

/* ---------------------------------- copy --------------------------------- */

/**
 * What the row's trailing marker says, or `null` for none.
 *
 * "Draft" is the mockup's word for a meeting that has not been finalized. It is
 * a `warn` tone rather than a neutral one on purpose: a draft is a meeting
 * whose note is not in the bucket yet, and this product treats the bucket as
 * the only place a thing is real.
 */
export function meetingBadge(
  meeting: MeetingSession,
): { label: string; tone: "warn" | "crit" | "neutral" } | null {
  if (meeting.state === "failed") return { label: "Failed", tone: "crit" };
  if (meeting.state === "finalizing") return { label: "Finalizing", tone: "warn" };
  if (meeting.state === "complete") return null;
  return { label: "Draft", tone: "warn" };
}
