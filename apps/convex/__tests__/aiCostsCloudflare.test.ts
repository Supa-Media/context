import { describe, expect, test } from "vitest";
import { cloudflareCheck, windowStart, USD_PER_THOUSAND_NEURONS } from "../functions/lib/adminFns/aiCostsCloudflare";

/**
 * THE AI COSTS TAB'S CHECK AGAINST CLOUDFLARE'S OWN COUNT.
 *
 * Driven through a stub fetch: the token must go only to Cloudflare's
 * analytics endpoint, a missing or malformed setting must read as "not
 * connected" rather than a failed call, and Cloudflare's own error text must
 * never reach the screen. All ids and tokens are invented.
 */

const ENV = {
  CLOUDFLARE_ANALYTICS_TOKEN: "fixture-analytics-token-not-real",
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
};
const NOW = Date.UTC(2026, 9, 8, 15, 30);

function answer(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const LIVE = {
  data: {
    viewer: {
      accounts: [
        {
          ai: [
            { sum: { totalNeurons: 100_000 }, dimensions: { modelId: "@cf/zai-org/glm-4.7-flash" } },
            { sum: { totalNeurons: 30_000 }, dimensions: { modelId: "@cf/openai/whisper-large-v3-turbo" } },
            { sum: { totalNeurons: 5 }, dimensions: { modelId: "<script>" } },
          ],
          gw: [{ count: 6, sum: { cost: 0.02 }, dimensions: { model: "claude-haiku-5-5", provider: "anthropic" } }],
        },
      ],
    },
  },
  errors: null,
};

describe("cloudflareCheck", () => {
  test("without a token or account it is not connected, and asks nobody", async () => {
    const { calls, fetchImpl } = answer(LIVE);
    expect(await cloudflareCheck({}, 30, { fetchImpl, now: NOW })).toEqual({ configured: false });
    expect(await cloudflareCheck({ ...ENV, CLOUDFLARE_ANALYTICS_ACCOUNT_ID: "not-an-account" }, 30, { fetchImpl, now: NOW })).toEqual({
      configured: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("the token goes to Cloudflare's analytics endpoint and nowhere else", async () => {
    const { calls, fetchImpl } = answer(LIVE);
    await cloudflareCheck(ENV, 7, { fetchImpl, now: NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ENV.CLOUDFLARE_ANALYTICS_TOKEN}`);
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.variables.a).toBe(ENV.CLOUDFLARE_ANALYTICS_ACCOUNT_ID);
    expect(sent.variables.s).toBe("2026-10-02T00:00:00.000Z");
    expect(JSON.stringify(sent)).not.toContain(ENV.CLOUDFLARE_ANALYTICS_TOKEN);
  });

  test("prices neurons at the published rate, sorts by cost and drops odd model names", async () => {
    const { fetchImpl } = answer(LIVE);
    const result = await cloudflareCheck(ENV, 30, { fetchImpl, now: NOW });
    if (!result.configured) throw new Error("expected configured");
    expect(result.error).toBeNull();
    expect(result.workersAi.map((row) => row.model)).toEqual(["@cf/zai-org/glm-4.7-flash", "@cf/openai/whisper-large-v3-turbo"]);
    expect(result.workersAi[0].usd).toBeCloseTo(100 * USD_PER_THOUSAND_NEURONS);
    expect(result.gateway).toEqual([{ model: "claude-haiku-5-5", provider: "anthropic", requests: 6, costUsd: 0.02 }]);
    expect(result.billedUsd).toBeCloseTo(130 * USD_PER_THOUSAND_NEURONS + 0.02);
  });

  test("a refusal, a GraphQL error or a garbage body is reported in our words", async () => {
    const leak = "secret-looking cloudflare body";
    for (const [body, status] of [
      [leak, 403],
      [{ data: null, errors: [{ message: leak }] }, 200],
      ["not json " + leak, 200],
    ] as const) {
      const { fetchImpl } = answer(body, status);
      const result = await cloudflareCheck(ENV, 30, { fetchImpl, now: NOW });
      if (!result.configured) throw new Error("expected configured");
      expect(result.error).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(leak);
      expect(result.billedUsd).toBe(0);
    }
  });

  test("an unreachable Cloudflare is a reported error, not a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("Bearer fixture-analytics-token-not-real refused");
    }) as unknown as typeof fetch;
    const result = await cloudflareCheck(ENV, 30, { fetchImpl, now: NOW });
    expect(JSON.stringify(result)).not.toContain("fixture-analytics-token");
    expect(result).toMatchObject({ configured: true, error: "Cloudflare could not be reached" });
  });

  test("the window starts at midnight UTC, days - 1 days back", () => {
    expect(windowStart(1, NOW)).toBe("2026-10-08T00:00:00.000Z");
    expect(windowStart(30, NOW)).toBe("2026-09-09T00:00:00.000Z");
  });
});
