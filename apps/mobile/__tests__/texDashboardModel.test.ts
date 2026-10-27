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
  frustrationByTask,
  heatOf,
  isFrustrated,
  measureOf,
  modelLabel,
  optionsOf,
  pivot,
  sparkPaths,
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
    // Asking for a feature is not a failure; a wrong answer is, even when they stayed calm.
    expect(isFrustrated({ ...ROWS[0]!, signals: ["feature_ask"] })).toBe(false);
    expect(isFrustrated({ ...ROWS[0]!, signals: ["wrong"] })).toBe(true);
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

  test("seconds keep a decimal only under ten", () => {
    expect(formatSeconds(4_200)).toBe("4.2s");
    expect(formatSeconds(75_000)).toBe("75s");
  });
});
