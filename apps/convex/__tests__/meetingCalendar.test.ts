/**
 * The meetings on a person's own calendars, for "Join and take notes"
 * (`functions/meetingCalendar.ts`), read live from Google.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Dropping the personal-owner check (any membership's workspace). →
 *     "an editor of somebody's personal workspace never sees their meetings" fails.
 *  2. Dropping the rate limit. → "an hour holds a bounded number of reads" fails.
 *  3. Dropping the window bound. → "a window wider than two days is refused before Google is asked" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { MEETING_CALENDAR_READS_PER_HOUR } from "../functions/meetingCalendar";

const realFetch = globalThis.fetch;
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ITEMS = [
  {
    id: "lw",
    summary: "Leadership Weekly",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    start: { dateTime: "2026-10-28T14:00:00-04:00" },
    end: { dateTime: "2026-10-28T15:00:00-04:00" },
    attendees: [{ email: "alice@gmail.example", self: true, responseStatus: "accepted" }, { email: "zay@example.test", displayName: "Zay" }],
  },
  { id: "hold", summary: "Focus", start: { dateTime: "2026-10-28T10:00:00-04:00" }, end: { dateTime: "2026-10-28T12:00:00-04:00" } },
  { id: "bday", summary: "Ada's birthday", start: { date: "2026-10-28" }, end: { date: "2026-10-29" } },
  {
    id: "phish",
    summary: "Urgent",
    location: "https://meet.google.com.evil.example/join",
    start: { dateTime: "2026-10-28T16:00:00-04:00" },
    end: { dateTime: "2026-10-28T16:30:00-04:00" },
  },
];

function calendar(status = 200) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://www.googleapis.com/calendar/")) return await realFetch(input, init);
    urls.push(new URL(url));
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ timeZone: "America/New_York", items: ITEMS }), { headers: { "content-type": "application/json" } });
  });
  return urls;
}

async function connected() {
  const tenants = await twoConnectedTenants();
  const { t, alice, aliceWs } = tenants;
  const id = await seedGoogleConnection(t, { workspaceId: aliceWs, boundBy: alice, address: "alice@gmail.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: aliceWs });
  await t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["calendar"],
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + HOUR,
    }),
  );
  return { ...tenants, connectionId: id };
}

const FROM = Date.parse("2026-10-28T04:00:00Z");
const TO = Date.parse("2026-10-29T04:00:00Z");

function at(t: Awaited<ReturnType<typeof connected>>["t"], userId: string) {
  return t.withIdentity({ subject: userId });
}

describe("meetings to join, from the person's own calendars", () => {
  test("only real meetings come back, with a join link only on a known call host", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    const urls = calendar();
    const { t, alice } = await connected();
    const answer = await at(t, alice).action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: TO });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.meetings.map((m: { title: string }) => m.title)).toEqual(["Leadership Weekly"]);
    expect(answer.meetings[0]).toMatchObject({
      id: "alice@gmail.example:lw",
      startsAt: "2026-10-28T18:00:00.000Z",
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      account: "alice@gmail.example",
    });
    expect(urls).toHaveLength(1);
    const stored = JSON.stringify(await t.run(async (ctx) => ({ audit: await ctx.db.query("auditEvents").collect() })));
    expect(stored).not.toContain("Leadership");
  });

  test("signed out is refused", async () => {
    calendar();
    const { t } = await connected();
    await expect(t.action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: TO })).rejects.toThrow();
  });

  test("a window wider than two days is refused before Google is asked", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    const urls = calendar();
    const { t, alice } = await connected();
    const read = at(t, alice);
    expect(await read.action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: FROM + 3 * 24 * HOUR })).toEqual({ ok: false, refused: "invalid" });
    expect(await read.action(api.functions.meetingCalendar.upcomingMeetings, { from: TO, to: FROM })).toEqual({ ok: false, refused: "invalid" });
    expect(urls).toHaveLength(0);
  });

  test("an editor of somebody's personal workspace never sees their meetings", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    const urls = calendar();
    const { t, aliceWs, bob, alice } = await connected();
    await addMember(t, aliceWs, bob, "editor", alice);
    expect(await at(t, bob).action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: TO })).toEqual({ ok: false, refused: "no_calendar" });
    expect(urls).toHaveLength(0);
  });

  test("Google failing is unavailable, never an empty day", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    calendar(500);
    const { t, alice } = await connected();
    expect(await at(t, alice).action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: TO })).toEqual({ ok: false, refused: "unavailable" });
  });

  test("a calendar whose sign-in stopped working is named, not read as empty", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    const urls = calendar();
    const { t, alice, connectionId } = await connected();
    await t.run((ctx) => ctx.db.patch(connectionId, { health: "reconnect_required" }));
    expect(await at(t, alice).action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: TO })).toEqual({
      ok: true,
      meetings: [],
      reconnect: ["alice@gmail.example"],
      unanswered: [],
    });
    expect(urls).toHaveLength(0);
  });

  test("an hour holds a bounded number of reads", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    calendar();
    const { t, alice } = await connected();
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", { key: `meeting.calendar.read:${alice}`, windowStartedAt: Date.now(), count: MEETING_CALENDAR_READS_PER_HOUR }),
    );
    expect(await at(t, alice).action(api.functions.meetingCalendar.upcomingMeetings, { from: FROM, to: TO })).toEqual({ ok: false, refused: "rate_limited" });
  });
});
