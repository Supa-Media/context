import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CREDIT_KEYS,
  type ConsoleMeter,
  TEX_STEPS,
  clampConsoleDays,
  consoleBuckets,
  consoleCosts,
  consoleWindow,
  type ConsoleCosts,
} from "../functions/lib/adminFns/consoleCosts";
import { USD_PER_THOUSAND_NEURONS } from "../functions/lib/adminFns/aiCostsCloudflare";
import { CLEF_MODEL, GLM_MODEL } from "../functions/lib/adminFns/consoleCostsMap";
import { GATEWAY_RETENTION_DAYS, MAX_RANGE_DAYS, WORKERS_AI_RETENTION_DAYS } from "../functions/lib/adminFns/consoleCosts";

const DAY = 86_400_000;

/**
 * THE AI COSTS PAGE'S NUMBERS, FROM A STUB CLOUDFLARE.
 *
 * The stub answers each aliased sub-query of the batched GraphQL request from
 * a fixture keyed by alias, so a test says which rows Cloudflare would return
 * for which question. Ids, tokens and labels are invented; the labels follow
 * the gateway's own names.
 */

const ENV = {
  CLOUDFLARE_ANALYTICS_TOKEN: "fixture-analytics-token-not-real",
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  APP_ENV: "production",
};
// 2026-11-14 15:00 UTC: a 7-day window starts before the credit keys began, so it is cut in two.
const NOW = Date.UTC(2026, 10, 14, 15, 0);
const SINCE = Date.parse(CREDIT_KEYS[0].since);
const NO_TEXTS = async (_window: { from: number; to: number }): Promise<number | null> => null;

type Fixture = Record<string, unknown[]>;

