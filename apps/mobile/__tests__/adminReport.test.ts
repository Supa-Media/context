import { describe, expect, test } from "@jest/globals";
import {
  ADMIN_TABS,
  DEFAULT_WINDOW,
  KNOWN_SECRETS,
  METRIC_ORDER,
  MIN_SEGMENT_PERCENT,
  WINDOW_CHOICES,
  barHeights,
  bindingStatusTone,
  compositionOf,
  dayOverDay,
  formatCount,
  formatDelta,
  formatLastUsed,
  formatMoney,
  formatRatio,
  formatSigned,
  formatTotal,
  funnelRows,
  isAdminTab,
  metricLabel,
  orderSeries,
  periodCaption,
  planLabel,
  planTone,
  providerLabel,
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

  test("managed storage is offered and the environment-only webhook secret is not", () => {
    const names = KNOWN_SECRETS.map((known) => known.name);
    expect(names).toContain("MANAGED_R2_API_TOKEN");
    expect(names).not.toContain("STRIPE_WEBHOOK_SECRET");
  });
});

describe("a total the server stopped counting", () => {
  test("an exact total renders as a number", () => {
    expect(formatTotal({ count: 412, isFloor: false })).toBe("412");
  });

  test("a floor says so rather than stating a number nobody measured", () => {
    // `usageReport` reads one bounded page instead of scanning the table, so
    // past its ceiling the server genuinely does not know the total. Printing
    // "10,000" would be a figure somebody quotes.
    expect(formatTotal({ count: 10_000, isFloor: true })).toBe("10.0K+");
  });
});

// -- the census redesign --------------------------------------------------

describe("change, at the size this product actually is", () => {
  test("the period comparison prints both halves and the difference", () => {
    // A percentage is the wrong instrument here: three signups against one is
    // "+200%", which is a number somebody repeats in a board update and which
    // means nothing at this scale. The three facts do.
    expect(periodCaption(3, 1)).toBe("+2 — 3 vs 1 before");
  });

  test("no change says so, rather than reading as no data", () => {
    expect(periodCaption(2, 2)).toBe("±0 — 2 vs 2 before");
    expect(periodCaption(0, 0)).toBe("±0 — 0 vs 0 before");
  });

  test("a fall uses a real minus sign, matching the percentage formatter", () => {
    expect(formatSigned(-3)).toBe("−3");
    expect(formatSigned(4)).toBe("+4");
    expect(formatSigned(0)).toBe("±0");
  });
});

describe("money", () => {
  test("whole dollars from cents, never a float", () => {
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(500)).toBe("$5");
    expect(formatMoney(1_500)).toBe("$15");
  });

  test("a part-dollar total is shown to the cent rather than rounded away", () => {
    expect(formatMoney(1_250)).toBe("$12.50");
  });
});

describe("ratios and last-used", () => {
  test("one decimal, and an em dash where there was nothing to divide by", () => {
    expect(formatRatio(1.6)).toBe("1.6");
    expect(formatRatio(2)).toBe("2.0");
    expect(formatRatio(null)).toBe("—");
  });

  test("a client that has never been used says so", () => {
    // "never" is a fact about the grant; an em dash would read as a figure the
    // page failed to fetch.
    expect(formatLastUsed(null)).toBe("never");
    expect(formatLastUsed(Date.now() - 3_600_000)).toBe("1h ago");
  });
});

describe("composition bars", () => {
  const part = (key: string, count: number) => ({
    key,
    label: key,
    count,
    tone: "accent" as const,
  });

  test("proportional when every slice is comfortably visible", () => {
    const segments = compositionOf([part("a", 3), part("b", 1)]);
    expect(segments.map((s) => s.percent)).toEqual([75, 25]);
  });

  test("empty parts are dropped rather than drawn as slivers", () => {
    const segments = compositionOf([part("a", 3), part("b", 0)]);
    expect(segments.map((s) => s.key)).toEqual(["a"]);
  });

  test("an all-zero composition is nothing, not a bar", () => {
    // So the screen can say "no contexts yet" instead of drawing a shape that
    // looks like data.
    expect(compositionOf([part("a", 0), part("b", 0)])).toEqual([]);
  });

  test("a slice too small to see is lifted off zero, and the bar still totals 100", () => {
    // The case this exists for: one paying context out of four hundred is
    // 0.25% of the bar, which is no pixels at any width — and "one" and "none"
    // are the two states this page exists to tell apart.
    const segments = compositionOf([part("free", 399), part("paying", 1)]);
    const paying = segments.find((s) => s.key === "paying");
    expect(paying?.percent).toBe(MIN_SEGMENT_PERCENT);
    expect(
      segments.reduce((sum, s) => sum + s.percent, 0),
    ).toBeCloseTo(100);
    // And the count beside it is untouched — the widths are a picture, the
    // numbers are the truth.
    expect(paying?.count).toBe(1);
  });

  test("many tiny slices fall back to an even split rather than overflowing", () => {
    const segments = compositionOf(
      Array.from({ length: 80 }, (_, i) => part(`k${i}`, 1)),
    );
    expect(segments).toHaveLength(80);
    expect(segments.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100);
    for (const segment of segments) {
      expect(segment.percent).toBeGreaterThan(0);
    }
  });
});

