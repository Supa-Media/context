import { describe, expect, test } from "@jest/globals";
import {
  KNOWN_SECRETS,
  METRIC_ORDER,
  barHeights,
  dayOverDay,
  formatCount,
  formatDelta,
  metricLabel,
  orderSeries,
  relativeTime,
  shortDay,
  unsetKnownSecrets,
} from "../features/admin/report";

/**
 * The arithmetic behind the admin dashboard.
 *
 * A number on this page is read once and quoted afterwards, so the failure
 * that matters is not a crash — it is a figure that is quietly wrong and looks
 * fine. These pin the three places that happens: a percentage computed from a
 * zero baseline, a sparkline scaled so that a busy series flattens a quiet
 * one, and a metric the server started sending that the screen silently drops.
 */

describe("bar heights", () => {
  const points = (counts: number[]) =>
    counts.map((count, index) => ({ day: `2026-09-0${index + 1}`, count }));

  test("scale to the series' own maximum", () => {
    expect(barHeights(points([0, 5, 10]))).toEqual([0, 0.5, 1]);
  });

  test("an all-zero series is flat rather than a division by zero", () => {
    expect(barHeights(points([0, 0, 0]))).toEqual([0, 0, 0]);
    expect(barHeights([])).toEqual([]);
  });

  test("one day is one full bar", () => {
    // Not zero. A lone bar is the honest picture of one day of data; a series
    // scaled against itself to zero would draw "we have data" as "we have
    // none".
    expect(barHeights(points([7]))).toEqual([1]);
  });
});

describe("day over day", () => {
  const points = (counts: number[]) =>
    counts.map((count, index) => ({ day: `2026-09-0${index + 1}`, count }));

  test("compares the last two days", () => {
    expect(dayOverDay(points([10, 12]))).toBeCloseTo(0.2);
    expect(dayOverDay(points([10, 5]))).toBeCloseTo(-0.5);
  });

  test("a rise from zero is not a percentage", () => {
    // The number that gets quoted later. "+100%" from a baseline of nothing is
    // a claim the data does not support, and "+∞%" is worse.
    expect(dayOverDay(points([0, 40]))).toBeNull();
    expect(formatDelta(dayOverDay(points([0, 40])))).toBe("—");
  });

  test("fewer than two days has nothing to compare", () => {
    expect(dayOverDay(points([5]))).toBeNull();
    expect(dayOverDay([])).toBeNull();
  });

  test("formats with a real minus sign", () => {
    expect(formatDelta(0.12)).toBe("+12%");
    expect(formatDelta(-0.04)).toBe("−4%");
    expect(formatDelta(0)).toBe("0%");
    expect(formatDelta(null)).toBe("—");
    // A hyphen beside numerals at this size reads as a dash between them.
    expect(formatDelta(-0.5).charCodeAt(0)).toBe(0x2212);
  });
});

describe("counts", () => {
  test("four digits stay exact, larger numbers shorten", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(9_999)).toBe("9,999");
    expect(formatCount(10_000)).toBe("10.0K");
    expect(formatCount(1_284_003)).toBe("1.28M");
  });

  test("a non-number is a dash, never NaN on the screen", () => {
    expect(formatCount(Number.NaN)).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("metric presentation", () => {
  test("known metrics get a human label", () => {
    expect(metricLabel("mcp.tool_call")).toBe("Tool calls");
    expect(metricLabel("search.query")).toBe("Searches");
  });

  test("an unknown metric is shown, not dropped", () => {
    // A counter the server started sending must appear — under its raw name
    // and at the end, but visible. A screen that silently drops it is how a
    // metric gets added and nobody notices it is always zero.
    expect(metricLabel("billing.charge")).toBe("billing.charge");
    const ordered = orderSeries([
      { metric: "billing.charge", points: [], total: 1 },
      { metric: "mcp.tool_call", points: [], total: 2 },
    ]);
    expect(ordered.map((entry) => entry.metric)).toEqual([
      "mcp.tool_call",
      "billing.charge",
    ]);
  });

  test("ordering is the declared one, not whatever arrived", () => {
    const shuffled = [...METRIC_ORDER]
      .reverse()
      .map((metric) => ({ metric, points: [], total: 0 }));
    expect(orderSeries(shuffled).map((entry) => entry.metric)).toEqual([
      ...METRIC_ORDER,
    ]);
  });

  test("every ordered metric has a label", () => {
    // Otherwise a tile in a deliberate position carries a raw identifier,
    // which is the one combination that looks like a bug rather than a
    // new metric.
    for (const metric of METRIC_ORDER) {
      expect(metricLabel(metric)).not.toBe(metric);
    }
  });
});

describe("dates and times", () => {
  test("a day is shortened in UTC", () => {
    expect(shortDay("2026-09-04")).toBe("4 Sep");
    expect(shortDay("2026-01-31")).toBe("31 Jan");
    expect(shortDay("nonsense")).toBe("nonsense");
  });

  test("relative time is coarse on purpose", () => {
    const now = Date.parse("2026-09-04T12:00:00Z");
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
    expect(relativeTime(now - 90 * 86_400_000, now)).toBe("3mo ago");
    expect(relativeTime(now - 400 * 86_400_000, now)).toBe("1y ago");
  });

  test("a future timestamp does not read as negative", () => {
    const now = Date.parse("2026-09-04T12:00:00Z");
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("the known-integration list", () => {
  test("names match the environment-variable shape the server enforces", () => {
    // A suggestion that the server would reject is worse than no suggestion:
    // it is a name somebody picks from a list and then cannot save.
    for (const known of KNOWN_SECRETS) {
      expect(known.name).toMatch(/^[A-Z][A-Z0-9_]{2,63}$/);
    }
  });

  test("no suggestion is one of the keys the server refuses", () => {
    // The reserved set is enforced in `functions/lib/appSecrets.ts`; this
    // stops the console from offering one and getting a refusal.
    const reserved = new Set([
      "STORAGE_SECRET_ENCRYPTION_KEY",
      "STORAGE_SECRET_ENCRYPTION_KEY_ID",
      "GATEWAY_SECRET",
      "JWT_PRIVATE_KEY",
      "JWKS",
      "CONVEX_DEPLOY_KEY",
      "ADMIN_EMAILS",
    ]);
    for (const known of KNOWN_SECRETS) {
      expect(reserved.has(known.name)).toBe(false);
    }
  });

  test("every suggestion says what breaks while it is unset", () => {
    // The difference between a checklist and a page somebody can act on.
    for (const known of KNOWN_SECRETS) {
      expect(known.unsetMeans.length).toBeGreaterThan(0);
      expect(known.description.length).toBeGreaterThan(0);
    }
  });

  test("configured names drop out of the suggestions", () => {
    const unset = unsetKnownSecrets([{ name: "SEARCH_D1_API_TOKEN" }]);
    expect(unset.map((known) => known.name)).not.toContain(
      "SEARCH_D1_API_TOKEN",
    );
    expect(unset.length).toBe(KNOWN_SECRETS.length - 1);
  });

  test("the D1 pair the search work needs is offered", () => {
    const names = KNOWN_SECRETS.map((known) => known.name);
    expect(names).toContain("SEARCH_D1_API_TOKEN");
    expect(names).toContain("SEARCH_D1_ACCOUNT_ID");
  });
});
