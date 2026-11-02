/**
 * Calendar's narrower pair, `calendar.events.owned` and its read-only twin
 * (`AGENT_PRODUCT_SCOPES` / `standardScopesFor` in `lib/googleConnect/aiScopes.ts`; CASA least
 * scope, 2026-10-28).
 *
 * Every Calendar call Context makes is on the person's own `primary`
 * calendar, so the owned pair is enough. Every new request asks for it
 * (2026-10-30); a grant of either pair reads and writes, so no connection
 * made before has to reconnect.
 *
 * Sabotage (temporary local edits, reverted): `AGENT_PRODUCT_SCOPES` asking
 * the broad write fails "every new request asks for the owned pair ..."; `canWriteCalendar`
 * dropping the owned scope fails "an owned grant books the event ..." and
 * "the owned write counts as AI access ..."; `canWriteCalendar` dropping the
 * broad scope fails "grants of the broader pair keep ..."; `grantedScopesFor`
 * dropping the owned read fails "a standard grant of the owned read ...";
 * handing calendarLive.js a team calendar's id fails "the one request that
 * takes a calendar id ..."; narrowing Calendar's slice in `grantedScopesFor`
 * back to its read scopes fails both write-only "binds and reads" tests
 * (the bind's `canReadCalendar` and the slice share `CALENDAR_EVENT_SCOPES`,
 * so either one alone still binds); dropping Calendar from both
 * `standardGrantCovers` and `canReadProduct` fails the bind and read tests.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  CALENDAR_OWNED_READ_SCOPE,
  CALENDAR_OWNED_SCOPE,
  CALENDAR_SCOPES,
  CALENDAR_WRITE_SCOPE,
  IDENTITY_SCOPES,
  canReadCalendar,
  canWriteCalendar,
  grantedScopesFor,
} from "../../functions/lib/googleOAuth";
import { agentGrantCovers, agentScopesFor, canReadProduct, standardGrantCovers, standardScopesFor } from "../../functions/lib/googleConnect/aiScopes";
import { readOnlyServices } from "../../functions/lib/googleWriteAccess";
import { internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import { gatewayPost, seedGoogleConnection } from "../fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "../controlPlane/fixtures.helpers";

const CALENDAR_READ = CALENDAR_SCOPES[0];
const BROAD = {};
const OWNED = { GOOGLE_CALENDAR_SCOPE: "owned" };
const SWITCHED_OWNED = { ...OWNED, GOOGLE_AGENT_OAUTH_CLIENT_ID: "agent.apps.googleusercontent.example", GOOGLE_AGENT_CLIENT_ACTIVE: "true" };

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("what a connect asks Google for", () => {
  test("every new request asks for the owned pair and never the broader one, whatever the setting", () => {
    for (const env of [BROAD, OWNED, SWITCHED_OWNED]) {
      for (const [key, value] of Object.entries(env as Record<string, string>)) vi.stubEnv(key, value);
      const asked = [...agentScopesFor(["gmail", "calendar", "chat"]), ...standardScopesFor(["gmail", "calendar", "chat"])];
      expect(asked).toContain(CALENDAR_OWNED_READ_SCOPE);
      expect(asked).toContain(CALENDAR_OWNED_SCOPE);
      expect(asked).not.toContain(CALENDAR_READ);
      expect(asked).not.toContain(CALENDAR_WRITE_SCOPE);
      expect(agentScopesFor(["calendar"])).toEqual([...IDENTITY_SCOPES, CALENDAR_OWNED_SCOPE]);
      expect(standardScopesFor(["calendar"])).toEqual([...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE]);
      vi.unstubAllEnvs();
    }
  });
});

describe("what a grant lets Context do", () => {
  test("grants of the broader pair keep reading and writing whatever the setting", () => {
    vi.stubEnv("GOOGLE_CALENDAR_SCOPE", "owned");
    expect(canWriteCalendar([CALENDAR_READ, CALENDAR_WRITE_SCOPE])).toBe(true);
    expect(canReadCalendar([CALENDAR_READ])).toBe(true);
    expect(readOnlyServices({ gmail: false, calendar: true, chat: false }, [CALENDAR_READ, CALENDAR_WRITE_SCOPE])).toEqual([]);
    expect(agentGrantCovers(["calendar"], [CALENDAR_WRITE_SCOPE])).toBe(true);
  });

  test("the owned write counts as AI access and as a write; the owned read only as a read", () => {
    expect(agentGrantCovers(["calendar"], [CALENDAR_OWNED_SCOPE])).toBe(true);
    expect(agentGrantCovers(["calendar"], [CALENDAR_OWNED_READ_SCOPE])).toBe(false);
    expect(readOnlyServices({ gmail: false, calendar: true, chat: false }, [CALENDAR_OWNED_SCOPE])).toEqual([]);
    expect(readOnlyServices({ gmail: false, calendar: true, chat: false }, [CALENDAR_OWNED_READ_SCOPE])).toEqual(["calendar"]);
    for (const scope of [CALENDAR_READ, CALENDAR_WRITE_SCOPE, CALENDAR_OWNED_READ_SCOPE, CALENDAR_OWNED_SCOPE]) {
      expect(canReadProduct("calendar", [scope])).toBe(true);
    }
    expect(canReadProduct("calendar", [...IDENTITY_SCOPES])).toBe(false);
  });

  test("a standard grant of the owned read binds Calendar, as the broader read does", () => {
    expect(grantedScopesFor("calendar", [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE])).toEqual([CALENDAR_OWNED_READ_SCOPE]);
    expect(standardGrantCovers("calendar", [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE], SWITCHED_OWNED)).toBe(true);
    expect(standardGrantCovers("calendar", [...IDENTITY_SCOPES, CALENDAR_READ], SWITCHED_OWNED)).toBe(true);
    expect(standardGrantCovers("calendar", [...IDENTITY_SCOPES], SWITCHED_OWNED)).toBe(false);
  });
});

/**
 * Alice connects Calendar with a standard grant holding `scopes` (the console's
 * own bind), then AI reads her calendar through it, as it does for a row made
 * before the minimum consent: a new bind is `split`, and AI waits for its
 * agent grant (`googleConnect/consentPlan.test.ts`), so the row is marked as
 * one made before to read through the standard grant at all.
 */
