/**
 * `read_calendar` (fetch id `calendar:`) asks the person's own Google
 * calendars at that moment, through the control plane, and reads no note
 * (owner, 2026-10-21: every copy of a calendar was removed from the notes;
 * before that, Tex said "I can't read your Google Calendar" twice with the
 * days copied into a folder it wasn't told about).
 *
 * ## Sabotage record
 *
 *   reading calendar notes from the store again
 *     → "an old calendar note in the notes is never read" fails
 *   one calendar's section dropped for a day
 *     → "every calendar's day is shown, and a run of days reads each" fails
 *   "unavailable" answered as an empty day
 *     → "Google not answering is never an empty day" fails
 *   the unanswered calendar left unnamed
 *     → "a calendar Google didn't answer for is named, not shown empty" fails
 *   `account` dropped on the way to the control plane (tool or client)
 *     → "a chosen account is the only one asked for" and
 *       "the client sends account only when one was chosen" fail
 *   `other_calendar` missing from the client's refusals
 *     → "an account that isn't connected is refused, never answered from another" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolReadCalendar } from "../src/tools/calendarRead.js";
import { createCalendarMethods } from "../src/controlPlane/calendar.js";
import { readCalendarDays } from "../src/communications/calendarLive.js";
import { translateFetch } from "../src/tools/v2/searchFetch.js";
import { recordRead, newLedger } from "../src/privacy/egress.js";
import { renderCalendarDay } from "../../../packages/communications/src/calendar/render.js";

const rendered = (date, title, account = "person@example.invalid") =>
  renderCalendarDay({
    date,
    timezone: "America/New_York",
    nonce: "live:n0nce",
    now: "2026-10-21T12:00:00Z",
    origin: "calendar-live",
    events: [
      {
        account,
        calendarId: "primary",
        eventId: `${date}-${title}`,
        title,
        description: "",
        location: "",
        meetingLink: null,
        start: { dateTime: `${date}T18:00:00-04:00` },
        end: { dateTime: `${date}T19:00:00-04:00` },
        attendees: [],
        organizer: null,
        status: "confirmed",
        recurringEventId: null,
        originalDate: null,
      },
    ],
  });

/** A store whose only calendar is the live one; `answer` is what the control plane says. */
function liveStore(answer, notes = {}) {
  const asked = [];
  return {
    asked,
    async list() {
      return { objects: Object.keys(notes).map((key) => ({ key, size: 1, uploaded: new Date(0), etag: "e" })), truncated: false };
    },
    async get(key) {
      throw new Error(`a note was read: ${key}`);
    },
    calendar: {
      async days(request) {
        asked.push(request);
        return typeof answer === "function" ? answer(request) : answer;
      },
    },
  };
}

const text = (result) => result.content.map((part) => part.text).join("\n");

