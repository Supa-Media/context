/**
 * The Tex dashboard's day-by-day arithmetic (`features/tex/dashboard/trends.ts`):
 * a day with nothing to measure is a gap, never a zero; the change is the
 * latest known day against the one before it; and good or bad follows which
 * way the figure should go.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import type { TexReport } from "../features/tex/dashboard/model";
import { formatDelta, lastChange, spendByDay, toneOf, trendPaths, type TexSpend } from "../features/tex/dashboard/trends";

describe("day by day", () => {
  test("the change skips unknown days and compares the last two known ones", () => {
    expect(lastChange([0.5, null, 0.75, null])).toEqual({ last: 0.75, delta: 0.25 });
    expect(lastChange([null, 4])).toEqual({ last: 4, delta: null });
    expect(lastChange([null])).toEqual({ last: null, delta: null });
  });

  test("good or bad follows which way the figure should go", () => {
    expect(toneOf("down", -0.1)).toBe("good");
    expect(toneOf("down", 0.1)).toBe("bad");
    expect(toneOf("up", 0.3)).toBe("good");
    expect(toneOf(null, 5)).toBe("flat");
  });

  test("the line breaks at a day with nothing to measure, instead of dropping to zero", () => {
    const { line, points } = trendPaths([1, 1, null, 1], 1, 300, 120);
    expect(points.map((p) => p.i)).toEqual([0, 1, 3]);
    expect(line.match(/M/g)).toHaveLength(2);
    expect(points.every((p) => p.y === 4)).toBe(true);
  });

  test("a change reads in the unit's own terms", () => {
    expect(formatDelta("pct", -0.08)).toBe("−8 pts");
    expect(formatDelta("score", 0.3)).toBe("+0.3");
    expect(formatDelta("usd", 8.5)).toBe("+$8.50");
  });

  test("billed spend is blank before the oldest day Cloudflare keeps, and our estimate stands in when it is not connected", () => {
    const report = { turns: { byDay: [{ day: "2026-10-24", turns: 3, costMicroUsd: 2_000_000 }] } } as unknown as TexReport;
    const days = ["2026-08-20", "2026-10-23", "2026-10-24"];
    const billed = { configured: true, error: null, totalUsd: 5, testsUsd: 0, keptFrom: "2026-08-26", days: [{ day: "2026-10-24", usd: 5, requests: 9 }], models: [], jobs: [] } as TexSpend;
    expect(spendByDay(report, billed, days)).toEqual({ values: [null, null, 5], real: true });
    expect(spendByDay(report, { configured: false }, days)).toEqual({ values: [null, null, 2], real: false });
  });
});
