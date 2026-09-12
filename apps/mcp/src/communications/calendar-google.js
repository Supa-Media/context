// The one place this gateway knows what Google Calendar is: turning a raw
// `calendar.events.list` response into the provider-agnostic
// `CalendarEventInstance` shape `packages/communications/src/calendar`
// renders and syncs, and making the HTTP calls that produce one.
//
// Everything downstream of `normalizeGoogleEvent` — the cache, the render,
// the horizon, the per-day regeneration — never sees a Google response shape
// again. That split is what makes `calendar-sync.test.mjs`'s fixture server
// worth building: it has to mimic exactly one thing, this file's contract,
// not the whole of `packages/communications`.
//
// Zero dependencies, Workers runtime: `fetch` and nothing else — plus the
// one pure function that knows when a day begins on somebody's wall clock,
// from the same package that decides which day a note is filed under, so the
// query's window and the note's date can never be drawn from two different
// definitions of "today".

import { zonedDayStartInstant } from "../../../../packages/communications/src/calendar/timezone.js";

/** `calendar.events.list`, scoped to one calendar. No API key: OAuth only. */
export const GOOGLE_CALENDAR_EVENTS_URL = (calendarId) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

/**
 * Thrown when Google returns `410 Gone` — the syncToken is no longer valid
 * and the caller must fall back to a full sync. Never carries the token or
 * any request header: only the calendar id, which is not a credential.
 */
export class SyncTokenExpiredError extends Error {
  constructor(calendarId) {
    super(`sync token expired for calendar ${calendarId}`);
    this.name = "SyncTokenExpiredError";
    this.calendarId = calendarId;
  }
}

/**
 * A Calendar API call failed for a reason other than an expired token.
 * `status` is safe to log; nothing else about the request is attached.
 */
export class CalendarApiError extends Error {
  constructor(status, calendarId) {
    super(`calendar API request failed (${status}) for calendar ${calendarId}`);
    this.name = "CalendarApiError";
    this.status = status;
    this.calendarId = calendarId;
  }
}

/**
 * A page walk ended without Google's terminal page and therefore without the
 * only `nextSyncToken` that can safely advance the calendar cursor. Fixed and
 * content-free so a scheduler can classify it without carrying provider text.
 */
export class CalendarPaginationError extends Error {
  constructor() {
    super("Google Calendar pagination did not converge");
    this.name = "CalendarPaginationError";
    this.code = "PAGINATION_STALLED";
  }
}

/**
 * One page of `calendar.events.list`.
 *
 * The access token is sent **only** in the `Authorization` header, never as a
 * query parameter — a URL is the one place a credential in this product is
 * explicitly forbidden to appear (`docs/decisions/communications.md`,
 * "tokens never in logs, audit, URLs, or notes"), and Google's API accepts a
 * bearer header for every one of these parameters, so there is no reason to
 * reach for the alternative.
 *
 * A `410` is Google's documented signal that `syncToken` no longer describes
 * a resumable position — thrown as `SyncTokenExpiredError` so the caller
 * (`planAndFetch` below) can restart as a full sync, per Google's own
 * guidance for this exact response.
 *
 * Only `410` is checked for and promoted. This is the exact place the Gmail
 * reconciliation named a bug to avoid repeating: its `history.list` handling
 * had inverted 404 detection, so an ordinary deletion (an ordinary 404) read
 * as an expired cursor and forced a needless full resync. There is no
 * equivalent branch here to invert — every status that is not `410`,
 * 404 included, falls straight through to the generic `CalendarApiError`
 * below with no promotion at all — so a gap in Calendar's own sense (an event
 * this cache has that the feed no longer lists) stays a fact `sync.js`
 * discovers by diffing what came back, never a side effect of an HTTP
 * status. See `calendarGoogle.test.mjs`'s explicit 404 case.
 *
 * ## The window is the OWNER'S days, not UTC's
 *
 * `windowStart`/`windowEnd` are calendar dates on the connection's own wall
 * clock — the same dates `sync.js` decides which day notes to write from —
 * so they are converted to instants through `timezone`, never by pasting
 * `T00:00:00.000Z` on the end. Pasting Z is only correct for a UTC
 * connection: at `Asia/Tokyo` it starts the query nine hours into the
 * horizon's first day (every event before 09:00 local is never fetched, and
 * a full sync then writes that day's note without them), and at
 * `America/New_York` it ends the query four hours before the horizon's last
 * day does (its whole evening disappears). Both are silent — a note is still
 * written, just missing events — which is exactly the failure class this
 * file's `410`-only rule exists to avoid elsewhere. Over-fetching by an hour
 * either side would be harmless (the cache is keyed by local date and pruned
 * to the local window); under-fetching is data loss, so the conversion is
 * exact rather than approximate.
 *
 * @param {{fetchImpl: typeof fetch, accessToken: string, calendarId: string,
 *          syncToken?: string|null, windowStart?: string|null, windowEnd?: string|null,
 *          timezone?: string, pageToken?: string|null}} args
 * @returns {Promise<{items: object[], nextPageToken: string|null, nextSyncToken: string|null}>}
 */