async function bindAndRead(scopes: string[]) {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
  const { t, aliceWs, alice, grantA } = await twoConnectedTenants();
  const keyset = requireKeyset();
  const context = { workspaceId: aliceWs as string };
  const connectionId = await t.mutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
    workspaceId: aliceWs,
    boundBy: alice,
    address: "alice@gmail.example",
    googleAccountId: "google-alice",
    scopes: [...IDENTITY_SCOPES, ...scopes],
    encryptedRefreshToken: await encryptSecret("refresh-calendar", keyset, context),
    encryptedAccessToken: await encryptSecret("access-calendar", keyset, context),
    accessTokenExpiresAt: Date.now() + 3_600_000,
  });
  const row = await t.run((ctx) => ctx.db.get(connectionId));
  expect(row?.consentPlan).toBe("split");
  await t.run((ctx) => ctx.db.patch(connectionId, { consentPlan: undefined }));
  // Reading the person's calendar takes a grant that reaches private notes, as in personCalendar.test.ts.
  await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read", "context:write", "context:private"] }));
  const read = await t.mutation(internal.functions.personCalendar.claimPersonCalendarRead, {
    hashedAccessToken: await hashToken(ACCESS_A),
    expectedWorkspaceId: aliceWs as string,
  });
  return { row: row!, read };
}

describe("a Calendar connect binds and reads on whichever event scope the person kept", () => {
  test("a broad write-only consent binds and reads", async () => {
    const { row, read } = await bindAndRead([CALENDAR_WRITE_SCOPE]);
    expect(row.health).not.toBe("reconnect_required");
    expect(row.errorCode).toBeUndefined();
    expect(row.calendar?.scopes).toEqual([CALENDAR_WRITE_SCOPE]);
    expect(read).toMatchObject({ ok: true });
  });

  test("an owned write-only consent binds and reads", async () => {
    const { row, read } = await bindAndRead([CALENDAR_OWNED_SCOPE]);
    expect(row.health).not.toBe("reconnect_required");
    expect(row.errorCode).toBeUndefined();
    expect(row.calendar?.scopes).toEqual([CALENDAR_OWNED_SCOPE]);
    expect(read).toMatchObject({ ok: true });
  });

  test("a read-only consent of either pair binds and reads", async () => {
    for (const scope of [CALENDAR_READ, CALENDAR_OWNED_READ_SCOPE]) {
      const { row, read } = await bindAndRead([scope]);
      expect(row.errorCode).toBeUndefined();
      expect(row.calendar?.scopes).toEqual([scope]);
      expect(read).toMatchObject({ ok: true });
    }
  });

  test("an identity-only consent is refused as incomplete and reads nothing", async () => {
    const { row, read } = await bindAndRead([]);
    expect(row).toMatchObject({ health: "reconnect_required", errorCode: "SCOPES_INCOMPLETE" });
    expect(read).toMatchObject({ ok: false });
  });
});

