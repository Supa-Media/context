import { describe, expect, test } from "vitest";
import { texSpend, windowDays } from "../functions/lib/adminFns/texSpend";
import { clampTexSpendDays } from "../functions/texSpend";

/**
 * TEX'S SPEND AS CLOUDFLARE'S AI GATEWAY PRICED IT (tex.lc/admin).
 *
 * Driven through a stub fetch. Tex's own labels count and nothing else does;
 * the test suites are kept apart; a long window is asked in pieces Cloudflare
 * accepts, starting where it still holds figures; the workspace label is never
 * asked for; and Cloudflare's own words never reach the page. All ids and
 * tokens are invented.
 *
 * Sabotage record (temporary local edits, reverted, 2026-10-24):
 *   counting every feature, not only Tex's                       1
 *   asking the whole 90 days in one question                     1
 */

const ENV = {
  CLOUDFLARE_ANALYTICS_TOKEN: "fixture-analytics-token-not-real",
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
};
const NOW = Date.UTC(2026, 9, 24, 15, 30);

function group(date: string, model: string, feature: string, job: string, cost: number, extra: Record<string, number> = {}) {
  return { count: 2, sum: { cost, freshInputTokens: 10, cacheReadTokens: 1_000, cacheWriteTokens: 100, tokensOut: 50, ...extra }, dimensions: { date, model, feature, job } };
}

function stub(gw: unknown[], status = 200, raw?: string) {
  const calls: Array<{ url: string; body: { query: string; variables: { s: string; e: string } } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(raw ?? JSON.stringify({ data: { viewer: { accounts: [{ gw }] } }, errors: null }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("texSpend", () => {
  test("without a token or account it is not connected, and asks nobody", async () => {
    const { calls, fetchImpl } = stub([]);
    expect(await texSpend({}, 7, { fetchImpl, now: NOW })).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("counts Tex's labels by day, model and job, keeps the test suites apart, and drops everything else", async () => {
    const { calls, fetchImpl } = stub([
      group("2026-10-23", "claude-opus-5-5", "assistant", "texts", 2),
      group("2026-10-24", "claude-opus-5-5", "assistant", "texts", 3),
      group("2026-10-24", "claude-haiku-5-5", "assistant", "heartbeat", 0.5),
      group("2026-10-24", "claude-haiku-5-5", "self-review", "", 0.25),
      group("2026-10-24", "claude-opus-5-5", "benchmark", "", 8),
      group("2026-10-24", "claude-haiku-5-5", "meetingSummary", "", 1),
    ]);
    const out = await texSpend(ENV, 7, { fetchImpl, now: NOW });
    if (!out.configured) throw new Error("not configured");
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(calls[0].body.query).not.toMatch(/workspace/);
    expect(out.totalUsd).toBeCloseTo(5.75);
    expect(out.testsUsd).toBe(8);
    expect(out.days.map((d) => d.day)).toEqual(windowDays(7, NOW));
    expect(out.days.slice(-2).map((d) => d.usd)).toEqual([2, 3.75]);
    expect(out.models[0]).toMatchObject({ model: "claude-opus-5-5", usd: 5, cacheReadTokens: 2_000, requests: 4 });
    expect(out.jobs.map((j) => j.job)).toEqual(["texts", "heartbeat", "self-review"]);
  });

  test("a 90-day window is asked in pieces of at most 30 days, from the oldest day Cloudflare keeps", async () => {
    const { calls, fetchImpl } = stub([]);
    const out = await texSpend(ENV, 90, { fetchImpl, now: NOW });
    if (!out.configured) throw new Error("not configured");
    expect(out.days).toHaveLength(90);
    expect(out.keptFrom).toBe(windowDays(60, NOW)[0]);
    expect(calls.length).toBe(2);
    expect(calls[0].body.variables.s).toBe(`${out.keptFrom}T00:00:00.000Z`);
    for (const call of calls) expect(Date.parse(call.body.variables.e) - Date.parse(call.body.variables.s)).toBeLessThanOrEqual(31 * 86_400_000);
  });

  test("Cloudflare's own error words never reach the page", async () => {
    const leaky = JSON.stringify({ data: null, errors: [{ message: "secret request echo" }] });
    const out = await texSpend(ENV, 7, { ...stub([], 200, leaky), now: NOW });
    expect(JSON.stringify(out)).not.toContain("secret request echo");
    expect(out).toMatchObject({ configured: true, error: expect.stringContaining("refused") });
    const down = await texSpend(ENV, 7, { ...stub([], 503), now: NOW });
    expect(down).toMatchObject({ error: "Cloudflare answered 503" });
  });

  test("the window is held to 1 to 90 days", () => {
    expect(clampTexSpendDays(undefined)).toBe(7);
    expect(clampTexSpendDays(400)).toBe(90);
    expect(clampTexSpendDays(0)).toBe(1);
  });
});
