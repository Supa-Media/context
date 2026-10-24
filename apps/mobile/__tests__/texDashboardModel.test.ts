/**
 * The Tex dashboard's arithmetic (`features/tex/dashboard/model.ts`, drawn at
 * tex.lc/admin): filters, measures, the pivot Explore draws over scored
 * conversations, and the figures behind the page's charts.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import {
  applyFilters,
  filterButtonLabel,
  formatMicroUsd,
  formatSeconds,
  frustrationByDay,
  frustrationByTask,
  heatOf,
  isFrustrated,
  measureOf,
  modelLabel,
  needsALook,
  optionsOf,
  pivot,
  signalCounts,
  sparkPaths,
  textsToFinish,
  type TexReport,
  toggleFilter,
  type TexReview,
} from "../features/tex/dashboard/model";

function row(over: Partial<TexReview> = {}): TexReview {
  return {
    at: 1,
    kind: "one",
    reason: "ended",
    goal: 8,
    independence: 8,
    turns: 8,
    friendly: 8,
    calm: 9,
    task: "email",
    signals: [],
    texts: 2,
    who: "other",
    costMicroUsd: 1_000,
    thought: false,
    ...over,
  };
}

const ROWS = [
  row(),
  row({ task: "web_errand", signals: ["try_again", "repeated"], calm: 3, texts: 6, costMicroUsd: 20_000, thought: true }),
  row({ task: "web_errand", kind: "group", calm: 4, texts: 4 }),
  row({ task: null, signals: [], texts: null, costMicroUsd: null, thought: null, who: null }),
];

describe("filters", () => {
  test("a row passes when it takes any picked value on every filtered field", () => {
    expect(applyFilters(ROWS, {})).toHaveLength(4);
    expect(applyFilters(ROWS, { task: ["web_errand"] })).toHaveLength(2);
    expect(applyFilters(ROWS, { task: ["web_errand"], chat: ["group"] })).toHaveLength(1);
    expect(applyFilters(ROWS, { signal: ["try_again"] })).toHaveLength(1);
    expect(applyFilters(ROWS, { signal: ["none"] })).toHaveLength(3);
    expect(applyFilters(ROWS, { task: [] })).toHaveLength(4);
  });

  test("toggling adds and removes, and the button says what is picked", () => {
    const once = toggleFilter({}, "task", "email");
    expect(once.task).toEqual(["email"]);
    expect(toggleFilter(once, "task", "email").task).toEqual([]);
    expect(filterButtonLabel("task", [])).toBe("Task: all");
    expect(filterButtonLabel("task", ["web_errand"])).toBe("Task: Web errands");
    expect(filterButtonLabel("task", ["email", "notes"])).toBe("Task: 2 picked");
  });

  test("options are most common first, untagged rows named as such", () => {
    expect(optionsOf(ROWS, "task").map((o) => o.label)).toEqual(["Web errands", "Email", "Not tagged"]);
  });
});

describe("measures", () => {
  test("frustrated is any signal or calm 4 or under", () => {
    expect(ROWS.map(isFrustrated)).toEqual([false, true, true, false]);
    expect(measureOf(ROWS, "frustrated")).toBe(0.5);
  });

  test("texts and cost average only the rows that carry them", () => {
    expect(measureOf(ROWS, "texts")).toBe(4);
    expect(measureOf(ROWS, "cost")).toBeCloseTo(22_000 / 3);
    expect(measureOf([], "calm")).toBeNull();
  });

  test("money and model names read as people say them", () => {
    expect(formatMicroUsd(15_450)).toBe("$0.02");
    expect(formatMicroUsd(600)).toBe("$0.0006");
    expect(formatMicroUsd(3_200_000)).toBe("$3.20");
    expect(modelLabel("anthropic/claude-opus-5-5")).toBe("Opus 5.5");
  });
});

describe("the pivot", () => {
  test("rows sort worst first and cells split by the column", () => {
    const table = pivot(ROWS, "task", "chat", "frustrated");
    expect(table.rows.map((r) => r.label)).toEqual(["Web errands", "Email", "Not tagged"]);
    expect(table.cols.map((c) => c.label)).toEqual(["1:1", "Group chat"]);
    expect(table.cells[0]).toEqual([
      { n: 1, value: 1 },
      { n: 1, value: 1 },
    ]);
    expect(table.totals[0]).toEqual({ n: 2, value: 1 });
  });

  test("without a column there is one, and higher-is-better measures sort lowest first", () => {
    const table = pivot(ROWS, "task", null, "calm");
    expect(table.cols).toEqual([{ value: "*", label: "All" }]);
    expect(table.rows[0].label).toBe("Web errands");
  });

  test("heat runs from best to worst in the measure's own direction", () => {
    expect(heatOf("frustrated", 1, [0, 0.5, 1])).toBe(1);
    expect(heatOf("calm", 9, [3, 9])).toBe(0);
    expect(heatOf("count", 4, [1, 4])).toBeNull();
  });

  test("tasks ranked by how often they frustrate", () => {
    expect(frustrationByTask(ROWS)[0]).toMatchObject({ task: "web_errand", n: 2, share: 1 });
  });
});

describe("the page's charts", () => {
  test("a sparkline spans its box, and sits flat on the floor when everything is zero", () => {
    expect(sparkPaths([0, 5, 10], 120, 32).line).toBe("M0.0 31.0 L60.0 16.0 L120.0 1.0");
    expect(sparkPaths([0, 0], 120, 32).line).toBe("M0.0 31.0 L120.0 31.0");
    expect(sparkPaths([]).line).toBe("");
  });

  test("frustration per day is a share of that day's conversations, and null on a day with none", () => {
    const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
    const rows = [row({ at: day("2026-10-23"), calm: 2 }), row({ at: day("2026-10-23") }), row({ at: day("2026-10-24") })];
    expect(frustrationByDay(rows, ["2026-10-22", "2026-10-23", "2026-10-24"])).toEqual([null, 0.5, 0]);
  });

  test("signals are counted most first, by their label", () => {
    const rows = [row({ signals: ["try_again", "gave_up"] }), row({ signals: ["try_again"] })];
    expect(signalCounts(rows).map((s) => [s.code, s.n])).toEqual([["try_again", 2], ["gave_up", 1]]);
  });

  test("texts to finish buckets six and over together, and leaves out conversations with no count", () => {
    const rows = [row({ texts: 1 }), row({ texts: 2 }), row({ texts: 9 }), row({ texts: null })];
    const out = textsToFinish(rows);
    expect(out.n).toBe(3);
    expect(out.median).toBe(2);
    expect(out.buckets.map((b) => b.share)).toEqual([1 / 3, 1 / 3, 0, 0, 0, 1 / 3]);
  });

  test("needs a look names a frustrating task and a failing model, worst first, and stays quiet on small numbers", () => {
    const base = {
      turns: { total: 5, exhausted: 0, failed: 0, tools: [{ tool: "browse", calls: 3, failed: 3 }] },
      performance: { time: { p95: 5_000 }, models: [{ model: "fake/think-model", rounds: 20, failed: 4, cut: 0 }] },
    };
    const report = { ...base, reviews: [row({ task: "web_errand", calm: 2 }), row({ task: "web_errand", calm: 2 }), row({ task: "web_errand" })] } as unknown as TexReport;
    expect(needsALook(report).map((a) => a.text)).toEqual(["Web errands: 67% of 3 conversations frustrated people", "Think-model failed 20% of its rounds"]);
    const quiet = { ...base, reviews: [row({ calm: 2 })], performance: { time: { p95: 5_000 }, models: [] } } as unknown as TexReport;
    expect(needsALook(quiet)).toEqual([]);
  });

  test("seconds keep a decimal only under ten", () => {
    expect(formatSeconds(4_200)).toBe("4.2s");
    expect(formatSeconds(75_000)).toBe("75s");
  });
});
