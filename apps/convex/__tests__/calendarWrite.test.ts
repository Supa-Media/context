/**
 * A calendar change a person's AI makes goes to that person's own Google
 * Calendar, only one that granted `calendar.events`, reaches exactly one
 * event with no guests, and the limits hold whatever the gateway asks
 * (`functions/lib/gatewayRoutes/calendarWrite.ts`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Dropping the `calendar.events` scope check in `claimCalendarWrite`. →
 *     "a calendar connected to read only changes nothing" fails.
 *  2. Dropping `hasGuests` from `findEvent`. → "an event with guests is never
 *     moved or cancelled" fails.
 *  3. Taking the first of several matches. → "a move that matches two events
 *     changes neither" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { CALENDAR_WRITE_HOURLY_LIMIT, CALENDAR_WRITE_SCOPE, readCalendarChange } from "../functions/lib/calendarWrite";

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Listed = { id: string; summary: string; start: { dateTime?: string; date?: string }; attendees?: Array<{ email: string; self?: boolean }> };

/** Google Calendar, answered here: `events` is what a listing returns. Each request, recorded. */
function calendar(events: Listed[] = [], status = 200) {
  const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://www.googleapis.com/calendar/")) return await realFetch(input, init);
    const method = init?.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET") return new Response(JSON.stringify({ items: events }), { status: 200 });
    return new Response(method === "DELETE" ? null : JSON.stringify({ id: "evt_fake" }), { status: method === "DELETE" && status === 200 ? 204 : status });
  });
  return calls;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

/** A calendar on Alice's workspace; `write` grants calendar.events, with a cached token. */
async function connectCalendar(t: Tenants["t"], workspaceId: Tenants["aliceWs"], boundBy: Tenants["alice"], { write = true } = {}) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy, address: "alice@gmail.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId });
  const read = "https://www.googleapis.com/auth/calendar.events.readonly";
  await t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["calendar"],
      scopes: write ? [read, CALENDAR_WRITE_SCOPE] : [read],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
}

async function connected(options: { write?: boolean } = {}) {
  const tenants = await twoConnectedTenants();
  await connectCalendar(tenants.t, tenants.aliceWs, tenants.alice, options);
  return tenants;
}

const CREATE = { action: "create", title: "Dentist", start: "2026-10-20T15:00:00-04:00", end: "2026-10-20T16:00:00-04:00", location: "Main St" };
const MOVE = { action: "move", title: "Dentist", start: "2026-10-20T15:00:00-04:00", new_start: "2026-10-21T15:00:00-04:00", new_end: "2026-10-21T16:00:00-04:00" };
const CANCEL = { action: "cancel", title: "Dentist", start: "2026-10-20T19:00:00Z" };
const DENTIST: Listed = { id: "evt_1", summary: "Dentist", start: { dateTime: "2026-10-20T15:00:00-04:00" } };

async function change(t: Tenants["t"], accessToken: string, workspaceId: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return await bodyOf(await gatewayPost(t, "/gateway/calendar/event", { accessToken, expectedWorkspaceId: workspaceId, change: body, ...extra }));
}