function cloudflare(fixture: Fixture, status = 200) {
  const requests: Array<{ query: string; variables: Record<string, string> }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, string> };
    requests.push(body);
    if (status !== 200) return new Response("the body echoes Bearer fixture-analytics-token-not-real", { status });
    const aliases = [...body.query.matchAll(/(\w+):(?:aiGatewayRequestsAdaptiveGroups|aiInferenceAdaptiveGroups)\(/g)].map((m) => m[1]);
    // A chunk's rows are keyed by its full alias, or a single-chunk range by its base name (`w1` for `w1_0`).
    const rowsFor = (alias: string) => fixture[alias] ?? (alias.endsWith("_0") ? fixture[alias.slice(0, -2)] : undefined) ?? [];
    const rows = Object.fromEntries(aliases.map((alias) => [alias, rowsFor(alias)]));
    return new Response(JSON.stringify({ data: { viewer: { accounts: [rows] } }, errors: null }), { status: 200 });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

interface Gw {
  f?: string;
  c?: string;
  p?: string;
  model?: string;
  wholesale?: number;
  status?: number;
  cost: number;
  count?: number;
  date?: string;
}
const gw = (d: Gw) => ({
  count: d.count ?? 1,
  sum: { cost: d.cost },
  dimensions: {
    feature: d.f ?? "",
    client: d.c ?? "",
    payer: d.p ?? "",
    model: d.model ?? HAIKU_ID,
    wholesale: d.wholesale ?? 0,
    statusCode: d.status ?? 200,
    date: d.date ?? "2026-11-14",
  },
});
const ai = (modelId: string, neurons: number, date = "2026-11-14") => ({
  count: 1,
  sum: { totalNeurons: neurons },
  dimensions: { modelId, date },
});
const HAIKU_ID = "anthropic/claude-haiku-5-5";
const HAIKU = HAIKU_ID;
const OPUS = "anthropic/claude-opus-5-5";

const run = (
  days: number,
  fixture: Fixture,
  options: { now?: number; texCounts?: typeof NO_TEXTS; meter?: ConsoleMeter } = {},
  status = 200,
) => {
  const stub = cloudflare(fixture, status);
  return consoleCosts(ENV, days, {
    fetchImpl: stub.fetchImpl,
    now: options.now ?? NOW,
    texCounts: options.texCounts ?? NO_TEXTS,
    meter: options.meter,
  }).then((result) => ({ result, requests: stub.requests }));
};

function configured(result: ConsoleCosts) {
  if (!result.configured) throw new Error("expected configured");
  return result;
}
const step = (result: ConsoleCosts, id: string) => {
  const found = configured(result).texSteps.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};
const feature = (result: ConsoleCosts, key: string) => {
  const found = configured(result).features.find((f) => f.key === key);
  if (!found) throw new Error(`no feature ${key}`);
  return found;
};
const payer = (result: ConsoleCosts, key: string) => {
  const found = configured(result).payers.find((p) => p.key === key);
  if (!found) throw new Error(`no payer ${key}`);
  return found;
};

describe("consoleCosts: configuration and the window", () => {
  test("without a token or account it is not connected and asks nobody", async () => {
    const stub = cloudflare({});
    expect(await consoleCosts({ APP_ENV: "production" }, 30, { fetchImpl: stub.fetchImpl, now: NOW })).toEqual({ configured: false });
    expect(
      await consoleCosts({ ...ENV, CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "not-an-account" }, 30, { fetchImpl: stub.fetchImpl, now: NOW }),
    ).toEqual({ configured: false });
    expect(stub.requests).toHaveLength(0);
  });

  test("days are one of 1, 7, 30, 90; anything else is 30", () => {
    expect([1, 7, 30, 90, 2, 0, 365, Number.NaN].map(clampConsoleDays)).toEqual([1, 7, 30, 90, 30, 30, 30, 30]);
    expect(consoleWindow(7, NOW)).toEqual({
      days: 7,
      from: NOW - 7 * 86_400_000,
      to: NOW,
      priorFrom: NOW - 14 * 86_400_000,
      priorTo: NOW - 7 * 86_400_000,
    });
  });

  test("a window that starts before the credit keys is cut at their start, and only then", async () => {
    const { requests } = await run(7, {});
    const variables = requests[0].variables;
    expect(variables.w0_0E).toBe(new Date(SINCE).toISOString());
    expect(variables.w1_0S).toBe(new Date(SINCE).toISOString());
    const after = await run(1, {}, { now: Date.UTC(2026, 10, 20, 12, 0) });
    expect(after.requests[0].query).toContain("w0_0:aiGatewayRequestsAdaptiveGroups");
    expect(after.requests[0].query).not.toContain("w1_0:");
  });

  test("a 90-day request sends no range older than its dataset keeps, none over 31 days, and merges the chunks", async () => {
    const { requests, result } = await run(90, {
      w0_0: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1 })],
      w0_1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 2 })],
    });
    const query = requests[0].query;
    const kinds = new Map([...query.matchAll(/(\w+):(aiGatewayRequestsAdaptiveGroups|aiInferenceAdaptiveGroups)\(/g)].map((m) => [m[1], m[2]]));
    expect([...kinds.keys()]).toContain("w0_1");
    expect(MAX_RANGE_DAYS).toBe(31);
    for (const [alias, field] of kinds) {
      const variables = requests[0].variables;
      const from = Date.parse(variables[`${alias}S`]);
      const to = Date.parse(variables[`${alias}E`]);
      const keep = field.startsWith("aiGateway") ? GATEWAY_RETENTION_DAYS : WORKERS_AI_RETENTION_DAYS;
      expect(from).toBeGreaterThanOrEqual(NOW - keep * DAY);
      expect(to).toBeGreaterThan(from);
      expect(to - from).toBeLessThanOrEqual(MAX_RANGE_DAYS * DAY);
    }
    // Both chunks' rows count toward the front door.
    expect(step(result, "fd").usd).toBeCloseTo(3);
  });

  test("the window's gateway figures start at the clamp, and a prior window past retention is partial", async () => {
    const seven = await run(7, {});
    expect(configured(seven.result).coverageFrom).toBe(NOW - 7 * DAY);
    expect(configured(seven.result).priorPartial).toBe(false);
    // Workers AI keeps 32 days, so a 30-day prior window reaches past it.
    const thirty = await run(30, {});
    expect(configured(thirty.result).coverageFrom).toBe(NOW - 30 * DAY);
    expect(configured(thirty.result).priorPartial).toBe(true);
    const ninety = await run(90, {});
    expect(configured(ninety.result).coverageFrom).toBe(NOW - GATEWAY_RETENTION_DAYS * DAY + 3_600_000);
    expect(configured(ninety.result).priorPartial).toBe(true);
  });

  test("the window's requests ask for the dimensions the attribution needs, and one request carries them all", async () => {
    const { requests } = await run(7, {});
    expect(requests).toHaveLength(1);
    const query = requests[0].query;
    expect(query).toContain('payer:metadataValue(key:"payer")');
    expect(query).toContain("statusCode");
    expect(query).toContain("wholesale");
    expect(query).toContain("date");
    expect(query).toContain("aiInferenceAdaptiveGroups");
  });
});

