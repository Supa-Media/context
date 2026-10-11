/**
 * The AI costs tab's arithmetic and words (`features/admin/aiCosts.ts`).
 *
 * The figures come from `admin.aiCostsReport`, `admin.aiCostsAccount` and
 * `admin.aiCostsCloudflare`; what these check is that a person reads them
 * right: a sub-cent price keeps two significant digits, a change is a signed
 * dollar amount against the window before, and the Cloudflare rows are added
 * only when Cloudflare is actually configured.
 */

import { describe, expect, test } from "@jest/globals";
import type {
  AiCostsCloudflare,
  AiCostsReport,
} from "@context/convex/functions/lib/adminFns/aiCostsShape";
import {
  FEATURE_ORDER,
  changeLine,
  changeTone,
  checkLine,
  featureTone,
  formatDollars,
  formatUnitPrice,
  mergeFeatures,
  mostExpensive,
  modelNames,
  perAccountLine,
  planShareLine,
  priceLine,
  splitByFeature,
  stackedDays,
  tallestDayLine,
  todayLine,
  workspaceLabel,
} from "../features/admin/aiCosts";

describe("money", () => {
  test("dollars read the way a person says them", () => {
    expect(formatDollars(3.27)).toBe("$3.27");
    expect(formatDollars(0.24)).toBe("$0.24");
    expect(formatDollars(5)).toBe("$5");
    expect(formatDollars(1234.5)).toBe("$1,234.50");
    expect(formatDollars(0)).toBe("$0");
  });

  test("under a cent keeps two significant digits and drops the padding", () => {
    expect(formatDollars(0.0018)).toBe("$0.0018");
    expect(formatDollars(0.00046)).toBe("$0.00046");
    expect(formatDollars(0.0002)).toBe("$0.0002");
    expect(formatDollars(0.00001)).toBe("$0.00001");
    // Above a cent the money rule is two decimals, whatever the digits.
    expect(formatDollars(0.012)).toBe("$0.01");
  });

  test("a unit price keeps two decimals and never loses a digit below a dollar", () => {
    expect(formatUnitPrice(0.06)).toBe("$0.06");
    expect(formatUnitPrice(0.4)).toBe("$0.40");
    expect(formatUnitPrice(0.012)).toBe("$0.012");
    expect(formatUnitPrice(0.24)).toBe("$0.24");
    expect(formatUnitPrice(0)).toBe("$0");
    expect(formatUnitPrice(2)).toBe("$2");
  });

  test("a value that is not a number is a dash, never $NaN", () => {
    expect(formatDollars(Number.NaN)).toBe("—");
  });

  test("a change against the window before is signed, in dollars", () => {
    expect(changeLine(3.27, 1.37, 30)).toBe("+$1.90 vs the 30 days before");
    expect(changeLine(0.4, 0.8, 7)).toBe("−$0.40 vs the 7 days before");
    expect(changeLine(1, 1.001, 30)).toBe("Same as the 30 days before");
  });

  test("a rise in spend is a warning, a fall is good news, a hair is neutral", () => {
    expect(changeTone(3.27, 1.37)).toBe("warn");
    expect(changeTone(0.4, 0.8)).toBe("ok");
    expect(changeTone(1, 1)).toBe("neutral");
  });

  test("a percentage of the plan is whole, and absent when nobody pays", () => {
    expect(planShareLine(0.62, 5)).toBe("12% of the $5 plan");
    expect(planShareLine(0.62, null)).toBeNull();
    expect(planShareLine(0.62, 0)).toBeNull();
  });

  test("the per-account line names how many accounts it divides by", () => {
    expect(perAccountLine(8)).toBe("linked spend ÷ 8 paying accounts");
    expect(perAccountLine(1)).toBe("linked spend ÷ 1 paying account");
  });
});