describe("changing the person's own calendar", () => {
  test("an event is added to their primary calendar, guests never emailed, nothing of it kept", async () => {
    const calls = calendar();
    const { t, aliceWs } = await connected();
    expect(await change(t, ACCESS_A, aliceWs, CREATE)).toEqual({ ok: true, calendar: "alice@gmail.example" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none");
    expect(calls[0]!.auth).toBe("Bearer ya29.fake-access-token");
    expect(calls[0]!.body).toEqual({
      summary: "Dentist",
      start: { dateTime: CREATE.start },
      end: { dateTime: CREATE.end },
      location: "Main St",
    });
    const kept = JSON.stringify(await t.run(async (ctx) => ({ limits: await ctx.db.query("rateLimits").collect(), audit: await ctx.db.query("auditEvents").collect() })));
    expect(kept).not.toContain("Dentist");
    expect(kept).toContain('"change":"create"');
  });

  test("a move finds the one event by title and start, and patches only its times", async () => {
    const calls = calendar([DENTIST, { id: "evt_2", summary: "Dentist follow-up", start: { dateTime: "2026-10-20T15:00:00-04:00" } }]);
    const { t, aliceWs } = await connected();
    expect((await change(t, ACCESS_A, aliceWs, MOVE)).ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_1?sendUpdates=none");
    expect(calls[1]!.body).toEqual({ start: { dateTime: MOVE.new_start }, end: { dateTime: MOVE.new_end } });
  });

  test("a cancel matches the same moment written in another offset", async () => {
    const calls = calendar([DENTIST]);
    const { t, aliceWs } = await connected();
    expect((await change(t, ACCESS_A, aliceWs, CANCEL)).ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
  });

  test("an event that is not there is reported, and spends nothing", async () => {
    const calls = calendar([]);
    const { t, aliceWs } = await connected();
    expect(await change(t, ACCESS_A, aliceWs, CANCEL)).toEqual({ ok: false, refused: "not_found" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    const limits = await t.run((ctx) => ctx.db.query("rateLimits").collect());
    expect(limits.filter((row) => row.key.startsWith("calendar_write."))).toHaveLength(0);
  });

  test("a move that matches two events changes neither", async () => {
    const calls = calendar([DENTIST, { ...DENTIST, id: "evt_3" }]);
    const { t, aliceWs } = await connected();
    expect(await change(t, ACCESS_A, aliceWs, MOVE)).toEqual({ ok: false, refused: "ambiguous" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  test("an event with guests is never moved or cancelled", async () => {
    const calls = calendar([{ ...DENTIST, attendees: [{ email: "alice@gmail.example", self: true }, { email: "jo@example.invalid" }] }]);
    const { t, aliceWs } = await connected();
    expect(await change(t, ACCESS_A, aliceWs, CANCEL)).toEqual({ ok: false, refused: "has_guests" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  test("a calendar connected to read only changes nothing", async () => {
    const calls = calendar();
    const { t, aliceWs } = await connected({ write: false });
    expect(await change(t, ACCESS_A, aliceWs, CREATE)).toEqual({ ok: false, refused: "no_calendar" });
    expect(await change(t, ACCESS_A, aliceWs, CREATE, { check: true })).toEqual({ ok: false, refused: "no_calendar" });
    expect(calls).toHaveLength(0);
  });

  test("another tenant's token, or a grant on a shared workspace, never reaches it", async () => {
    const calls = calendar();
    const { t, alice, aliceWs } = await connected();
    expect(await change(t, ACCESS_B, aliceWs, CREATE)).toEqual({ ok: false, refused: "not_allowed" });
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await change(t, ACCESS_A, shared, CREATE)).toEqual({ ok: false, refused: "not_allowed" });
    expect(calls).toHaveLength(0);
  });

  test("a check changes nothing and spends nothing; an hour holds five", async () => {
    const calls = calendar();
    const { t, aliceWs } = await connected();
    for (let i = 0; i < CALENDAR_WRITE_HOURLY_LIMIT + 2; i++) {
      expect(await change(t, ACCESS_A, aliceWs, CREATE, { check: true })).toEqual({ ok: true, calendar: "alice@gmail.example" });
    }
    expect(calls).toHaveLength(0);
    for (let i = 0; i < CALENDAR_WRITE_HOURLY_LIMIT; i++) expect((await change(t, ACCESS_A, aliceWs, CREATE)).ok).toBe(true);
    expect(await change(t, ACCESS_A, aliceWs, CREATE)).toEqual({ ok: false, refused: "hourly_limit" });
    expect(calls).toHaveLength(CALENDAR_WRITE_HOURLY_LIMIT);
  });

  test("a Google failure is reported, not called done", async () => {
    calendar([], 500);
    const { t, aliceWs } = await connected();
    expect(await change(t, ACCESS_A, aliceWs, CREATE)).toEqual({ ok: false, refused: "unavailable" });
  });
});

describe("what a change may be", () => {
  test("times carry their offset or are whole days, and nothing is guessed", () => {
    expect(readCalendarChange(CREATE)).not.toBeNull();
    expect(readCalendarChange({ ...CREATE, start: "2026-10-20T15:00:00" })).toBeNull();
    expect(readCalendarChange({ ...CREATE, start: "2026-10-20" })).toBeNull();
    expect(readCalendarChange({ ...CREATE, start: "2026-02-30T15:00:00Z" })).toBeNull();
    expect(readCalendarChange({ action: "create", title: "Trip", start: "2026-10-20", end: "2026-10-22" })).not.toBeNull();
    expect(readCalendarChange({ ...CREATE, end: CREATE.start })).toBeNull();
    expect(readCalendarChange({ ...CREATE, end: "2026-11-20T16:00:00-04:00" })).toBeNull();
    expect(readCalendarChange({ ...CREATE, title: "Hi\nthere" })).toBeNull();
    expect(readCalendarChange({ ...CREATE, notes: "a \u202e b" })).toBeNull();
    expect(readCalendarChange({ ...CANCEL, location: "x" })).toBeNull();
    expect(readCalendarChange({ ...MOVE, new_end: undefined })).toBeNull();
    expect(readCalendarChange({ ...CREATE, action: "invite" })).toBeNull();
  });
});