test("a day is asked of Google and its events come back, without front matter", async () => {
  const store = liveStore({ ok: true, days: [{ address: "person@example.invalid", date: "2026-10-23", text: rendered("2026-10-23", "Dinner with Ada") }] });
  const result = await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" });
  assert.notEqual(result.isError, true);
  assert.deepEqual(store.asked, [{ date: "2026-10-23", days: 1 }]);
  const out = text(result);
  assert.match(out, /## Friday 2026-10-23/);
  assert.ok(out.includes("Dinner with Ada"));
  assert.ok(!out.includes("trust:"), "front matter left off");
  assert.match(out, /Read from Google Calendar just now/);
});

test("an old calendar note in the notes is never read", async () => {
  const store = liveStore(
    { ok: true, days: [{ address: "person@example.invalid", date: "2026-10-23", text: rendered("2026-10-23", "Live") }] },
    { "0-inbox/calendar/person-at-example-invalid/2026/10/2026-10-23.md": "stale" },
  );
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" }));
  assert.ok(out.includes("Live") && !out.includes("stale"));
});

test("every calendar's day is shown, and a run of days reads each", async () => {
  const store = liveStore({
    ok: true,
    days: [
      { address: "work@example.invalid", date: "2026-10-23", text: rendered("2026-10-23", "Standup", "work@example.invalid") },
      { address: "home@example.invalid", date: "2026-10-23", text: rendered("2026-10-23", "Dentist", "home@example.invalid") },
      { address: "work@example.invalid", date: "2026-10-24", text: rendered("2026-10-24", "Brunch", "work@example.invalid") },
    ],
  });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23", days: 2 }));
  assert.ok(out.includes("Standup") && out.includes("Dentist") && out.includes("Brunch"));
  assert.ok(out.indexOf("Friday 2026-10-23") < out.indexOf("Saturday 2026-10-24"));
  assert.ok(out.indexOf("home@example.invalid") < out.indexOf("work@example.invalid"), "calendars in a fixed order");
});

test("Google not answering is never an empty day", async () => {
  for (const refused of ["unavailable", "rate_limited"]) {
    const result = await toolReadCalendar(liveStore({ ok: false, refused }), "private", [], new Map(), { date: "2026-10-23" });
    assert.equal(result.isError, true);
    assert.match(text(result), /never that the day is empty/);
  }
  const thrown = await toolReadCalendar(liveStore(() => { throw new Error("socket"); }), "private", [], new Map(), { date: "2026-10-23" });
  assert.match(text(thrown), /didn't answer just now/);
});

test("with no calendar connected, it says so and how to connect, never that it can't read it", async () => {
  const out = text(await toolReadCalendar(liveStore({ ok: false, refused: "no_calendar" }), "private", [], new Map(), { date: "2026-10-23" }));
  assert.match(out, /Google Calendar isn't connected/);
  assert.match(out, /connect_google/);
});

test("a calendar Google didn't answer for is named, not shown empty, and a broken sign-in is named", async () => {
  const store = liveStore({
    ok: true,
    days: [{ address: "home@example.invalid", date: "2026-10-23", text: rendered("2026-10-23", "Dentist", "home@example.invalid") }],
    unanswered: ["work@example.invalid"],
    reconnect: ["old@example.invalid"],
  });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" }));
  assert.match(out, /didn't answer for work@example\.invalid/);
  assert.match(out, /old@example\.invalid stopped working/);
});

test("a connection with no live calendar (a team grant) is refused", async () => {
  const result = await toolReadCalendar({}, "team", [], new Map(), { date: "2026-10-23" });
  assert.equal(result.isError, true);
  assert.match(text(result), /only the owner of their personal workspace/);
});

test("a bad date or day count is refused before Google is asked", async () => {
  const store = liveStore({ ok: true, days: [] });
  for (const args of [{}, { date: "friday" }, { date: "2026-02-30" }, { date: "2026-10-23", days: 0 }, { date: "2026-10-23", days: 15 }]) {
    assert.equal((await toolReadCalendar(store, "private", [], new Map(), args)).isError, true, JSON.stringify(args));
  }
  assert.equal(store.asked.length, 0);
});

test('fetch "calendar:" is read_calendar with its date and days', () => {
  assert.deepEqual(translateFetch({ id: "calendar:", args: { date: "2026-10-23", days: 2 } }), {
    name: "read_calendar",
    arguments: { date: "2026-10-23", days: 2 },
    action: "calendar",
  });
  assert.ok(translateFetch({ id: "calendar:", args: { limit: 3 } }).error);
});

test("a chosen account is the only one asked for, trimmed and lowercased, and the answer says so", async () => {
  const store = liveStore({
    ok: true,
    days: [{ address: "test@example.invalid", date: "2026-10-23", text: rendered("2026-10-23", "R8C3", "test@example.invalid") }],
  });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23", account: "  Test@Example.invalid " }));
  assert.deepEqual(store.asked, [{ date: "2026-10-23", days: 1, account: "test@example.invalid" }]);
  assert.match(out, /from test@example\.invalid only/);
  assert.doesNotMatch(out, /one section per connected calendar/);
});

test("an account that isn't connected is refused, never answered from another", async () => {
  const methods = createCalendarMethods({ post: async () => ({ ok: false, refused: "other_calendar" }) });
  const answer = await methods.personCalendarDays("token", "ws", { date: "2026-10-23", days: 1, account: "nobody@example.invalid" });
  assert.equal(answer.refused, "other_calendar");
  const result = await toolReadCalendar(liveStore(answer), "private", [], new Map(), { date: "2026-10-23", account: "nobody@example.invalid" });
  assert.equal(result.isError, true);
  assert.match(text(result), /isn't one of their connected Google calendars/);
  assert.match(text(result), /no other calendar was read instead/);
});

test("a blank, non-string or malformed account is refused before Google is asked", async () => {
  const store = liveStore({ ok: true, days: [] });
  for (const account of ["", "   ", 42, null, ["a@example.invalid"], "not-an-address", "a b@example.invalid", "@example.invalid"]) {
    const result = await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23", account });
    assert.equal(result.isError, true, JSON.stringify(account));
    assert.match(text(result), /account has to be one connected Google address/);
  }
  assert.equal(store.asked.length, 0);
});

test("the client sends account only when one was chosen", async () => {
  const bodies = [];
  const methods = createCalendarMethods({
    async post(path, body) {
      bodies.push({ path, body });
      return { ok: true, days: [] };
    },
  });
  await methods.personCalendarDays("token", "ws", { date: "2026-10-23", days: 1 });
  await methods.personCalendarDays("token", "ws", { date: "2026-10-23", days: 1, account: "test@example.invalid" });
  assert.equal(bodies[0].path, "/gateway/calendar/days");
  assert.ok(!("account" in bodies[0].body), "omitted stays omitted: every calendar, as before");
  assert.equal(bodies[1].body.account, "test@example.invalid");
});

test('fetch "calendar:" carries account through to read_calendar', () => {
  assert.deepEqual(translateFetch({ id: "calendar:", args: { date: "2026-10-23", account: "test@example.invalid" } }), {
    name: "read_calendar",
    arguments: { date: "2026-10-23", account: "test@example.invalid" },
    action: "calendar",
  });
});

test("an invite's words mark the turn as having read something from outside", () => {
  const ledger = newLedger();
  recordRead(ledger, { name: "read_calendar", args: { date: "2026-10-23" }, result: { content: [{ type: "text", text: "## Friday" }] } });
  assert.equal(ledger.untrusted, true);
});

/* ------------------------------ the live read ----------------------------- */

function google(items, timeZone = "America/New_York") {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    return new Response(JSON.stringify({ items, timeZone }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { urls, fetchImpl };
}

test("the live read keeps the asked days on the calendar's own wall clock, and renders them fenced", async () => {
  const { urls, fetchImpl } = google([
    { id: "a", summary: "Late Thursday", start: { dateTime: "2026-10-22T23:30:00-04:00" }, end: { dateTime: "2026-10-22T23:45:00-04:00" } },
    { id: "b", summary: "Friday dinner", start: { dateTime: "2026-10-23T19:00:00-04:00" }, end: { dateTime: "2026-10-23T21:00:00-04:00" } },
    { id: "c", summary: "Gone", status: "cancelled", start: { dateTime: "2026-10-23T10:00:00-04:00" }, end: { dateTime: "2026-10-23T11:00:00-04:00" } },
  ]);
  const read = await readCalendarDays({ fetchImpl, accessToken: "tok", account: "a@example.invalid", from: "2026-10-23", days: 2, nonce: "live:x", now: "2026-10-21T12:00:00Z" });
  assert.equal(read.timezone, "America/New_York");
  assert.deepEqual(read.days.map((day) => [day.date, day.events]), [["2026-10-23", 1], ["2026-10-24", 0]]);
  assert.ok(read.days[0].text.includes("Friday dinner"));
  assert.ok(!read.days[0].text.includes("Late Thursday"), "Thursday 11:30 PM in New York is 03:30 UTC Friday, and stays Thursday");
  assert.ok(!read.days[0].text.includes("Gone"));
  assert.ok(read.days[0].text.includes("live:x:2026-10-23"), "fenced with the answer's nonce");
  // Over-fetched a day either side, to learn the zone without losing an edge.
  assert.equal(urls[0].searchParams.get("timeMin"), "2026-10-22T00:00:00.000Z");
  assert.equal(urls[0].searchParams.get("timeMax"), "2026-10-26T00:00:00.000Z");
  assert.equal(urls[0].searchParams.get("singleEvents"), "true");
});

test("the live read names each day's busy times as instants only, for a card that picks free times", async () => {
  const { fetchImpl } = google([
    { id: "b", summary: "Friday dinner", location: "Somewhere", start: { dateTime: "2026-10-23T19:00:00-04:00" }, end: { dateTime: "2026-10-23T21:00:00-04:00" } },
    { id: "a", summary: "Standup", start: { dateTime: "2026-10-23T09:00:00-04:00" }, end: { dateTime: "2026-10-23T09:15:00-04:00" } },
    { id: "c", summary: "Gone", status: "cancelled", start: { dateTime: "2026-10-23T10:00:00-04:00" }, end: { dateTime: "2026-10-23T11:00:00-04:00" } },
    { id: "d", summary: "Holiday", start: { date: "2026-10-23" }, end: { date: "2026-10-24" } },
  ]);
  const read = await readCalendarDays({ fetchImpl, accessToken: "tok", account: "a@example.invalid", from: "2026-10-23", days: 1, nonce: "live:x" });
  assert.deepEqual(read.days[0].busy, [
    { start: "2026-10-23T13:00:00.000Z", end: "2026-10-23T13:15:00.000Z" },
    { start: "2026-10-23T23:00:00.000Z", end: "2026-10-24T01:00:00.000Z" },
  ]);
  assert.equal(read.days[0].allDay, 1);
  assert.doesNotMatch(JSON.stringify(read.days[0].busy), /dinner|Standup|Somewhere|Gone/);
});

test("the live read refuses a bad range before asking Google", async () => {
  const { urls, fetchImpl } = google([]);
  for (const [from, days] of [["nope", 1], ["2026-10-23", 0], ["2026-10-23", 15]]) {
    await assert.rejects(readCalendarDays({ fetchImpl, accessToken: "t", account: "a", from, days, nonce: "n" }));
  }
  assert.equal(urls.length, 0);
});
