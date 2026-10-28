/**
 * Tex edits any part of an existing event, answers invites, and gives new
 * events reminders and repeats (`functions/lib/calendarEdit.ts`,
 * `functions/lib/gatewayRoutes/calendarEditRequest.ts`). The owner,
 * 2026-10-23, after Tex told them to add a party's address themselves "since
 * I can't edit an existing event's location": "why can't tex edit calendar
 * items".
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `whoHears` dropping the `mayModify` check. → "an invite somebody else
 *     organizes is never edited, and says why" fails.
 *  2. `whoHears` naming nobody for an edit that adds guests. → "adding a
 *     guest names them, and goes only with notify_guests" fails.
 *  3. `existingEventRequest` patching the one time instead of the series on
 *     `all_events`. → "all_events moves the whole series by as much" fails.
 *  4. `matchingEvents` without the loose match. → "a title written a little
 *     differently still finds the one event at that moment" fails.
 *  5. `existingEventRequest` asking calendars.get for the zone again (which
 *     needs calendar.readonly, never granted). → "making a one-off event
 *     repeat names the calendar's time zone, as Google needs" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { gatewayPost } from "./fixtures.helpers";
import { CALENDAR_WRITE_SCOPE, readCalendarChange } from "../functions/lib/calendarWrite";

const realFetch = globalThis.fetch;
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Event = Record<string, any>;

/**
 * Google Calendar, answered per token: `lists[token]` is what that account's
 * listing returns, `masters` the series read by id. Each request, recorded.
 */
function calendar({ lists, masters = {}, zone = "America/New_York", status = 200 }: { lists: Record<string, Event[]>; masters?: Record<string, Event>; zone?: string; status?: number }) {
  const calls: Array<{ method: string; url: string; token: string; body: any }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://www.googleapis.com/calendar/")) return await realFetch(input, init);
    const method = init?.method ?? "GET";
    const token = (new Headers(init?.headers).get("Authorization") ?? "").replace("Bearer ", "");
    calls.push({ method, url, token, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET" && url.startsWith(`${EVENTS}?`)) return new Response(JSON.stringify({ timeZone: zone, items: lists[token] ?? [] }));
    if (method === "GET" && url.startsWith(`${EVENTS}/`)) {
      const id = decodeURIComponent(url.slice(EVENTS.length + 1).split("?")[0]!);
      return masters[id] ? new Response(JSON.stringify(masters[id])) : new Response("{}", { status: 404 });
    }
    // calendars.get takes calendar.readonly or wider, never the event scopes a
    // connection grants, so Google refuses it as it would for real.
    if (method === "GET") return new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }), { status: 403 });
    return new Response(JSON.stringify({ id: "evt_fake", hangoutLink: "https://meet.google.com/abc-defg-hij" }), { status });
  });
  return calls;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function connectCalendar(t: Tenants["t"], workspaceId: Tenants["aliceWs"], boundBy: Tenants["alice"], address: string, token: string) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy, address });
  const encryptedAccessToken = await encryptSecret(token, requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["calendar"],
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly", CALENDAR_WRITE_SCOPE],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
}

async function connected() {
  const tenants = await twoConnectedTenants();
  await connectCalendar(tenants.t, tenants.aliceWs, tenants.alice, "alice@gmail.example", "ya29.alice");
  return tenants;
}

async function change(t: Tenants["t"], workspaceId: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return await bodyOf(await gatewayPost(t, "/gateway/calendar/event", { accessToken: ACCESS_A, expectedWorkspaceId: workspaceId, change: body, ...extra }));
}

const START = "2026-10-24T19:00:00-04:00";
const PARTY: Event = { id: "evt_party", summary: "Lau's Birthday", start: { dateTime: START }, end: { dateTime: "2026-10-24T23:00:00-04:00" }, description: "https://partiful.com/e/fake" };
const SELF = { email: "alice@gmail.example", self: true };