describe("features", () => {
  test("feature colours come in one fixed order, each its own tone", () => {
    expect(FEATURE_ORDER).toEqual([
      "assistant",
      "whatChanged",
      "organizer",
      "ownerSuggest",
      "transcription",
      "meaning",
    ]);
    const tones = FEATURE_ORDER.map((feature) => featureTone(feature));
    expect(new Set(tones).size).toBe(FEATURE_ORDER.length);
    expect(featureTone("assistant")).toBe("accent");
    expect(featureTone("whatChanged")).toBe("shared");
  });

  test("the Cloudflare-only rows are added only when Cloudflare is configured", () => {
    const off = mergeFeatures(report().features, { configured: false });
    expect(off.map((row) => row.feature)).not.toContain("transcription");
    expect(off.map((row) => row.feature)).not.toContain("meaning");

    const unknown = mergeFeatures(report().features, undefined);
    expect(unknown.map((row) => row.feature)).not.toContain("transcription");
  });

  test("with Cloudflare configured, transcription and meaning are added as no-account rows", () => {
    const rows = mergeFeatures(report().features, cloudflare());
    expect(rows.find((row) => row.feature === "transcription")).toMatchObject({
      label: "Meeting transcription",
      noAccount: true,
      costUsd: 1.29,
    });
    expect(rows.find((row) => row.feature === "meaning")).toMatchObject({
      label: "Search by meaning",
      noAccount: true,
      costUsd: 0.04,
    });
    expect(rows.find((row) => row.feature === "assistant")?.noAccount).toBe(false);
  });

  test("the merged list is the most expensive first", () => {
    const rows = mergeFeatures(report().features, cloudflare());
    const costs = rows.map((row) => row.costUsd);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(rows[0].feature).toBe("transcription");
  });

  test("a feature the report already carries is not added twice", () => {
    const features = [
      ...report().features,
      {
        feature: "transcription",
        label: "Meeting transcription",
        models: ["@cf/openai/whisper-large-v3-turbo"],
        uses: 7663,
        unit: "minutes",
        eachUsd: 0.00017,
        costUsd: 1.29,
      },
    ];
    const rows = mergeFeatures(features, cloudflare());
    expect(rows.filter((row) => row.feature === "transcription")).toHaveLength(1);
  });

  test("the most expensive feature, and its share of the total", () => {
    const rows = mergeFeatures(report().features, cloudflare());
    expect(mostExpensive(rows)).toEqual({ label: "Meeting transcription", costUsd: 1.29, percent: 39 });
    expect(mostExpensive([])).toBeNull();
  });

  test("a bar splits each account by feature, as fractions of its own spend", () => {
    const parts = splitByFeature([
      { feature: "whatChanged", costUsd: 0.5 },
      { feature: "assistant", costUsd: 0.25 },
      { feature: "organizer", costUsd: 0.25 },
    ]);
    expect(parts.map((part) => part.feature)).toEqual(["assistant", "whatChanged", "organizer"]);
    expect(parts.map((part) => part.fraction)).toEqual([0.25, 0.5, 0.25]);
    expect(splitByFeature([{ feature: "assistant", costUsd: 0 }])).toEqual([]);
  });
});

describe("the Cloudflare check", () => {
  test("billed, linked and not linked, as one line", () => {
    const rows = mergeFeatures(report().features, cloudflare());
    const check = checkLine(rows, 3.27);
    expect(check.linkedUsd).toBeCloseTo(1.94, 2);
    expect(check.notLinkedUsd).toBeCloseTo(1.33, 2);
    expect(check.text).toBe("billed $3.27 · $1.94 linked to an account · $1.33 not linked");
  });
});