describe("the funnel", () => {
  const steps = [
    { step: "signed-up", count: 4 },
    { step: "made-a-context", count: 3 },
    { step: "connected-storage", count: 1 },
    { step: "connected-a-client", count: 2 },
    { step: "paying", count: 1 },
  ];

  test("every step is a share of everybody who signed up", () => {
    const rows = funnelRows(steps);
    expect(rows[0].share).toBe(1);
    expect(rows[1].share).toBeCloseTo(0.75);
    expect(rows.map((row) => row.label)).toEqual([
      "Signed up",
      "Made a context",
      "Connected storage",
      "Connected a client",
      "Paying",
    ]);
  });

  test("a step larger than the one above it reports a rise, and is not hidden", () => {
    // Somebody connected a client to a context whose bucket never verified.
    // That is the customer to go and find, so the row says `+1` rather than
    // being clamped into a tidy staircase.
    const rows = funnelRows(steps);
    expect(rows[2].change).toBe(-2);
    expect(rows[3].change).toBe(1);
    expect(rows[3].share).toBeCloseTo(0.5);
  });

  test("the first step has nothing above it to compare against", () => {
    expect(funnelRows(steps)[0].change).toBeNull();
  });

  test("an empty deployment divides by nothing rather than by zero", () => {
    const rows = funnelRows([
      { step: "signed-up", count: 0 },
      { step: "paying", count: 0 },
    ]);
    expect(rows.every((row) => row.share === 0)).toBe(true);
  });
});

describe("names for what the census counts", () => {
  test("a provider the server adds shows up under its raw key, not dropped", () => {
    // Same rule `metricLabel` follows: a new one should look unfinished rather
    // than vanish from a total somebody is reading.
    expect(providerLabel("r2")).toBe("Cloudflare R2");
    expect(providerLabel("some-new-store")).toBe("some-new-store");
  });

  test("an unverified bucket is amber, not neutral", () => {
    // A bucket nothing has reached is not a neutral state on a console whose
    // job is to notice one.
    expect(bindingStatusTone("connected")).toBe("ok");
    expect(bindingStatusTone("unverified")).toBe("warn");
    expect(bindingStatusTone("error")).toBe("crit");
  });

  test("a declined card reads louder than a cancellation", () => {
    // A cancellation is a decision; a past-due card is money that was supposed
    // to arrive and did not, and is the one to act on today.
    expect(planTone("active")).toBe("ok");
    expect(planTone("past_due")).toBe("crit");
    expect(planTone("canceled")).toBe("warn");
    expect(planTone("none")).toBe("neutral");
    expect(planLabel("none")).toBe("Free");
  });
});

describe("the tabs", () => {
  test("the four errands are distinct and growth comes first", () => {
    expect(ADMIN_TABS.map((tab) => tab.key)).toEqual([
      "growth",
      "estate",
      "activity",
      "credentials",
    ]);
    expect(isAdminTab("growth")).toBe(true);
    expect(isAdminTab("secrets")).toBe(false);
  });

  test("the offered windows are all inside what the server will clamp to", () => {
    // 90 is `MAX_REPORT_DAYS`. Offering 180 would silently hand back 90 under
    // a label that said otherwise.
    for (const choice of WINDOW_CHOICES) {
      expect(choice).toBeGreaterThanOrEqual(1);
      expect(choice).toBeLessThanOrEqual(90);
    }
    expect(WINDOW_CHOICES).toContain(DEFAULT_WINDOW);
  });
});
