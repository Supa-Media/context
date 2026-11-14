import { describe, expect, test } from "vitest";
import { bucketsOf, clampStatsWindow, MAX_STATS_DAYS, statsQueries, texStats } from "../functions/lib/adminFns/texStats";
import { COUNTS_BEGAN } from "../functions/lib/adminFns/texStatsBefore";

/**
 * TEX'S BASICS FOR ANY WINDOW (tex.lc/admin): people, texts in and out, cost
 * and notes, from Analytics Engine and the AI gateway, through a stub fetch.
 * All ids and tokens are invented.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-10):
 *   counting group messages Tex only heard as texts to it        1
 *   counting the test suites' spend in the total                 1
 *   reading staging's dataset on production                      1
 *   (2026-11-11) reading the older sources after counting began    2
 *   (2026-11-11) summing the two people counts instead of the higher 1
 */

const ENV = {
  CLOUDFLARE_ANALYTICS_TOKEN: "fixture-analytics-token-not-real",
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
};
const H = 3_600_000;
const D = 24 * H;
// After the basics' own counts began, so these windows read them alone; the backfill test below reaches earlier.
const NOW = Date.UTC(2026, 10, 12, 15, 30);

type Answers = { sql: (query: string) => unknown[] | null; gw: unknown[] };

function stub(answers: Answers) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/analytics_engine/sql")) {
      const query = String(init.body);
      asked.push(query);
      const data = answers.sql(query);
      return data === null ? new Response("boom with internals", { status: 500 }) : new Response(JSON.stringify({ data }), { status: 200 });
    }
    asked.push(String(init.body));
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{ gw: answers.gw }] } } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

const slot = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** The accounts figure: distinct workspaces with a 1:1 turn over the whole window (`tex_entry`). */
const ACCOUNTS = "FROM tex_entry";

function sqlAnswers(from: number, accounts: string = "2"): (query: string) => unknown[] | null {
  return (query) => {
    if (query.includes("blob1 AS way")) {
      return [
        { slot: slot(from), way: "in", chat: "one", what: "text", n: "6" },
        { slot: slot(from), way: "in", chat: "group", what: "for_tex", n: "2" },
        { slot: slot(from), way: "in", chat: "group", what: "heard", n: "40" },
        { slot: slot(from + H), way: "out", chat: "one", what: "text", n: "7" },
        { slot: slot(from + H), way: "out", chat: "group", what: "media", n: "1" },
      ];
    }
    if (query.includes(ACCOUNTS)) return [{ n: accounts }];
    if (query.includes("GROUP BY chat")) return [{ chat: "one", n: "3" }, { chat: "group", n: "2" }];
    if (query.includes("count(DISTINCT index1)") && !query.includes("GROUP BY")) return [{ n: "4" }];
    if (query.includes("count(DISTINCT index1)")) return [{ slot: slot(from), n: "4" }];
    if (query.includes("blob1 = 'note'") && query.includes("GROUP BY slot")) return [{ slot: slot(from), what: "created", saves: "2", notes: "2" }, { slot: slot(from), what: "edited", saves: "9", notes: "3" }];
    if (query.includes("blob1 = 'note'")) return [{ what: "created", saves: "2", notes: "2" }, { what: "edited", saves: "9", notes: "3" }];
    return [];
  };
}