export async function fetchCalendarPage({
  fetchImpl,
  accessToken,
  calendarId,
  syncToken = null,
  windowStart = null,
  windowEnd = null,
  timezone = "UTC",
  pageToken = null,
}) {
  const url = new URL(GOOGLE_CALENDAR_EVENTS_URL(calendarId));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("maxResults", "250");
  if (syncToken) {
    // Per Google's documentation, a request carrying a syncToken accepts no
    // other filter — combining one with timeMin/timeMax is rejected by the
    // API, which is also *why* `planSyncRequest` never asks for both at once.
    url.searchParams.set("syncToken", syncToken);
  } else {
    const timeMin = windowStart ? zonedDayStartInstant(windowStart, timezone) : null;
    const timeMax = windowEnd ? zonedDayStartInstant(windowEnd, timezone) : null;
    if (timeMin) url.searchParams.set("timeMin", timeMin);
    if (timeMax) url.searchParams.set("timeMax", timeMax);
  }
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 410) throw new SyncTokenExpiredError(calendarId);
  if (!response.ok) throw new CalendarApiError(response.status, calendarId);

  const body = await response.json();
  return {
    items: Array.isArray(body.items) ? body.items : [],
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
    nextSyncToken: typeof body.nextSyncToken === "string" ? body.nextSyncToken : null,
  };
}

/**
 * Every page of one request, followed to the end. `nextSyncToken` only ever
 * appears on the *last* page (Google's own contract), so it is `null` on
 * every page but the one that has it.
 *
 * @param {Parameters<typeof fetchCalendarPage>[0]} args
 * @returns {Promise<{items: object[], nextSyncToken: string|null}>}
 */
export async function fetchAllPages(args) {
  const items = [];
  let pageToken = null;
  let nextSyncToken = null;
  let complete = false;
  const seenPageTokens = new Set();
  // A page cap, not a product limit: a fixture or a misbehaving server that
  // never stops paginating must not hang a sync forever.
  for (let page = 0; page < 1000; page += 1) {
    const result = await fetchCalendarPage({ ...args, pageToken });
    items.push(...result.items);
    if (result.nextSyncToken) nextSyncToken = result.nextSyncToken;
    if (!result.nextPageToken) {
      complete = true;
      break;
    }
    if (seenPageTokens.has(result.nextPageToken)) {
      throw new CalendarPaginationError();
    }
    seenPageTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  // Hitting the cap is not a partial success. Google's resumable sync token
  // exists only on the terminal page, so returning the old/null token here
  // would make the next scheduled pass replay the same thousand pages forever.
  if (!complete) throw new CalendarPaginationError();
  return { items, nextSyncToken };
}

/** An attendee or organizer resource, normalized. `null` fields stay absent rather than becoming `""`. */
function normalizePerson(person) {
  if (!person || typeof person !== "object") return null;
  const out = {};
  if (typeof person.displayName === "string" && person.displayName) out.name = person.displayName;
  if (typeof person.email === "string" && person.email) out.email = person.email;
  if (person.organizer === true) out.organizer = true;
  if (person.self === true) out.self = true;
  if (typeof person.responseStatus === "string") out.responseStatus = person.responseStatus;
  return out;
}

/** The first video-conference join URL Google's `conferenceData` offers, if any. */
function conferenceLink(raw) {
  const entryPoints = raw?.conferenceData?.entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  const video = entryPoints.find((entry) => entry?.entryPointType === "video" && typeof entry.uri === "string");
  return video ? video.uri : null;
}

/**
 * One Google Calendar event resource, normalized into a
 * `CalendarEventInstance` — the only function in this gateway that reads a
 * Google-shaped object.
 *
 * A `status: "cancelled"` resource may be missing `summary`, `start` and
 * `end` entirely (Google's documented behaviour for a deletion notice); those
 * fields normalize to their empty forms rather than throwing, and
 * `originalStartTime` — present on a cancelled *recurring instance*, absent
 * on a cancelled standalone event — carries what day bookkeeping needs when
 * `start`/`end` do not.
 *
 * @param {object} raw
 * @param {{account: string, calendarId: string}} context
 * @returns {import("../../../../packages/communications/src/calendar/protocol.js").CalendarEventInstance}
 */
export function normalizeGoogleEvent(raw, { account, calendarId }) {
  const status = raw?.status === "cancelled" ? "cancelled" : raw?.status === "tentative" ? "tentative" : "confirmed";
  const attendees = Array.isArray(raw?.attendees)
    ? raw.attendees.map(normalizePerson).filter((person) => person && person.email)
    : [];
  const organizer = normalizePerson(raw?.organizer);

  const originalStartTime = raw?.originalStartTime;
  const originalDate =
    typeof originalStartTime?.date === "string"
      ? originalStartTime.date
      : typeof originalStartTime?.dateTime === "string"
        ? originalStartTime.dateTime
        : null;

  return {
    account,
    calendarId,
    eventId: String(raw?.id ?? ""),
    title: typeof raw?.summary === "string" ? raw.summary : "",
    description: typeof raw?.description === "string" ? raw.description : "",
    location: typeof raw?.location === "string" ? raw.location : "",
    meetingLink: raw?.hangoutLink || conferenceLink(raw) || null,
    start: {
      ...(typeof raw?.start?.date === "string" ? { date: raw.start.date } : {}),
      ...(typeof raw?.start?.dateTime === "string" ? { dateTime: raw.start.dateTime } : {}),
    },
    end: {
      ...(typeof raw?.end?.date === "string" ? { date: raw.end.date } : {}),
      ...(typeof raw?.end?.dateTime === "string" ? { dateTime: raw.end.dateTime } : {}),
    },
    attendees,
    organizer: organizer && (organizer.name || organizer.email) ? organizer : null,
    status,
    recurringEventId: typeof raw?.recurringEventId === "string" ? raw.recurringEventId : null,
    originalDate,
  };
}