describe("a change through an owned grant", () => {
  test("an owned grant books the event on the primary calendar, with nothing asked of Google first", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://oauth2.googleapis.com/")) throw new Error("no scope check expected for a grant that writes");
      if (!url.startsWith("https://www.googleapis.com/calendar/")) return await realFetch(input, init);
      calls.push({ method: init?.method ?? "GET", url });
      return new Response(JSON.stringify({ id: "evt_fake" }), { status: 200 });
    });
    const { t, aliceWs, alice } = await twoConnectedTenants();
    const id = await seedGoogleConnection(t, { workspaceId: aliceWs, boundBy: alice, address: "alice@gmail.example" });
    const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: aliceWs });
    await t.run((ctx) =>
      ctx.db.patch(id, {
        products: ["calendar"],
        scopes: [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE, CALENDAR_OWNED_SCOPE],
        encryptedAccessToken,
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      }),
    );
    const change = { action: "create", title: "Dentist", start: "2026-10-20T15:00:00-04:00", end: "2026-10-20T16:00:00-04:00" };
    const answer = await bodyOf(await gatewayPost(t, "/gateway/calendar/event", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, change }));
    expect(answer).toEqual({ ok: true, calendar: "alice@gmail.example" });
    expect(calls).toEqual([{ method: "POST", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none" }]);
  });
});

/** Every shipped source file under `dir`, tests and build output left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (["node_modules", "_generated", "__tests__", "test", "dist"].includes(name)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|js|mjs)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("the owned pair is enough because every call is on the primary calendar", () => {
  const repo = join(__dirname, "../../../..");
  const shipped = [join(repo, "apps/convex/functions"), join(repo, "apps/mcp/src"), join(repo, "apps/agent/src")].flatMap(sources);

  test("every Calendar request is to the primary calendar, or stops a push channel", () => {
    const urls = shipped.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/googleapis\.com\/calendar\/v3\/[^"'`\s]*/g)].map((match) => `${relative(repo, path)} ${match[0]}`),
    );
    expect(urls.sort()).toEqual([
      "apps/convex/functions/lib/gatewayRoutes/calendarEditRequest.ts googleapis.com/calendar/v3/calendars/primary/events",
      "apps/convex/functions/lib/googlePush/watch.ts googleapis.com/calendar/v3/calendars/primary/events/watch",
      "apps/convex/functions/lib/googlePush/watch.ts googleapis.com/calendar/v3/channels/stop",
      "apps/mcp/src/communications/calendar-google.js googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events",
    ]);
  });

  test("the one request that takes a calendar id is only ever handed the primary calendar", () => {
    const handed = shipped.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/calendarId:\s*([^,}\n]+)/g)].map((match) => `${relative(repo, path)} ${match[1]!.trim()}`),
    );
    expect(handed.sort()).toEqual([
      "apps/convex/functions/lib/filesFns/forwardSync.ts \"primary\"",
      "apps/convex/functions/meetingCalendar.ts \"primary\"",
      "apps/convex/functions/meetingCalendar.ts \"primary\"",
      // JSDoc parameter types, not values.
      "apps/mcp/src/communications/calendar-google.js string",
      "apps/mcp/src/communications/calendar-google.js string",
      "apps/mcp/src/communications/calendar-sync.js connection.calendarId",
      "apps/mcp/src/communications/calendar-sync.js connection.calendarId",
      "apps/mcp/src/communications/calendarLive.js \"primary\"",
      "apps/mcp/src/communications/calendarLive.js \"primary\"",
    ]);
  });
});
