// The adapter: raw Google Calendar API shapes in, `CalendarEventInstance` (or
// a thrown, token-safe error) out. `calendar-sync.test.mjs` covers the
// orchestration; this file is about the shape translation and the request
// itself — where the credential goes, and where it must never go.

import { createFakeCalendarServer } from "./fakeCalendarServer.mjs";
import {
  CalendarApiError,
  fetchAllPages,
  fetchCalendarPage,
  normalizeGoogleEvent,
  SyncTokenExpiredError,
} from "../src/communications/calendar-google.js";

export async function runCalendarGoogleChecks(check) {
  /* ------------------------------ normalizeGoogleEvent ------------------- */

  const timed = normalizeGoogleEvent(
    {
      id: "abc123",
      status: "confirmed",
      summary: "Quarterly review",
      description: "Bring the deck.",
      location: "Room 4B",
      hangoutLink: "https://meet.google.com/xyz",
      start: { dateTime: "2026-09-07T14:00:00.000Z" },
      end: { dateTime: "2026-09-07T15:00:00.000Z" },
      attendees: [
        { displayName: "Adam Okonkwo", email: "adam@example.com", responseStatus: "accepted" },
        { email: "no-name@example.com" },
        { displayName: "No email at all" },
      ],
      organizer: { displayName: "Priya Shah", email: "priya@example.com" },
    },
    { account: "person@example.com", calendarId: "primary" }
  );
  check("the provider id, account and calendar are carried through", timed.eventId === "abc123" && timed.account === "person@example.com" && timed.calendarId === "primary");
  check("title, description and location map directly", timed.title === "Quarterly review" && timed.description === "Bring the deck." && timed.location === "Room 4B");
  check("hangoutLink becomes the meeting link", timed.meetingLink === "https://meet.google.com/xyz");
  check("start/end carry only the dateTime field that was present", timed.start.dateTime === "2026-09-07T14:00:00.000Z" && timed.start.date === undefined);
  check("an attendee with no display name still carries their address", timed.attendees.some((a) => a.email === "no-name@example.com" && a.name === undefined));
  check("an attendee with no email at all is dropped — nothing to merge a contact on", !timed.attendees.some((a) => a.name === "No email at all"));
  check("the organizer maps through", timed.organizer.name === "Priya Shah" && timed.organizer.email === "priya@example.com");
  check("status defaults to confirmed", timed.status === "confirmed");

  const conferenceLinked = normalizeGoogleEvent(
    {
      id: "e2",
      conferenceData: { entryPoints: [{ entryPointType: "sms", uri: "tel:123" }, { entryPointType: "video", uri: "https://meet.example.com/v" }] },
    },
    { account: "a", calendarId: "primary" }
  );
  check("a video entry point in conferenceData is used when there is no hangoutLink", conferenceLinked.meetingLink === "https://meet.example.com/v");
  check("a missing conferenceData/hangoutLink normalizes to null, never undefined or a thrown error", normalizeGoogleEvent({ id: "e3" }, { account: "a", calendarId: "primary" }).meetingLink === null);

  const allDay = normalizeGoogleEvent({ id: "e4", start: { date: "2026-09-07" }, end: { date: "2026-09-08" } }, { account: "a", calendarId: "primary" });
  check("an all-day event carries the date field, not a dateTime", allDay.start.date === "2026-09-07" && allDay.start.dateTime === undefined);

  const bareCancellation = normalizeGoogleEvent({ id: "e5", status: "cancelled" }, { account: "a", calendarId: "primary" });
  check("a bare cancellation normalizes without throwing, with empty start/end rather than missing fields", bareCancellation.status === "cancelled" && JSON.stringify(bareCancellation.start) === "{}");
  check("...and no originalDate when the provider sent none", bareCancellation.originalDate === null);

  const recurringCancellation = normalizeGoogleEvent(
    { id: "series_20260910T140000Z", status: "cancelled", recurringEventId: "series", originalStartTime: { dateTime: "2026-09-10T14:00:00.000Z" } },
    { account: "a", calendarId: "primary" }
  );
  check("a cancelled recurring instance carries its originalDate from originalStartTime", recurringCancellation.originalDate === "2026-09-10T14:00:00.000Z");
  check("...and its recurringEventId", recurringCancellation.recurringEventId === "series");

  const allDayOriginal = normalizeGoogleEvent(
    { id: "series_20260910", status: "cancelled", originalStartTime: { date: "2026-09-10" } },
    { account: "a", calendarId: "primary" }
  );
  check("an all-day cancelled instance's originalDate comes from originalStartTime.date", allDayOriginal.originalDate === "2026-09-10");

  /* ------------------------------ fetchCalendarPage ----------------------- */

  const server = createFakeCalendarServer();
  server.addEvent({ id: "e1", summary: "Standup", start: { dateTime: "2026-09-07T14:00:00.000Z" }, end: { dateTime: "2026-09-07T14:15:00.000Z" } });

  const ACCESS_TOKEN = "ya29.super-secret-token-value";
  const page = await fetchCalendarPage({
    fetchImpl: server.fetch,
    accessToken: ACCESS_TOKEN,
    calendarId: "primary",
    windowStart: "2026-09-01",
    windowEnd: "2026-09-30",
  });
  check("a full page returns the seeded event", page.items.length === 1 && page.items[0].id === "e1");
  check("a full page carries a nextSyncToken", typeof page.nextSyncToken === "string" && page.nextSyncToken.length > 0);

  const request = server.requests[server.requests.length - 1];
  check("the access token is sent in the Authorization header", request.hadAuthHeader);
  check("the access token never appears anywhere in the request URL", !JSON.stringify(request.query).includes(ACCESS_TOKEN) && !request.path.includes(ACCESS_TOKEN));
  check("singleEvents is requested — this gateway never expands recurrence itself", request.query.singleEvents === "true");

  const incrementalPage = await fetchCalendarPage({ fetchImpl: server.fetch, accessToken: ACCESS_TOKEN, calendarId: "primary", syncToken: page.nextSyncToken });
  const incrementalRequest = server.requests[server.requests.length - 1];
  check(
    "a syncToken request never also carries timeMin/timeMax — Google's API rejects the combination",
    incrementalRequest.query.syncToken === page.nextSyncToken && !("timeMin" in incrementalRequest.query) && !("timeMax" in incrementalRequest.query)
  );
  check("an incremental request with no changes returns no items", incrementalPage.items.length === 0);

  server.expireToken(page.nextSyncToken);
  let threw410 = null;
  try {
    await fetchCalendarPage({ fetchImpl: server.fetch, accessToken: ACCESS_TOKEN, calendarId: "primary", syncToken: page.nextSyncToken });
  } catch (error) {
    threw410 = error;
  }
  check("a 410 response throws SyncTokenExpiredError", threw410 instanceof SyncTokenExpiredError);
  check("...and the error never carries the access token in its message", !String(threw410?.message ?? "").includes(ACCESS_TOKEN));
  check("...nor does the token appear in the request the fake server logged for it", !JSON.stringify(server.requests.at(-1)).includes(ACCESS_TOKEN));

  const errorServer = createFakeCalendarServer();
  const failingFetch = async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 });
  let threw500 = null;
  try {
    await fetchCalendarPage({ fetchImpl: failingFetch, accessToken: ACCESS_TOKEN, calendarId: "primary" });
  } catch (error) {
    threw500 = error;
  }
  check("a non-410 failure throws CalendarApiError carrying only the status", threw500 instanceof CalendarApiError && threw500.status === 500);
  check("...never the access token", !String(threw500?.message ?? "").includes(ACCESS_TOKEN));
  void errorServer;

  // The reconciliation brief flagged that Gmail's `history.list` had inverted
  // 404 handling — a routine deletion looked like an expired cursor, because
  // the wrong status was promoted to "start a full resync". This gateway's
  // own gap detection never has that ambiguity to invert: only `410` is
  // checked for and promoted (above); every other status, 404 included,
  // falls through to the generic `CalendarApiError` branch with no special
  // meaning attached. Proven directly rather than inferred from the 500 case,
  // since 404 is the specific status the Gmail bug was about.
  const notFoundFetch = async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  let threw404 = null;
  try {
    await fetchCalendarPage({ fetchImpl: notFoundFetch, accessToken: ACCESS_TOKEN, calendarId: "primary" });
  } catch (error) {
    threw404 = error;
  }
  check("a 404 is an ordinary CalendarApiError, never promoted to a sync-token-expired full resync", threw404 instanceof CalendarApiError && !(threw404 instanceof SyncTokenExpiredError) && threw404.status === 404);

  /* ------------------------------ fetchAllPages: pagination --------------- */

  const pagedServer = createFakeCalendarServer({ pageSize: 2 });
  for (let i = 0; i < 5; i += 1) {
    pagedServer.addEvent({ id: `e${i}`, start: { dateTime: `2026-09-0${(i % 9) + 1}T10:00:00.000Z` }, end: { dateTime: `2026-09-0${(i % 9) + 1}T10:30:00.000Z` } });
  }
  const all = await fetchAllPages({ fetchImpl: pagedServer.fetch, accessToken: ACCESS_TOKEN, calendarId: "primary", windowStart: "2026-09-01", windowEnd: "2026-09-30" });
  check("fetchAllPages follows every page — 5 events at a page size of 2", all.items.length === 5);
  check("the pagination made three requests", pagedServer.requests.length === 3);
  check("nextSyncToken comes from the last page only", typeof all.nextSyncToken === "string");

  let repeatedPageCalls = 0;
  const repeatedPageFetch = async () => {
    repeatedPageCalls += 1;
    if (repeatedPageCalls > 2) {
      throw Object.assign(new Error("fixture walked forever"), { code: "TEST_UNBOUNDED" });
    }
    return new Response(
      JSON.stringify({ items: [], nextPageToken: "same-page" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const repeatedPageError = await fetchAllPages({
    fetchImpl: repeatedPageFetch,
    accessToken: ACCESS_TOKEN,
    calendarId: "primary",
  }).catch((error) => error);
  check("a repeated Calendar page token is detected before a third request", repeatedPageCalls === 2);
  check(
    "...and is a typed failure rather than a partial result with no safe sync token",
    repeatedPageError?.code === "PAGINATION_STALLED",
  );
}