describe("the days and the accounts", () => {
  test("the tallest day is the largest sum across features", () => {
    expect(tallestDayLine(report().daily)).toBe("tallest day $0.41");
    expect(tallestDayLine([])).toBe("no spend in this window");
  });

  test("each day stacks its features in the fixed order, tallest day at full height", () => {
    const days = stackedDays([
      {
        day: "2026-10-06",
        byFeature: [
          { feature: "organizer", costUsd: 0.1 },
          { feature: "assistant", costUsd: 0.1 },
        ],
      },
      { day: "2026-10-07", byFeature: [{ feature: "assistant", costUsd: 0.3 }] },
    ]);
    expect(days[0].segments.map((segment) => segment.feature)).toEqual(["assistant", "organizer"]);
    expect(days[0].height).toBeCloseTo(2 / 3, 5);
    expect(days[1].height).toBe(1);
  });

  test("an account's uses today read as a fraction of the cap", () => {
    expect(todayLine({ feature: "assistant", label: "Texting assistant", used: 34, cap: 100 })).toEqual({
      text: "Texting assistant today: 34 of 100 questions",
      fraction: 0.34,
    });
    expect(todayLine({ feature: "whatChanged", label: "What changed", used: 12, cap: 100 }).text).toBe(
      "What changed today: 12 of 100 new items",
    );
    expect(todayLine({ feature: "assistant", label: "Texting assistant", used: 0, cap: 0 }).fraction).toBe(0);
  });

  test("a workspace is named with its @, once", () => {
    expect(workspaceLabel("maya")).toBe("@maya");
    expect(workspaceLabel("@maya")).toBe("@maya");
  });

  test("models read by their names, joined with a plus", () => {
    expect(modelNames(["@cf/cloudflare/clef", "@cf/zai-org/glm-4.7-flash"])).toBe("Clef + GLM-4.7 Flash");
    expect(modelNames([])).toBe("—");
  });

  test("a price per million tokens reads in and out", () => {
    expect(priceLine({ input: 0.06, output: 0.4 })).toBe("$0.06 in · $0.40 out");
    expect(priceLine({ input: 0.012, output: 0.012 })).toBe("$0.012 in · $0.012 out");
    expect(priceLine(null)).toBe("—");
  });
});

function report(over: Partial<AiCostsReport> = {}): AiCostsReport {
  return {
    days: 30,
    since: "2026-09-09",
    totalUsd: 3.27,
    priorUsd: 1.37,
    payingAccounts: 8,
    perPayingAccountUsd: 0.24,
    textedQuestions: 412,
    perQuestionUsd: 0.0018,
    features: [
      {
        feature: "whatChanged",
        label: "What changed",
        models: ["@cf/zai-org/glm-4.7-flash"],
        uses: 640,
        unit: "new items",
        eachUsd: 0.0016,
        costUsd: 1.01,
      },
      {
        feature: "assistant",
        label: "Texting assistant (built-in model)",
        models: ["@cf/zai-org/glm-4.7-flash", "@cf/cloudflare/clef"],
        uses: 412,
        unit: "questions",
        eachUsd: 0.0018,
        costUsd: 0.75,
      },
      {
        feature: "organizer",
        label: "Auto-organize",
        models: ["@cf/cloudflare/clef"],
        uses: 398,
        unit: "notes",
        eachUsd: 0.00046,
        costUsd: 0.18,
      },
      { feature: "ownerSuggest", label: "Owner suggestion", models: [], uses: 0, unit: "", eachUsd: null, costUsd: 0 },
    ],
    models: [],
    unrecordedModelUsd: 0,
    daily: [
      {
        day: "2026-10-06",
        byFeature: [
          { feature: "assistant", costUsd: 0.2 },
          { feature: "whatChanged", costUsd: 0.1 },
        ],
      },
      {
        day: "2026-10-07",
        byFeature: [
          { feature: "assistant", costUsd: 0.31 },
          { feature: "whatChanged", costUsd: 0.1 },
        ],
      },
    ],
    accounts: [],
    moreAccounts: 0,
    truncated: false,
    ...over,
  };
}

function cloudflare(): AiCostsCloudflare {
  return {
    configured: true,
    error: null,
    billedUsd: 3.27,
    workersAi: [
      { model: "@cf/openai/whisper-large-v3-turbo", neurons: 9000, usd: 1.29 },
      { model: "@cf/baai/bge-m3", neurons: 60, usd: 0.04 },
    ],
    gateway: [],
  };
}