describe("editing an existing event", () => {
  test("the owner's party gets its address, and nothing else of it changes", async () => {
    const calls = calendar({ lists: { "ya29.alice": [PARTY] } });
    const { t, aliceWs } = await connected();
    const edit = { action: "edit", title: "Lau's Birthday", start: START, location: "150 McGuinness Blvd Apt 2, Brooklyn" };
    expect(await change(t, aliceWs, edit, { check: true })).toEqual({ ok: true, calendar: "alice@gmail.example", guests: [] });
    expect(await change(t, aliceWs, edit)).toEqual({ ok: true, calendar: "alice@gmail.example" });
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe(`${EVENTS}/evt_party?sendUpdates=none`);
    expect(patch.body).toEqual({ location: "150 McGuinness Blvd Apt 2, Brooklyn" });
  });

  test("a title written a little differently still finds the one event at that moment", async () => {
    calendar({ lists: { "ya29.alice": [PARTY, { ...PARTY, id: "evt_other", summary: "Dinner", start: { dateTime: "2026-10-24T20:00:00-04:00" } }] } });
    const { t, aliceWs } = await connected();
    expect((await change(t, aliceWs, { action: "edit", title: "Lau's party", start: START, location: "150 McGuinness" })).ok).toBe(true);
    expect(await change(t, aliceWs, { action: "edit", title: "Brunch", start: START, location: "x" })).toEqual({ ok: false, refused: "not_found" });
  });

  test("every field at once: title, time, notes, reminders, a Meet, and taking the location off", async () => {
    const calls = calendar({ lists: { "ya29.alice": [{ ...PARTY, location: "TBD" }] } });
    const { t, aliceWs } = await connected();
    const edit = {
      action: "edit",
      title: "Lau's Birthday",
      start: START,
      new_title: "Lau's 30th",
      new_start: "2026-10-24T20:00:00-04:00",
      new_end: "2026-10-25T00:00:00-04:00",
      notes: "Bring a gift",
      location: "",
      reminders: [30, 120],
      meet: true,
    };
    expect(await change(t, aliceWs, edit)).toEqual({ ok: true, calendar: "alice@gmail.example", meet: "https://meet.google.com/abc-defg-hij" });
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe(`${EVENTS}/evt_party?sendUpdates=none&conferenceDataVersion=1`);
    expect(patch.body).toMatchObject({
      summary: "Lau's 30th",
      start: { dateTime: "2026-10-24T20:00:00-04:00" },
      end: { dateTime: "2026-10-25T00:00:00-04:00" },
      description: "Bring a gift",
      location: "",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }, { method: "popup", minutes: 120 }] },
    });
    expect(patch.body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: "hangoutsMeet" });
  });

  test("adding a guest names them, and goes only with notify_guests", async () => {
    const calls = calendar({ lists: { "ya29.alice": [PARTY] } });
    const { t, aliceWs } = await connected();
    const edit = { action: "edit", title: "Lau's Birthday", start: START, add_guests: ["sam@example.invalid"] };
    expect(await change(t, aliceWs, edit, { check: true })).toEqual({ ok: true, calendar: "alice@gmail.example", guests: ["sam@example.invalid"] });
    expect(await change(t, aliceWs, edit)).toEqual({ ok: false, refused: "has_guests" });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect((await change(t, aliceWs, { ...edit, notify_guests: true })).ok).toBe(true);
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe(`${EVENTS}/evt_party?sendUpdates=all`);
    expect(patch.body).toEqual({ attendees: [{ email: "sam@example.invalid" }] });
  });

  test("removing a guest keeps everybody else as Google had them", async () => {
    const guests = [SELF, { email: "jo@example.invalid", responseStatus: "accepted" }, { email: "sam@example.invalid" }];
    const calls = calendar({ lists: { "ya29.alice": [{ ...PARTY, attendees: guests, organizer: { self: true } }] } });
    const { t, aliceWs } = await connected();
    expect((await change(t, aliceWs, { action: "edit", title: "Lau's Birthday", start: START, remove_guests: ["SAM@example.invalid"], notify_guests: true })).ok).toBe(true);
    expect(calls.find((call) => call.method === "PATCH")!.body).toEqual({ attendees: [SELF, { email: "jo@example.invalid", responseStatus: "accepted" }] });
  });

  test("a reminder on an event with guests is the person's own, and tells nobody", async () => {
    const calls = calendar({ lists: { "ya29.alice": [{ ...PARTY, attendees: [SELF, { email: "jo@example.invalid" }], organizer: { email: "jo@example.invalid" } }] } });
    const { t, aliceWs } = await connected();
    expect(await change(t, aliceWs, { action: "edit", title: "Lau's Birthday", start: START, reminders: [60] })).toEqual({ ok: true, calendar: "alice@gmail.example" });
    expect(calls.find((call) => call.method === "PATCH")!.url).toBe(`${EVENTS}/evt_party?sendUpdates=none`);
  });

  test("an invite somebody else organizes is never edited, and says why", async () => {
    const calls = calendar({ lists: { "ya29.alice": [{ ...PARTY, attendees: [SELF, { email: "lau@example.invalid" }], organizer: { email: "lau@example.invalid" } }] } });
    const { t, aliceWs } = await connected();
    const edit = { action: "edit", title: "Lau's Birthday", start: START, location: "150 McGuinness" };
    expect(await change(t, aliceWs, edit, { check: true })).toEqual({ ok: false, refused: "not_organizer" });
    expect(await change(t, aliceWs, { ...edit, notify_guests: true })).toEqual({ ok: false, refused: "not_organizer" });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  test("an event on the person's second Google account is found there and changed there", async () => {
    const calls = calendar({ lists: { "ya29.alice": [], "ya29.work": [PARTY] } });
    const { t, alice, aliceWs } = await connected();
    await connectCalendar(t, aliceWs, alice, "alice@work.example", "ya29.work");
    expect(await change(t, aliceWs, { action: "edit", title: "Lau's Birthday", start: START, location: "x" })).toEqual({ ok: true, calendar: "alice@work.example" });
    expect(calls.find((call) => call.method === "PATCH")!.token).toBe("ya29.work");
  });
});

