/**
 * A person's calendar, read live from their own Google Calendar, since
 * nothing of it is copied into their notes any more
 * (`functions/lib/gatewayRoutes/personCalendar.ts`, owner 2026-10-21).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Dropping the `context:private` check in `personalOwnerReadClearance`. →
 *     "a grant without private access reads no calendar" fails.
 *  2. Dropping the owner check. → "an editor of the person's workspace never
 *     reaches their calendar" fails.
 *  3. Dropping the rate limit. → "an hour holds a bounded number of reads" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { addMember, createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { PERSON_CALENDAR_READS_PER_HOUR } from "../functions/personCalendar";

const realFetch = globalThis.fetch;
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Google Calendar holding one Friday dinner; every request's URL is recorded. */
function calendar(status = 200) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://www.googleapis.com/calendar/")) return await realFetch(input, init);
    urls.push(new URL(url));
    if (status !== 200) return new Response("{}", { status });
    return new Response(
      JSON.stringify({
        timeZone: "America/New_York",
        items: [{ id: "e1", summary: "Dinner with Ada", start: { dateTime: "2026-10-23T19:00:00-04:00" }, end: { dateTime: "2026-10-23T21:00:00-04:00" } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return urls;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

/** Alice's calendar with a cached token, and her grant with private access. */
async function connected() {
  const tenants = await twoConnectedTenants();
  const { t, alice, aliceWs, grantA } = tenants;
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
  await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read", "context:write", "context:private"] }));
  return { ...tenants, connectionId: id };
}

async function days(t: Tenants["t"], accessToken: string, workspaceId: string, extra: Record<string, unknown> = {}) {
  return await bodyOf(await gatewayPost(t, "/gateway/calendar/days", { accessToken, expectedWorkspaceId: workspaceId, date: "2026-10-23", ...extra }));
}

describe("reading a person's own calendar live", () => {
  test("a day comes back rendered from Google, and nothing of it is kept", async () => {
    const urls = calendar();
    const { t, aliceWs } = await connected();
    const answer = await days(t, ACCESS_A, aliceWs, { days: 2 });
    expect(answer.ok).toBe(true);
    const list = answer.days as Array<{ address: string; date: string; events: number; text: string; timezone: string }>;
    expect(list.map((day) => [day.address, day.date, day.events])).toEqual([
      ["alice@gmail.example", "2026-10-23", 1],
      ["alice@gmail.example", "2026-10-24", 0],
    ]);
    expect(list[0]!.text).toContain("Dinner with Ada");
    expect(list[0]!.timezone).toBe("America/New_York");
    expect(urls[0]!.pathname).toBe("/calendar/v3/calendars/primary/events");
    const stored = JSON.stringify(
      await t.run(async (ctx) => ({ limits: await ctx.db.query("rateLimits").collect(), audit: await ctx.db.query("auditEvents").collect() })),
    );
    expect(stored).not.toContain("Ada");
  });

  test("a bad date or day count is refused before Google is asked", async () => {
    const urls = calendar();
    const { t, aliceWs } = await connected();
    for (const extra of [{ date: "friday" }, { days: 0 }, { days: 15 }, { days: "2" }]) {
      expect(await days(t, ACCESS_A, aliceWs, extra)).toEqual({ ok: false, refused: "invalid" });
    }
    expect(urls).toHaveLength(0);
  });

  test("Google failing is unavailable, never an empty day", async () => {
    calendar(500);
    const { t, aliceWs } = await connected();
    expect(await days(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "unavailable" });
  });

  test("with no calendar connected it says so", async () => {
    const urls = calendar();
    const { t, aliceWs, connectionId } = await connected();
    await t.run((ctx) => ctx.db.patch(connectionId, { products: ["gmail"] }));
    expect(await days(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_calendar" });
    await t.run((ctx) => ctx.db.patch(connectionId, { products: ["calendar"], disconnectedAt: Date.now() }));
    expect(await days(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_calendar" });
    expect(urls).toHaveLength(0);
  });

  test("a calendar whose sign-in stopped working is named for reconnecting", async () => {
    const urls = calendar();
    const { t, aliceWs, connectionId } = await connected();
    await t.run((ctx) => ctx.db.patch(connectionId, { health: "reconnect_required" }));
    expect(await days(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "reconnect_required", reconnect: ["alice@gmail.example"] });
    expect(urls).toHaveLength(0);
  });

  test("a grant without private access reads no calendar", async () => {
    const urls = calendar();
    const { t, aliceWs, grantA } = await connected();
    await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read", "context:write"] }));
    expect(await days(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(urls).toHaveLength(0);
  });

  test("another tenant's token never reaches the person's calendar", async () => {
    const urls = calendar();
    const { t, aliceWs } = await connected();
    expect(await days(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(urls).toHaveLength(0);
  });

  test("an editor of the person's workspace never reaches their calendar", async () => {
    const urls = calendar();
    const { t, aliceWs, bob, grantB } = await connected();
    await addMember(t, aliceWs, bob, "editor");
    await t.run((ctx) => ctx.db.patch(grantB, { scopes: ["context:read", "context:write", "context:private"] }));
    expect(await days(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(urls).toHaveLength(0);
  });

  test("a grant on a shared workspace never reaches its person's own calendar", async () => {
    const urls = calendar();
    const { t, alice } = await connected();
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await days(t, ACCESS_A, shared)).toEqual({ ok: false, refused: "not_allowed" });
    expect(urls).toHaveLength(0);
  });

  test("an hour holds a bounded number of reads", async () => {
    const urls = calendar();
    const { t, aliceWs } = await connected();
    const owner = await t.run(async (ctx) => (await ctx.db.get(aliceWs))!.createdBy);
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", { key: `person.calendar.read:${owner}`, windowStartedAt: Date.now(), count: PERSON_CALENDAR_READS_PER_HOUR }),
    );
    expect(await days(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "rate_limited", reconnect: [] });
    expect(urls).toHaveLength(0);
  });
});