describe("consoleCosts: attribution", () => {
  test("Tex steps map from the gateway labels and the model, and the Workers AI Clef and GLM are the decide and fallback steps", async () => {
    const fixture = {
      w0: [],
      w1: [
        gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1 }),
        gw({ f: "assistant", c: "texts-group", model: OPUS, cost: 2 }),
        gw({ c: "advisor", model: OPUS, cost: 4 }),
        gw({ c: "job-check", model: OPUS, cost: 8 }),
        gw({ c: "job-advisor", model: OPUS, cost: 16 }),
        gw({ c: "reviewer", model: HAIKU, cost: 32 }),
        gw({ c: "threads", model: HAIKU, cost: 64 }),
        gw({ c: "threads_backfill", model: HAIKU, cost: 0.5 }),
        gw({ f: "mail-checker", model: HAIKU, cost: 0.25 }),
        gw({ f: "card-check", model: HAIKU, cost: 0.125 }),
        gw({ f: "self-review", model: HAIKU, cost: 0.0625 }),
        gw({ f: "handback-judge", model: HAIKU, cost: 0.03125 }),
      ],
      aw: [ai(CLEF_MODEL, 1000), ai(GLM_MODEL, 2000)],
    };
    const { result } = await run(7, fixture);
    expect(step(result, "fd").usd).toBeCloseTo(1);
    expect(step(result, "advisor").usd).toBeCloseTo(2 + 4);
    expect(step(result, "jobcheck").usd).toBeCloseTo(8);
    expect(step(result, "mailadv").usd).toBeCloseTo(16);
    expect(step(result, "reviewer").usd).toBeCloseTo(32);
    expect(step(result, "classifier").usd).toBeCloseTo(64.5);
    expect(step(result, "mail").usd).toBeCloseTo(0.25);
    expect(step(result, "card").usd).toBeCloseTo(0.125);
    expect(step(result, "selfreview").usd).toBeCloseTo(0.0625);
    expect(step(result, "handback").usd).toBeCloseTo(0.03125);
    expect(step(result, "decide").usd).toBeCloseTo(1000 / 1000 * USD_PER_THOUSAND_NEURONS);
    expect(step(result, "fallback").usd).toBeCloseTo(2000 / 1000 * USD_PER_THOUSAND_NEURONS);
    const tex = configured(result).texUsd;
    const sumSteps = configured(result).texSteps.reduce((sum, s) => sum + s.usd, 0);
    expect(sumSteps).toBeCloseTo(tex);
    expect(feature(result, "tex").usd).toBeCloseTo(tex);
  });

  test("the other features: check-in, dream with housekeeping, meetings with transcription, search and other", async () => {
    const fixture = {
      w1: [
        gw({ c: "heartbeat", model: HAIKU, cost: 1 }),
        gw({ c: "dreams", model: HAIKU, cost: 2 }),
        gw({ f: "day-summary", model: HAIKU, cost: 4 }),
        gw({ c: "housekeeping", model: HAIKU, cost: 8 }),
        gw({ f: "meetingSummary", model: HAIKU, cost: 16 }),
        gw({ f: "something-else", model: HAIKU, cost: 32 }),
      ],
      aw: [ai("@cf/baai/bge-m3", 1000), ai("@cf/openai/whisper-large-v3-turbo", 2000)],
    };
    const { result } = await run(7, fixture);
    expect(feature(result, "checkin").usd).toBeCloseTo(1);
    expect(feature(result, "dream").usd).toBeCloseTo(14);
    expect(feature(result, "meetings").usd).toBeCloseTo(16.022);
    expect(feature(result, "other").usd).toBeCloseTo(32);
    expect(feature(result, "search").usd).toBeCloseTo(0.011);
    expect(configured(result).features.map((f) => f.key)).toEqual(["tex", "checkin", "dream", "meetings", "search", "other"]);
  });

  test("lab runs are shown apart and kept out of the people total, and billed includes them", async () => {
    const fixture = {
      w1: [gw({ f: "benchmark", model: HAIKU, cost: 5 }), gw({ f: "bench", model: HAIKU, cost: 3 }), gw({ f: "assistant", c: "texts", model: HAIKU, cost: 2 })],
    };
    const { result } = await run(7, fixture);
    const c = configured(result);
    expect(c.labRunsUsd).toBeCloseTo(8);
    expect(c.totalUsd).toBeCloseTo(2);
    expect(c.billedUsd).toBeCloseTo(10);
    expect(step(result, "fd").usd).toBeCloseTo(2);
  });

  test("Workers AI is out of pocket and people's, and the payers sum to billed", async () => {
    const fixture = {
      w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 2 }), gw({ f: "benchmark", model: HAIKU, cost: 3 })],
      aw: [ai(CLEF_MODEL, 1000), ai("@cf/baai/bge-m3", 4000)],
    };
    const { result } = await run(7, fixture);
    const c = configured(result);
    const workersUsd = c.features.reduce((sum, f) => (f.key === "tex" || f.key === "search" ? sum + f.usd : sum), 0);
    expect(payer(result, "cloudflare").usd).toBeCloseTo(
      (1000 / 1000 + 4000 / 1000) * USD_PER_THOUSAND_NEURONS,
    );
    expect(c.outOfPocketUsd).toBeCloseTo(payer(result, "cloudflare").usd);
    expect(c.outOfPocketPeopleUsd).toBeCloseTo(payer(result, "cloudflare").usd);
    expect(workersUsd).toBeGreaterThan(0);
    const paid = c.payers.reduce((sum, p) => sum + p.usd, 0);
    expect(paid).toBeCloseTo(c.billedUsd);
  });

  test("wholesale spend is out of pocket, and it is the Cloudflare payer", async () => {
    const fixture = {
      w1: [
        gw({ f: "assistant", c: "texts", model: HAIKU, wholesale: 1, cost: 2, p: "dev-claude-credits" }),
        gw({ f: "benchmark", model: HAIKU, wholesale: 1, cost: 3 }),
        gw({ f: "assistant", c: "texts", model: HAIKU, p: "plan", cost: 1 }),
      ],
    };
    const { result } = await run(7, fixture);
    const c = configured(result);
    expect(c.outOfPocketUsd).toBeCloseTo(5);
    expect(c.outOfPocketPeopleUsd).toBeCloseTo(2);
    expect(payer(result, "cloudflare").usd).toBeCloseTo(5);
    expect(payer(result, "cloudflare").note).toBe("Cloudflare Unified Billing and Workers AI");
    expect(payer(result, "dev").usd).toBe(0);
  });

  test("a payer label names its credit key or the plan", async () => {
    const fixture = {
      w1: [
        gw({ f: "assistant", c: "texts", model: HAIKU, p: "dev-claude-credits", cost: 1.5 }),
        gw({ f: "assistant", c: "texts", model: HAIKU, p: "dev2-claude-credits", cost: 2.5 }),
        gw({ f: "assistant", c: "texts", model: HAIKU, p: "plan", cost: 0.5 }),
      ],
      u0: [gw({ p: "dev-claude-credits", cost: 40 })],
    };
    const { result } = await run(7, fixture);
    expect(payer(result, "dev").usd).toBeCloseTo(1.5);
    expect(payer(result, "dev2").usd).toBeCloseTo(2.5);
    expect(payer(result, "plan").usd).toBeCloseTo(0.5);
    expect(payer(result, "plan").capUsd).toBeNull();
    expect(payer(result, "dev").note).toBeNull();
  });

  test("an unlabeled call is the plan's before the credit keys began, and the first open key's after", async () => {
    const fixture = {
      w0: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 0.7 })],
      w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 0.9 })],
    };
    const { result, requests } = await run(7, fixture);
    expect(requests[0].variables.w0_0S).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
    expect(payer(result, "plan").usd).toBeCloseTo(0.7);
    expect(payer(result, "dev").usd).toBeCloseTo(0.9);
    expect(payer(result, "dev2").usd).toBe(0);
  });

  test("a spent key's usage is its cap, and an open key's usage is what it has spent since it began", async () => {
    const { result } = await run(7, { u0: [gw({ p: "dev-claude-credits", cost: 40 }), gw({ p: "", cost: 10 })] });
    const dev2 = payer(result, "dev2");
    expect(dev2.capUsd).toBe(200);
    expect(dev2.usedUsd).toBe(200);
    expect(dev2.leftUsd).toBe(0);
    expect(dev2.note).toBe("Spent");
    const dev = payer(result, "dev");
    expect(dev.capUsd).toBe(100);
    expect(dev.usedUsd).toBeCloseTo(50);
    expect(dev.leftUsd).toBeCloseTo(50);
  });

  test("days of the dev credit left is its left balance over its pace in the window", async () => {
    const fixture = {
      w1: [gw({ f: "assistant", c: "texts", model: HAIKU, p: "dev-claude-credits", cost: 10, date: "2026-11-14" })],
      u0: [gw({ p: "dev-claude-credits", cost: 40 })],
    };
    // The key began two days before `now`, so the pace is over two days (shorter than the 7-day window): 10 / 2 = 5 a day.
    const now = Date.parse(CREDIT_KEYS[0].since) + 2 * DAY;
    const { result } = await run(7, fixture, { now });
    // 60 left at 5 a day: 12 days.
    expect(configured(result).devDaysLeft).toBe(12);
    // A key older than the window is paced over the window: 60 / (10 / 7) = 42.
    // With the key older than the window, the whole window is one piece: its spend sits in w0.
    const olderFixture = { w0: fixture.w1, u0: fixture.u0 };
    const older = await run(7, olderFixture, { now: Date.parse(CREDIT_KEYS[0].since) + 30 * DAY });
    expect(configured(older.result).devDaysLeft).toBe(42);
    const none = await run(7, { u0: [gw({ p: "dev-claude-credits", cost: 40 })] });
    expect(configured(none.result).devDaysLeft).toBeNull();
  });

  test("the dev pace never divides by less than an hour's sliver of a day", async () => {
    const fixture = { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, p: "dev-claude-credits", cost: 1, date: "2026-11-14" })], u0: [gw({ p: "dev-claude-credits", cost: 40 })] };
    const { result } = await run(7, fixture, { now: Date.parse(CREDIT_KEYS[0].since) + 60_000 });
    // Pace floored at 1/24 day: 1 / (1/24) = 24 a day; 60 left is 2.5 days, rounded to 3.
    expect(configured(result).devDaysLeft).toBe(3);
  });
});

