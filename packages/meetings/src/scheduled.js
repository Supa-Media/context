// Meetings on the person's calendar that they can join and take notes in.
//
// The console's Meetings page, its sidebar row and the Mac app's menu bar all
// ask the same three questions of the same Google events, so the answers live
// here as pure functions:
//
//  - Which link does "Join" open? Only an https link on a known video-call
//    host. An invite's words are whoever sent it, and a one-click Join that
//    opened any URL in a description would be a link anybody can put in front
//    of the person under a button that says "Join".
//  - Which events count? Timed, not cancelled, not declined, and with a call
//    link or somebody else on it. Holds, birthdays and all-day blocks are not
//    meetings, and a wall of them is the reason nobody looks at the list.
//  - Which one is "next"? The one on now, else the soonest within the lead.
//
// Nothing here starts a recording. Joining is a press; see
// docs/decisions/meetings/joining-from-the-calendar.md.

/** @typedef {import("./protocol.js").CalendarEvent} CalendarEvent */
/** @typedef {import("./protocol.js").Attendee} Attendee */

/** Hosts a Join button may open, with their subdomains. */
export const JOIN_HOSTS = Object.freeze([
  "meet.google.com",
  "zoom.us",
  "teams.microsoft.com",
  "teams.live.com",
  "webex.com",
  "facetime.apple.com",
]);

/** The sidebar row and the menu bar name a meeting from this long before it. */
export const NEXT_MEETING_LEAD_MS = 10 * 60 * 1000;

/** The most guests one meeting carries into the app. */
const MAX_ATTENDEES = 50;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;

/**
 * `candidate` as a joinable link, or null.
 *
 * @param {unknown} candidate
 * @returns {string|null}
 */
export function safeJoinUrl(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!JOIN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
  return url.href;
}

/** Which call a join link is, in the protocol's `MeetingSource` words. */
const CALL_KINDS = Object.freeze([
  ["meet.google.com", "meet"],
  ["zoom.us", "zoom"],
  ["teams.microsoft.com", "teams"],
  ["teams.live.com", "teams"],
  ["webex.com", "webex"],
  ["facetime.apple.com", "facetime"],
]);

/**
 * @param {string|undefined} url
 * @returns {"meet"|"zoom"|"teams"|"webex"|"facetime"|"unknown"}
 */
export function callKindOf(url) {
  const safe = safeJoinUrl(url);
  if (safe === null) return "unknown";
  const host = new URL(safe).hostname.toLowerCase();
  for (const [allowed, kind] of CALL_KINDS) {
    if (host === allowed || host.endsWith(`.${allowed}`)) return /** @type {any} */ (kind);
  }
  return "unknown";
}

const URL_IN_TEXT = /https:\/\/[^\s<>"')\]]+/gi;

/**
 * The link a Join button opens for one normalized Google event
 * (`apps/mcp/src/communications/calendar-google.js`), or null. The event's own
 * conference link first, then the first call link written in its location,
 * then in its description, which is where Zoom and Teams invites put theirs.
 *
 * @param {{meetingLink?: string|null, location?: string, description?: string}} event
 * @returns {string|null}
 */
export function joinUrlOf(event) {
  const own = safeJoinUrl(event?.meetingLink ?? null);
  if (own !== null) return own;
  for (const text of [event?.location, event?.description]) {
    if (typeof text !== "string") continue;
    for (const match of text.match(URL_IN_TEXT) ?? []) {
      const found = safeJoinUrl(match.replace(/[.,;:!?]+$/, ""));
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * One normalized Google event as a meeting the app offers, or null when it is
 * not one.
 *
 * @param {object} event  A `CalendarEventInstance` from `normalizeGoogleEvent`.
 * @returns {CalendarEvent|null}
 */
export function scheduledMeetingOf(event) {
  if (!event || event.status === "cancelled") return null;
  const startsAt = event.start?.dateTime;
  const endsAt = event.end?.dateTime;
  if (typeof startsAt !== "string" || typeof endsAt !== "string") return null;
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const people = Array.isArray(event.attendees) ? event.attendees : [];
  const me = people.find((person) => person?.self === true);
  if (me?.responseStatus === "declined") return null;
  const others = people.filter((person) => person?.self !== true && person?.resource !== true);
  const conferenceUrl = joinUrlOf(event);
  if (conferenceUrl === null && others.length === 0) return null;

  /** @type {Attendee[]} */
  const attendees = people
    .filter((person) => person && typeof person.email === "string")
    .slice(0, MAX_ATTENDEES)
    .map((person) => ({
      name: typeof person.name === "string" && person.name !== "" ? person.name : person.email,
      email: person.email,
      ...(person.self === true ? { self: true } : {}),
      via: /** @type {const} */ ("calendar"),
    }));
  const title = typeof event.title === "string" && event.title.trim() !== "" ? event.title.trim().slice(0, MAX_TITLE_LENGTH) : "Meeting";
  return {
    id: `${event.account}:${event.eventId}`,
    title,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    attendees,
    ...(conferenceUrl !== null ? { conferenceUrl } : {}),
    ...(typeof event.account === "string" ? { account: event.account } : {}),
  };
}

/**
 * Meetings from every connected calendar, as one day: overlapping `from`..`to`,
 * soonest first, and one entry for a meeting two of the person's accounts were
 * both invited to.
 *
 * @param {CalendarEvent[]} meetings
 * @param {{from: number, to: number}} window
 * @returns {CalendarEvent[]}
 */
export function mergeScheduled(meetings, { from, to }) {
  const seen = new Set();
  const out = [];
  const sorted = [...meetings].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  for (const meeting of sorted) {
    if (Date.parse(meeting.endsAt) <= from || Date.parse(meeting.startsAt) >= to) continue;
    const key = `${meeting.startsAt}|${meeting.conferenceUrl ?? meeting.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(meeting);
  }
  return out;
}

/**
 * The meeting to name right now: one under way (the latest to start, since
 * that is the one somebody just joined), else the soonest starting within
 * `leadMs`, else null.
 *
 * @param {readonly CalendarEvent[]} meetings
 * @param {number} now
 * @param {number} [leadMs]
 * @returns {CalendarEvent|null}
 */
export function nextMeeting(meetings, now, leadMs = NEXT_MEETING_LEAD_MS) {
  let live = null;
  let soon = null;
  for (const meeting of meetings) {
    const start = Date.parse(meeting.startsAt);
    const end = Date.parse(meeting.endsAt);
    if (now >= start && now < end) {
      if (live === null || start > Date.parse(live.startsAt)) live = meeting;
    } else if (start > now && start - now <= leadMs) {
      if (soon === null || start < Date.parse(soon.startsAt)) soon = meeting;
    }
  }
  return live ?? soon;
}
