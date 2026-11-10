import { describe, expect, test } from "vitest";
import { bucketsOf, clampStatsWindow, MAX_STATS_DAYS, statsQueries, texStats } from "../functions/lib/adminFns/texStats";

/**
 * TEX'S BASICS FOR ANY WINDOW (tex.lc/admin): people, texts in and out, cost
 * and notes, from Analytics Engine and the AI gateway, through a stub fetch.
 * All ids and tokens are invented.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-10):
 *   counting group messages Tex only heard as texts to it        1
 *   counting the test suites' spend in the total                 1
 *   reading staging's dataset on production                      1
 */

const ENV = {
  CLOUDFLARE_ANALYTICS_TOKEN: "fixture-analytics-token-not-real",
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
};
const H = 3_600_000;
const D = 24 * H;
const NOW = Date.UTC(2026, 10, 10, 15, 30);

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

function sqlAnswers(from: number): (query: string) => unknown[] | null {
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

  test("a window is held to sixty days back and at least an hour", () => {
    expect(clampStatsWindow(0, NOW, NOW)).toEqual({ from: NOW - MAX_STATS_DAYS * D, to: NOW });
    expect(clampStatsWindow(NOW, NOW + 5 * D, NOW)).toEqual({ from: NOW - H, to: NOW });
    expect(clampStatsWindow(undefined, undefined, NOW)).toEqual({ from: NOW - D, to: NOW });
    expect(bucketsOf(NOW - D, NOW).bucket).toBe("hour");
    expect(bucketsOf(NOW - 7 * D, NOW)).toMatchObject({ bucket: "day" });
    expect(bucketsOf(NOW - 7 * D, NOW).starts.length).toBe(8);
  });

  test("the SQL is built from numbers and fixed names, and staging reads its own twins", () => {
    const queries = statsQueries({ texts: "tex_text_counts", calls: "context_calls" }, NOW - D, NOW, "hour");
    for (const query of Object.values(queries)) expect(query).toMatch(/toDateTime\(\d+\) AND timestamp < toDateTime\(\d+\)/);
    expect(queries.texts).toContain("FROM tex_text_counts");
    expect(queries.notes).toContain("FROM context_calls");
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
    expect(stats.people).toEqual({ one: 3, group: 2, any: 4 });
    expect(stats.notes).toEqual({ created: 2, edited: 3, saves: 11 });
    expect(stats.cost).toEqual({ totalUsd: 0.8, testsUsd: 5 });
    expect(stats.costPerTextUsd).toBeCloseTo(0.1);
    expect(stats.series[0]).toMatchObject({ textsIn: 8, people: 4, usd: 0.8, notesCreated: 2, notesEdited: 3 });
    expect(stats.series[1]).toMatchObject({ textsOut: 8 });
    expect(stats.errors).toEqual({ texts: null, notes: null, cost: null });
    expect(asked.some((q) => q.includes("_staging"))).toBe(false);
  });

  test("staging reads the _staging datasets", async () => {
    const { asked, fetchImpl } = stub({ sql: () => [], gw: [] });
    await texStats({ ...ENV, APP_ENV: "staging" }, { from: NOW - D, to: NOW }, { fetchImpl });
    expect(asked.filter((q) => q.startsWith("SELECT")).every((q) => q.includes("_staging"))).toBe(true);
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
});