describe("consoleCosts: calls, meter and texts", () => {
  test("a refused keyed attempt costs nothing and is not a call", async () => {
    const fixture = {
      w1: [
        gw({ f: "assistant", c: "texts", model: HAIKU, cost: 0.2, count: 2 }),
        gw({ f: "assistant", c: "texts", model: HAIKU, cost: 0, count: 5, status: 400 }),
      ],
    };
    const { result } = await run(7, fixture);
    expect(step(result, "fd").calls).toBe(2);
    expect(step(result, "fd").usd).toBeCloseTo(0.2);
  });

  test("background jobs come out of the front door, never more than it spent", async () => {
    const fixture = {
      w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1, count: 4 })],
    };
    const { result } = await run(7, fixture, { meter: { jobUsd: 0.4, jobTurns: 3, answered: 4, truncated: false } });
    expect(step(result, "fd").usd).toBeCloseTo(0.6);
    expect(step(result, "job").usd).toBeCloseTo(0.4);
    expect(step(result, "job").calls).toBe(3);
    expect(step(result, "fd").calls).toBe(1);
    expect(configured(result).texUsd).toBeCloseTo(1);

    const { result: capped } = await run(7, fixture, { meter: { jobUsd: 9, jobTurns: 9, answered: 0, truncated: false } });
    expect(step(capped, "job").usd).toBeCloseTo(1);
    expect(step(capped, "fd").usd).toBe(0);
  });

  test("the meter's answered count and truncation come back; without a meter they are null and false", async () => {
    const fixture = { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1 })] };
    const { result } = await run(7, fixture, { meter: { jobUsd: 0, jobTurns: 0, answered: 12, truncated: true } });
    expect(configured(result).answered).toBe(12);
    expect(configured(result).meterTruncated).toBe(true);
    const none = await run(7, fixture);
    expect(configured(none.result).answered).toBeNull();
    expect(configured(none.result).meterTruncated).toBe(false);
  });

  test("on 90 days the spend covers 62 days, so texts are counted over those days or not at all", async () => {
    const seen: number[] = [];
    const counts = async (w: { from: number }) => {
      seen.push(w.from);
      return 5;
    };
    const { result } = await run(90, { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 4 })] }, { texCounts: counts });
    // Cloudflare's 62 days reach past the 60 days texts are counted for, so nothing is divided.
    expect(seen).toEqual([]);
    expect(configured(result).texts).toBeNull();
    expect(configured(result).perTextBasis).toBeNull();
    expect(configured(result).perTextUsd).toBeNull();
    expect(configured(result).priorPerTextUsd).toBeNull();
  });

  test("per text divides by the answered texts when the meter read every turn over the same span", async () => {
    const fixture = { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 4 })] };
    const counts = async () => 8;
    const { result } = await run(7, fixture, { texCounts: counts, meter: { jobUsd: 0, jobTurns: 0, answered: 5, truncated: false } });
    expect(configured(result).perTextBasis).toBe("answered");
    expect(configured(result).perTextDivisor).toBe(5);
    expect(configured(result).perTextUsd).toBeCloseTo(0.8);
    // The window before has no answered count, so no like-for-like comparison.
    expect(configured(result).priorPerTextUsd).toBeNull();
  });

  test("a truncated meter falls back to the texts received over the same span", async () => {
    const fixture = { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 4 })] };
    const seen: number[] = [];
    const counts = async (w: { from: number }) => {
      seen.push(w.from);
      return 8;
    };
    const { result } = await run(7, fixture, { texCounts: counts, meter: { jobUsd: 0, jobTurns: 0, answered: 5, truncated: true } });
    expect(configured(result).perTextBasis).toBe("texts");
    expect(configured(result).perTextDivisor).toBe(8);
    expect(configured(result).perTextUsd).toBeCloseTo(0.5);
    expect(seen[0]).toBe(configured(result).coverageFrom);
  });

  test("per-text cost divides Tex's spend by the texts people sent, and the prior window's the same", async () => {
    const fixture = {
      w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 4 })],
      pr: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 6 })],
    };
    const counts = async (w: { from: number }) => (w.from > NOW - 8 * 86_400_000 ? 8 : 3);
    const { result } = await run(7, fixture, { texCounts: counts });
    expect(configured(result).texts).toBe(8);
    expect(configured(result).perTextUsd).toBeCloseTo(0.5);
    expect(configured(result).priorPerTextUsd).toBeCloseTo(2);
    expect(configured(result).priorUsd).toBeCloseTo(6);
  });

  test("texts that could not be counted are null, and so is their per-text cost", async () => {
    const { result } = await run(7, { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 4 })] });
    expect(configured(result).texts).toBeNull();
    expect(configured(result).perTextUsd).toBeNull();
  });

  test("the daily buckets are UTC days, oldest first and zero-filled", async () => {
    const { result } = await run(7, { w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1, date: "2026-11-14" })] });
    const daily = configured(result).daily;
    expect(daily.map((d) => d.label)).toEqual([
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
    ]);
    expect(daily.slice(0, 6).every((d) => d.byFeature.length === 0)).toBe(true);
    expect(daily[6].byFeature).toEqual([{ key: "tex", usd: 1 }]);
  });

  test("rows dated before the first bucket are dropped, not clamped into bar 0", async () => {
    const fixture = {
      w0_0: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 5, date: "2026-11-07" })],
      w1_0: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1, date: "2026-11-14" })],
    };
    const { result } = await run(7, fixture);
    const c = configured(result);
    expect(feature(result, "tex").usd).toBeCloseTo(6);
    expect(c.daily[0].byFeature).toEqual([]);
    const daily = c.daily.reduce((sum, d) => sum + d.byFeature.reduce((s, f) => s + f.usd, 0), 0);
    expect(daily).toBeCloseTo(1);
    expect(c.daily[6].byFeature).toEqual([{ key: "tex", usd: 1 }]);
  });

  test("a one-day window is 24 hourly buckets", async () => {
    const hourly = consoleBuckets(1, NOW);
    expect(hourly.hourly).toBe(true);
    expect(hourly.starts).toHaveLength(24);
    const { result } = await run(1, { w0: [], w1: [gw({ f: "assistant", c: "texts", model: HAIKU, cost: 1 })] });
    const daily = configured(result).daily;
    expect(daily).toHaveLength(24);
    expect(daily[daily.length - 1].label).toBe("2026-11-14 15:00");
  });

  test("a Cloudflare failure is reported in our words, with no body and no figures", async () => {
    const { result } = await run(7, {}, {}, 500);
    const c = configured(result);
    expect(c.error).toBe("Cloudflare answered 500");
    expect(JSON.stringify(result)).not.toContain("fixture-analytics-token");
    expect(c.totalUsd).toBe(0);
    expect(c.payers).toEqual([]);
    expect(c.texSteps).toEqual([]);
  });
});

describe("TEX_STEPS against packages/shared/src/texConfig.json", () => {
  test("every texConfig node whose model is not code is listed, with its label, model and on flag", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../../packages/shared/src/texConfig.json", import.meta.url), "utf8"),
    ) as { models: Record<string, string>; nodes: Array<{ id: string; label: string; model: string; on: boolean }> };
    const expected = config.nodes
      .filter((node) => node.model !== "code")
      .map((node) => ({ id: node.id, label: node.label, model: node.model, on: node.on }));
    expect(TEX_STEPS.map((s) => ({ id: s.id, label: s.label, model: s.model, on: s.on }))).toEqual(expected);
    for (const node of config.nodes) {
      if (node.model !== "code") expect(config.models[node.model]).toBeTruthy();
    }
  });
});