describe("choosing the calendar", () => {
  test("a new event goes on the account named, and an address they never connected is refused", async () => {
    const calls = calendar({ lists: {} });
    const { t, alice, aliceWs } = await connected();
    await connectCalendar(t, aliceWs, alice, "alice@work.example", "ya29.work");
    const create = { action: "create", title: "Lau Bday", start: START, end: "2026-10-24T20:45:00-04:00", calendar: "Alice@Work.example" };
    expect(await change(t, aliceWs, create, { check: true })).toEqual({ ok: true, calendar: "alice@work.example" });
    expect(await change(t, aliceWs, create)).toEqual({ ok: true, calendar: "alice@work.example" });
    expect(calls.find((call) => call.method === "POST")!.token).toBe("ya29.work");
    expect(await change(t, aliceWs, { ...create, calendar: "someone@else.example" })).toEqual({ ok: false, refused: "other_calendar" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});

describe("repeating events", () => {
  const INSTANCE: Event = { id: "evt_s_20261027", summary: "Standup", recurringEventId: "evt_s", start: { dateTime: "2026-10-27T09:00:00-04:00" }, end: { dateTime: "2026-10-27T09:15:00-04:00" } };
  const MASTER: Event = {
    id: "evt_s",
    summary: "Standup",
    start: { dateTime: "2026-10-06T09:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-10-06T09:15:00-04:00", timeZone: "America/New_York" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=20"],
  };

  test("all_events moves the whole series by as much", async () => {
    const calls = calendar({ lists: { "ya29.alice": [INSTANCE] }, masters: { evt_s: MASTER } });
    const { t, aliceWs } = await connected();
    const move = { action: "edit", title: "Standup", start: INSTANCE.start.dateTime, new_start: "2026-10-27T10:00:00-04:00", new_end: "2026-10-27T10:30:00-04:00", all_events: true };
    expect((await change(t, aliceWs, move)).ok).toBe(true);
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe(`${EVENTS}/evt_s?sendUpdates=none`);
    expect(patch.body).toEqual({
      start: { dateTime: "2026-10-06T14:00:00.000Z", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-06T14:30:00.000Z", timeZone: "America/New_York" },
    });
  });

  test("without all_events only that one time changes", async () => {
    const calls = calendar({ lists: { "ya29.alice": [INSTANCE] }, masters: { evt_s: MASTER } });
    const { t, aliceWs } = await connected();
    expect((await change(t, aliceWs, { action: "edit", title: "Standup", start: INSTANCE.start.dateTime, location: "Room 2" })).ok).toBe(true);
    expect(calls.find((call) => call.method === "PATCH")!.url).toBe(`${EVENTS}/evt_s_20261027?sendUpdates=none`);
  });

  test("stopping a repeat keeps this time and the ones before it", async () => {
    const calls = calendar({ lists: { "ya29.alice": [INSTANCE] }, masters: { evt_s: MASTER } });
    const { t, aliceWs } = await connected();
    expect((await change(t, aliceWs, { action: "edit", title: "Standup", start: INSTANCE.start.dateTime, recurrence: [] })).ok).toBe(true);
    expect(calls.find((call) => call.method === "PATCH")!.body).toEqual({ recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261027T130000Z"] });
  });

  test("making a one-off event repeat names the calendar's time zone, as Google needs", async () => {
    const calls = calendar({ lists: { "ya29.alice": [PARTY] }, zone: "America/Chicago" });
    const { t, aliceWs } = await connected();
    expect((await change(t, aliceWs, { action: "edit", title: "Lau's Birthday", start: START, recurrence: ["RRULE:FREQ=YEARLY"] })).ok).toBe(true);
    expect(calls.find((call) => call.method === "PATCH")!.body).toEqual({
      recurrence: ["RRULE:FREQ=YEARLY"],
      start: { dateTime: START, timeZone: "America/Chicago" },
      end: { dateTime: "2026-10-24T23:00:00-04:00", timeZone: "America/Chicago" },
    });
    // The zone comes from the events listing, read under the event scope; the
    // calendar itself (calendars.get) is never asked.
    expect(calls.filter((call) => call.method === "GET" && !call.url.startsWith(EVENTS))).toEqual([]);
  });
});

describe("answering an invite", () => {
  const INVITE: Event = { ...PARTY, organizer: { email: "lau@example.invalid", displayName: "Lau" }, attendees: [{ ...SELF, responseStatus: "needsAction" }, { email: "lau@example.invalid", organizer: true }] };

  test("an RSVP tells the organizer, so it goes only with the person's yes, and changes only their own answer", async () => {
    const calls = calendar({ lists: { "ya29.alice": [INVITE] } });
    const { t, aliceWs } = await connected();
    const rsvp = { action: "rsvp", title: "Lau's Birthday", start: START, response: "accepted" };
    expect(await change(t, aliceWs, rsvp, { check: true })).toEqual({ ok: true, calendar: "alice@gmail.example", guests: ["Lau"] });
    expect(await change(t, aliceWs, rsvp)).toEqual({ ok: false, refused: "has_guests" });
    expect((await change(t, aliceWs, { ...rsvp, notify_guests: true })).ok).toBe(true);
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.url).toBe(`${EVENTS}/evt_party?sendUpdates=all`);
    expect(patch.body).toEqual({ attendees: [{ ...SELF, responseStatus: "accepted" }, { email: "lau@example.invalid", organizer: true }] });
  });

  test("there is nothing to answer on the person's own event", async () => {
    calendar({ lists: { "ya29.alice": [PARTY] } });
    const { t, aliceWs } = await connected();
    expect(await change(t, aliceWs, { action: "rsvp", title: "Lau's Birthday", start: START, response: "declined" }, { check: true })).toEqual({ ok: false, refused: "not_invited" });
  });
});

describe("what an edit may be", () => {
  const EDIT = { action: "edit", title: "Party", start: START };
  test("at least one change, each the right shape, and nothing a create or a move takes instead", () => {
    expect(readCalendarChange(EDIT)).toBeNull();
    expect(readCalendarChange({ ...EDIT, location: "x" })?.edit).toEqual({ location: "x" });
    expect(readCalendarChange({ ...EDIT, location: "" })?.edit).toEqual({ location: "" });
    expect(readCalendarChange({ ...EDIT, new_start: START })).toBeNull();
    expect(readCalendarChange({ ...EDIT, end: START, location: "x" })).toBeNull();
    expect(readCalendarChange({ ...EDIT, guests: ["a@example.invalid"] })).toBeNull();
    expect(readCalendarChange({ ...EDIT, add_guests: ["a@example.invalid"], remove_guests: ["A@example.invalid"] })).toBeNull();
    expect(readCalendarChange({ ...EDIT, reminders: [10, 10] })).toBeNull();
    expect(readCalendarChange({ ...EDIT, reminders: [50_000] })).toBeNull();
    expect(readCalendarChange({ ...EDIT, reminders: [] })?.edit).toEqual({ reminders: [] });
    expect(readCalendarChange({ ...EDIT, recurrence: ["FREQ=WEEKLY"] })).toBeNull();
    expect(readCalendarChange({ ...EDIT, recurrence: ["RRULE:FREQ=WEEKLY\nX"] })).toBeNull();
    expect(readCalendarChange({ ...EDIT, response: "accepted", location: "x" })).toBeNull();
    expect(readCalendarChange({ action: "create", title: "x", start: START, end: "2026-10-24T20:00:00-04:00", recurrence: [] })).toBeNull();
    expect(readCalendarChange({ action: "create", title: "x", start: START, end: "2026-10-24T20:00:00-04:00", all_events: true })).toBeNull();
    expect(readCalendarChange({ action: "rsvp", title: "x", start: START, response: "maybe" })).toBeNull();
    expect(readCalendarChange({ action: "rsvp", title: "x", start: START, response: "tentative", location: "y" })).toBeNull();
    expect(readCalendarChange({ action: "move", title: "x", start: START, new_start: START, new_end: "2026-10-24T20:00:00-04:00", reminders: [5] })).toBeNull();
  });
});
