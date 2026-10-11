/**
 * The Search tab's words and numbers (`features/admin/search.ts`).
 *
 * Searches are mostly well under a second, so the tab reads in milliseconds
 * there, and a faster week is good news.
 */

import { describe, expect, test } from "@jest/globals";
import { describe as describeChart } from "../features/admin/AgentChart";
import { answeredByLabel, averageChange, chartBuckets, formatMs, surfaceLabel } from "../features/admin/search";

describe("times", () => {
  test("milliseconds under a second, seconds past it", () => {
    expect(formatMs(0)).toBe("—");
    expect(formatMs(Number.NaN)).toBe("—");
    expect(formatMs(240.4)).toBe("240 ms");
    expect(formatMs(1_420)).toBe("1.4 s");
    expect(formatMs(12_400)).toBe("12 s");
  });

  test("an average against the window before", () => {
    expect(averageChange({ count: 5, avg: 300 }, { count: 9, avg: 900 }, 7)).toEqual({
      text: "600 ms faster than the 7 days before",
      tone: "ok",
    });
    expect(averageChange({ count: 5, avg: 2_000 }, { count: 9, avg: 500 }, 1)).toEqual({
      text: "1.5 s slower than the day before",
      tone: "crit",
    });
    expect(averageChange({ count: 5, avg: 300 }, { count: 9, avg: 320 }, 7).text).toBe("Same as the 7 days before");
    expect(averageChange({ count: 5, avg: 300 }, { count: 0, avg: 0 }, 30).tone).toBe("neutral");
  });
});

describe("words", () => {
  test("every index and every surface has a name a person reads", () => {
    expect(answeredByLabel("fast")).toBe("Fast search");
    expect(answeredByLabel("index")).toBe("Index in the bucket");
    expect(answeredByLabel(null)).toBe("—");
    expect(surfaceLabel("page")).toBe("Search page");
    expect(surfaceLabel("ai")).toBe("AI client");
  });
});

describe("the chart", () => {
  test("is the agent chart, counting searches", () => {
    const buckets = chartBuckets([
      { label: "2026-10-06", count: 0, avg: 0, p50: 0, p95: 0 },
      { label: "2026-10-07", count: 3, avg: 300, p50: 250, p95: 600 },
    ]);
    expect(buckets[1]).toEqual({ label: "2026-10-07", turns: 3, p50: 250, p95: 600 });
    expect(describeChart(buckets, formatMs, "Searches")).toBe("3 searches. Busiest 7 Oct, typical 250 ms, slowest 600 ms.");
    expect(describeChart([], formatMs, "Searches")).toBe("No searches in this window.");
  });
});
