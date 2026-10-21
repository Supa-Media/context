import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { usageAnalytics, usageQueries, windowDays } from "../functions/lib/adminFns/usageAnalytics";
import { clampUsageDays } from "../functions/usageAnalytics";

/**
 * THE USAGE TAB'S READ OF POSTHOG.
 *
 * Driven through a stub fetch: the key goes only to PostHog's query endpoint
 * and only in its header, a missing key reads as "not connected", PostHog's
 * own error text never reaches the screen, and nothing but cleaned routes and
 * the fixed button names comes back — whatever PostHog holds. All keys and
 * figures are invented.
 */

const ENV = { POSTHOG_PERSONAL_API_KEY: "phx_fixture_key_not_real", POSTHOG_PROJECT_ID: "12345" };
const NOW = Date.UTC(2026, 9, 21, 15, 30);

type Name = "daily" | "sites" | "time" | "pages" | "buttons";

/** Answers each query by which question it asks, and records every call. */
function posthog(rows: Partial<Record<Name, unknown[][]>>, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queries = usageQueries(7, NOW);
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (status !== 200) return new Response("syntax error near SELECT secret_column", { status });
    const asked = (JSON.parse(String(init.body)) as { query: { query: string } }).query.query;
    const name = (Object.keys(queries) as Name[]).find((key) => queries[key] === asked);
    return new Response(JSON.stringify({ results: name === undefined ? [] : rows[name] ?? [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("connecting", () => {
  test("no key is not connected, and nothing is asked", async () => {
    const { calls, fetchImpl } = posthog({});
    expect(await usageAnalytics({}, 7, { fetchImpl, now: NOW })).toEqual({ connected: false });
    expect(await usageAnalytics({ POSTHOG_PERSONAL_API_KEY: "  " }, 7, { fetchImpl, now: NOW })).toEqual({ connected: false });
    expect(calls).toHaveLength(0);
  });

  test("the key goes to PostHog's query endpoint, in the header and nowhere else", async () => {
    const { calls, fetchImpl } = posthog({});
    await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.url).toBe("https://us.posthog.com/api/projects/12345/query/");
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ENV.POSTHOG_PERSONAL_API_KEY}`);
      expect(String(call.init.body)).not.toContain(ENV.POSTHOG_PERSONAL_API_KEY);
    }
  });

  test("a project id that is not a number is not put in the address", async () => {
    const { calls, fetchImpl } = posthog({});
    await usageAnalytics({ ...ENV, POSTHOG_PROJECT_ID: "1/../../other" }, 7, { fetchImpl, now: NOW });
    expect(calls[0].url).toBe("https://us.posthog.com/api/projects/@current/query/");
  });

  test("a refusal is reported in our words, never PostHog's", async () => {
    for (const [status, words] of [
      [401, "PostHog refused the key; check it can read queries"],
      [429, "PostHog asked us to slow down; try again in a minute"],
      [500, "PostHog answered 500"],
    ] as const) {
      const { fetchImpl } = posthog({}, status);
      const result = await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
      expect(result).toEqual({ connected: true, error: words });
      expect(JSON.stringify(result)).not.toContain("secret_column");
    }
  });

  test("an unreachable PostHog is an answer, not a thrown error", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await usageAnalytics(ENV, 7, { fetchImpl, now: NOW })).toEqual({
      connected: true,
      error: "PostHog could not be reached",
    });
  });
});

describe("what is asked", () => {
  test("only production: our two hosts, or a native build that says it is production", () => {
    const queries = usageQueries(30, NOW);
    for (const query of [queries.time, queries.pages, queries.buttons]) {
      expect(query).toContain("properties.$host IN ('context.lc', 'tex.lc')");
      expect(query).toContain("properties.app_env = 'production'");
    }
    // The site cards are the hosts and nothing else.
    expect(queries.daily).toContain("properties.$host IN ('context.lc', 'tex.lc')");
    expect(queries.daily).not.toContain("app_env");
  });

  test("the window ends tonight, and the one before it is the same length", () => {
    const queries = usageQueries(7, NOW);
    expect(queries.sites).toContain("timestamp >= toDateTime('2026-10-08 00:00:00', 'UTC')");
    expect(queries.sites).toContain("timestamp >= toDateTime('2026-10-15 00:00:00', 'UTC')");
    expect(queries.sites).toContain("timestamp < toDateTime('2026-10-22 00:00:00', 'UTC')");
    expect(queries.pages).not.toContain("2026-10-08");
    expect(windowDays(7, NOW)).toEqual([
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
    ]);
  });

  test("the days asked for are held to the picker's range", () => {
    expect(clampUsageDays(undefined)).toBe(30);
    expect(clampUsageDays(Number.NaN)).toBe(30);
    expect(clampUsageDays(0)).toBe(1);
    expect(clampUsageDays(10_000)).toBe(90);
    expect(clampUsageDays(7)).toBe(7);
  });
});

describe("what comes back", () => {
  test("site cards, every day of the window, and the window before", async () => {
    const { fetchImpl } = posthog({
      daily: [
        ["context.lc", "2026-10-16", 4],
        ["context.lc", "2026-10-21", 9],
        ["tex.lc", "2026-10-21", 2],
        ["staging.context.lc", "2026-10-21", 50],
      ],
      sites: [
        ["context.lc", 1, 13, 8],
        ["context.lc", 0, 10, 9],
        ["tex.lc", 1, 2, 2],
      ],
    });
    const result = await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
    if (!result.connected || result.error !== null) throw new Error("expected figures");
    expect(result.sites.map((site) => site.host)).toEqual(["context.lc", "tex.lc"]);
    const [context, tex] = result.sites;
    expect(context).toMatchObject({ visits: 13, visitors: 8, priorVisits: 10, priorVisitors: 9 });
    expect(context.daily).toHaveLength(7);
    expect(context.daily.map((day) => day.count)).toEqual([0, 4, 0, 0, 0, 0, 9]);
    expect(tex).toMatchObject({ visits: 2, visitors: 2, priorVisits: 0, priorVisitors: 0 });
  });

  test("time in app for the window and the one before; none is null, not zero", async () => {
    const { fetchImpl } = posthog({ time: [[1, 40, 250, 452.4, 18_090, 12]] });
    const result = await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
    if (!result.connected || result.error !== null) throw new Error("expected figures");
    expect(result.time).toEqual({ sessions: 40, medianSeconds: 250, averageSeconds: 452, totalSeconds: 18_090, people: 12 });
    expect(result.priorTime).toBeNull();
  });

  test("a page that is not a cleaned route never reaches the screen", async () => {
    const { fetchImpl } = posthog({
      pages: [
        ["/console/:context", 90, 10],
        ["/note/@supa/1-projects/pay-review.md", 80, 1],
        ["/console/seyi", 70, 1],
        ["/", 30, 20],
        [null, 5, 1],
      ],
    });
    const result = await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
    if (!result.connected || result.error !== null) throw new Error("expected figures");
    expect(result.pages).toEqual([
      { route: "/console/:context", views: 90, people: 10 },
      { route: "/", views: 30, people: 20 },
    ]);
  });

  test("only the fixed button names come back, whatever a client sent", async () => {
    const { fetchImpl } = posthog({
      buttons: [
        ["new_note", 12, 4],
        ["Q3 board pay review", 9, 1],
        ["<script>", 3, 1],
        ["share_note", 2, 2],
      ],
    });
    const result = await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
    if (!result.connected || result.error !== null) throw new Error("expected figures");
    expect(result.buttons).toEqual([
      { button: "new_note", clicks: 12, people: 4 },
      { button: "share_note", clicks: 2, people: 2 },
    ]);
  });

  test("at most ten pages and ten buttons", async () => {
    const pages = Array.from({ length: 30 }, (_, index) => ["/", 30 - index, 1]);
    const { fetchImpl } = posthog({ pages });
    const result = await usageAnalytics(ENV, 7, { fetchImpl, now: NOW });
    if (!result.connected || result.error !== null) throw new Error("expected figures");
    expect(result.pages).toHaveLength(10);
  });
});

describe("the action is staff only", () => {
  afterEach(() => {
    delete process.env[ADMIN_EMAILS_ENV_VAR];
  });

  test("signed out and a signed-in stranger are refused before PostHog is asked", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = "staff@supa.media";
    await expect(t.action(api.functions.usageAnalytics.report, { days: 7 })).rejects.toThrow();
    const stranger: Id<"users"> = await t.run(
      async (ctx) => await ctx.db.insert("users", { email: "someone@example.com", emailVerificationTime: Date.now() } as never),
    );
    await expect(
      t.withIdentity({ subject: stranger }).action(api.functions.usageAnalytics.report, { days: 7 }),
    ).rejects.toThrow();
  });

  test("staff without a key get not connected", async () => {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = "staff@supa.media";
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const staff: Id<"users"> = await t.run(
      async (ctx) => await ctx.db.insert("users", { email: "staff@supa.media", emailVerificationTime: Date.now() } as never),
    );
    expect(await t.withIdentity({ subject: staff }).action(api.functions.usageAnalytics.report, { days: 7 })).toEqual({
      connected: false,
    });
  });
});