describe("texStats", () => {
  test("without a token it is not connected, and asks nobody", async () => {
    const { asked, fetchImpl } = stub({ sql: () => [], gw: [] });
    expect(await texStats({}, { from: NOW - D, to: NOW }, { fetchImpl })).toEqual({ configured: false });
    expect(asked).toEqual([]);
  });

  test("a window is held to ninety days back and at least an hour", () => {
    expect(MAX_STATS_DAYS).toBe(90);
    expect(clampStatsWindow(0, NOW, NOW)).toEqual({ from: NOW - MAX_STATS_DAYS * D, to: NOW });
    // Ninety days is accepted as asked; ninety-one is held back to ninety.
    expect(clampStatsWindow(NOW - 90 * D, NOW, NOW)).toEqual({ from: NOW - 90 * D, to: NOW });
    expect(clampStatsWindow(NOW - 91 * D, NOW, NOW)).toEqual({ from: NOW - 90 * D, to: NOW });
    expect(clampStatsWindow(NOW, NOW + 5 * D, NOW)).toEqual({ from: NOW - H, to: NOW });
    expect(clampStatsWindow(undefined, undefined, NOW)).toEqual({ from: NOW - D, to: NOW });
    expect(bucketsOf(NOW - D, NOW).bucket).toBe("hour");
    expect(bucketsOf(NOW - 7 * D, NOW)).toMatchObject({ bucket: "day" });
    expect(bucketsOf(NOW - 7 * D, NOW).starts.length).toBe(8);
  });

  test("the SQL is built from numbers and fixed names, and staging reads its own twins", () => {
    const queries = statsQueries({ texts: "tex_text_counts", calls: "context_calls", entry: "tex_entry" }, NOW - D, NOW, "hour");
    for (const query of Object.values(queries)) expect(query).toMatch(/toDateTime\(\d+\) AND timestamp < toDateTime\(\d+\)/);
    expect(queries.texts).toContain("FROM tex_text_counts");
    expect(queries.notes).toContain("FROM context_calls");
    // Accounts: distinct workspaces with a 1:1 turn, over the whole window, never a bucket.
    expect(queries.accounts).toContain("count(DISTINCT index1) AS n FROM tex_entry");
    expect(queries.accounts).toContain("blob1 = 'gateway' AND blob2 = 'one'");
    expect(queries.accounts).not.toContain("GROUP BY");
  });

  test("counts texts to Tex, never group chatter it only heard, and prices them", async () => {
    const from = NOW - D;
    const gw = [
      { sum: { cost: 0.8 }, dimensions: { datetimeHour: new Date(from).toISOString().slice(0, 13) + ":00:00Z", feature: "assistant" } },
      { sum: { cost: 5 }, dimensions: { datetimeHour: new Date(from).toISOString().slice(0, 13) + ":00:00Z", feature: "benchmark" } },
      { sum: { cost: 3 }, dimensions: { datetimeHour: new Date(from).toISOString().slice(0, 13) + ":00:00Z", feature: "something-else" } },
    ];
    const { asked, fetchImpl } = stub({ sql: sqlAnswers(from), gw });
    const stats = await texStats(ENV, { from, to: NOW }, { fetchImpl });
    if (!stats.configured) throw new Error("not configured");
    expect(stats.texts).toEqual({ inOne: 6, inGroup: 2, heardGroup: 40, outOne: 7, outGroup: 1 });
    expect(stats.people).toEqual({ one: 3, group: 2, any: 4, accounts: 2, guests: 2 });
    expect(stats.notes).toEqual({ created: 2, edited: 3, saves: 11 });
    expect(stats.cost).toEqual({ totalUsd: 0.8, testsUsd: 5 });
    expect(stats.costPerTextUsd).toBeCloseTo(0.1);
    expect(stats.series[0]).toMatchObject({ textsIn: 8, people: 4, usd: 0.8, notesCreated: 2, notesEdited: 3 });
    expect(stats.series[1]).toMatchObject({ textsOut: 8 });
    expect(stats.errors).toEqual({ texts: null, notes: null, cost: null });
    expect(asked.some((q) => q.includes("_staging"))).toBe(false);
  });

  test("accounts are the 1:1 workspaces, guests are the rest of everyone who texted", async () => {
    const from = NOW - 30 * D;
    const { fetchImpl } = stub({ sql: sqlAnswers(from, "1"), gw: [] });
    const stats = await texStats(ENV, { from, to: NOW }, { fetchImpl });
    if (!stats.configured) throw new Error("not configured");
    // Text counts saw 4 people in all, 3 one-to-one; one workspace texted 1:1. Guests are the other 3 of the 4.
    expect(stats.people).toEqual({ one: 3, group: 2, any: 4, accounts: 1, guests: 3 });
  });

  test("accounts never exceed any, and guests are never negative", async () => {
    // Text counts see 4 in all and 3 one-to-one; the workspaces saw 9 one-to-one. Everyone is at least as many as the accounts.
    const from = NOW - 30 * D;
    const { fetchImpl } = stub({ sql: sqlAnswers(from, "9"), gw: [] });
    const stats = await texStats(ENV, { from, to: NOW }, { fetchImpl });
    if (!stats.configured) throw new Error("not configured");
    expect(stats.people.accounts).toBeLessThanOrEqual(stats.people.any);
    expect(stats.people.any).toBe(9);
    expect(stats.people.guests).toBe(0);
    expect(stats.people.guests).toBeGreaterThanOrEqual(0);
  });

  test("a failed accounts query sets the errors and the figure to zero, leaving guests as all of any", async () => {
    const from = NOW - D;
    const { fetchImpl } = stub({ sql: (query) => (query.includes(ACCOUNTS) ? null : sqlAnswers(from)(query)), gw: [] });
    const stats = await texStats(ENV, { from, to: NOW }, { fetchImpl });
    if (!stats.configured) throw new Error("not configured");
    expect(stats.errors.texts).toBe("Cloudflare answered 500");
    expect(JSON.stringify(stats)).not.toContain("internals");
    expect(stats.people).toEqual({ one: 3, group: 2, any: 4, accounts: 0, guests: 4 });
  });

  test("staging reads the _staging datasets", async () => {
    const { asked, fetchImpl } = stub({ sql: () => [], gw: [] });
    await texStats({ ...ENV, APP_ENV: "staging" }, { from: NOW - D, to: NOW }, { fetchImpl });
    expect(asked.filter((q) => q.startsWith("SELECT")).every((q) => q.includes("_staging"))).toBe(true);
    expect(asked.some((q) => q.includes("FROM tex_entry_staging") && q.includes("blob2 = 'one'"))).toBe(true);
  });

  test("a failed source says so in our words and leaves the others standing", async () => {
    const { fetchImpl } = stub({ sql: (query) => (query.includes("note") ? null : []), gw: [] });
    const stats = await texStats(ENV, { from: NOW - D, to: NOW }, { fetchImpl });
    if (!stats.configured) throw new Error("not configured");
    expect(stats.errors.notes).toBe("Cloudflare answered 500");
    expect(JSON.stringify(stats)).not.toContain("internals");
    expect(stats.errors.texts).toBeNull();
    expect(stats.costPerTextUsd).toBeNull();
  });

  test("before counting began, texts, people and notes created come from the older sources, and are not counted twice", async () => {
    const from = COUNTS_BEGAN - 3 * D;
    const to = COUNTS_BEGAN + 2 * D;
    const day = (ms: number) => slot(Math.floor(ms / D) * D);
    const { asked, fetchImpl } = stub({
      gw: [],
      sql: (query) => {
        if (query.includes("FROM tex_text_timing")) return [{ slot: day(from), chat: "one", n: "5", parts: "8" }, { slot: day(from), chat: "group", n: "2", parts: "2" }];
        if (query.includes("FROM tex_entry") && query.includes("GROUP BY slot")) return [{ slot: day(from), n: "3" }, { slot: day(COUNTS_BEGAN + D), n: "1" }];
        if (query.includes("FROM tex_entry")) return [{ n: "3" }];
        if (query.includes("blob2 = 'ws.create'")) return [{ slot: day(from), n: "4" }];
        if (query.includes("FROM tex_text_counts") && query.includes("blob1 AS way")) return [{ slot: day(COUNTS_BEGAN + D), way: "in", chat: "one", what: "text", n: "6" }, { slot: day(COUNTS_BEGAN + D), way: "out", chat: "one", what: "text", n: "7" }];
        if (query.includes("FROM tex_text_counts") && query.includes("GROUP BY chat")) return [{ chat: "one", n: "2" }];
        if (query.includes("FROM tex_text_counts") && query.includes("GROUP BY slot")) return [{ slot: day(COUNTS_BEGAN + D), n: "2" }];
        if (query.includes("FROM tex_text_counts")) return [{ n: "2" }];
        if (query.includes("blob1 = 'note'") && !query.includes("GROUP BY slot")) return [{ what: "edited", saves: "5", notes: "2" }];
        return [];
      },
    });
    const stats = await texStats(ENV, { from, to }, { fetchImpl });
    if (!stats.configured) throw new Error("not configured");
    // The older texts are read only up to when counting began.
    const timing = asked.find((q) => q.includes("FROM tex_text_timing"))!;
    expect(timing).toContain(`timestamp < toDateTime(${Math.floor(COUNTS_BEGAN / 1000)})`);
    expect(stats.texts).toEqual({ inOne: 11, inGroup: 2, heardGroup: 0, outOne: 15, outGroup: 2 });
    expect(stats.notes).toEqual({ created: 4, edited: 2, saves: 5 });
    // The higher of the two people counts, never their sum.
    expect(stats.people.one).toBe(3);
    expect(stats.people.any).toBe(3);
    expect(stats.people.accounts).toBe(3);
    expect(stats.people.guests).toBe(0);
    const after = stats.series.find((s) => s.at === Math.floor((COUNTS_BEGAN + D) / D) * D)!;
    expect(after.people).toBe(2);
    expect(stats.countedSince).toBe(COUNTS_BEGAN);
  });

  test("a window after counting began asks the workspaces' whole-window count and no older slot-by-slot source", async () => {
    const { asked, fetchImpl } = stub({ sql: () => [], gw: [] });
    await texStats(ENV, { from: NOW - D, to: NOW }, { fetchImpl });
    expect(asked.some((q) => q.includes("tex_text_timing"))).toBe(false);
    const entry = asked.filter((q) => q.includes("tex_entry"));
    expect(entry).toHaveLength(1);
    expect(entry[0]).not.toContain("GROUP BY");
  });
});
