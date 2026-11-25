/**
 * What the Data page's buttons write (stage B): a metric note from its
 * template, and a push source's about.md and first sheet. Pure text and
 * paths: never a value, never a credential.
 */

import { describe, expect, test } from "@jest/globals";
import { parseFormula } from "../../mcp/src/data/formula/index.js";
import { parseSheet } from "../../mcp/src/sheets/csv.js";
import { datasetHeader, freePath, newMetricText, pushSourceFiles, slugOf, startingFormula } from "../features/console/files/data/dataWrites";
import { properties, splitNote } from "../features/console/files/frontmatter";
import { metricOf } from "../features/console/files/data/metrics";
import type { DataSource } from "../features/console/files/data/sources";

const props = (text: string) => Object.fromEntries(properties(splitNote(text).frontmatter).map((row) => [row.key, row.value]));

describe("a new metric note", () => {
  test("is a metric with a formula that parses, a period and no value", () => {
    const text = newMetricText("count(github/pull-requests.number)");
    const metric = metricOf({ path: "data/metrics/new-metric.md", properties: props(text) });
    expect(metric.name).toBe("New metric");
    expect(metric.every).toBe("week");
    expect(metric.parsed.ok).toBe(true);
    expect(splitNote(text).body).not.toMatch(/\d/);
  });

  test("starts from a sheet the reader has, else a shape to fill in", () => {
    const source: DataSource = {
      folder: "data/github",
      slug: "github",
      kind: "github",
      name: "GitHub",
      aboutPath: "data/github/about.md",
      about: null,
      datasets: [{ name: "pull-requests", path: "data/github/pull-requests.csv", computed: false }],
    };
    const sheets = new Map([["data/github/pull-requests.csv", { columns: [{ name: "number", type: "number" }], rows: [] }]]);
    const formula = startingFormula([source], sheets);
    expect(formula).toBe("count(github/pull-requests.number)");
    expect(parseFormula(formula).ok).toBe(true);
    expect(startingFormula([source], new Map())).toBe("count(source/dataset.column)");
  });

  test("takes a free name beside the others", () => {
    const taken = new Set(["data/metrics/new-metric.md", "data/metrics/new-metric-2.md"]);
    expect(freePath("data/metrics", "new-metric", ".md", taken)).toBe("data/metrics/new-metric-3.md");
    expect(freePath("data/metrics", "new-metric", ".md", new Set())).toBe("data/metrics/new-metric.md");
  });
});

describe("a push source", () => {
  test("is an about.md saying source: push and one sheet with a date column first", () => {
    const files = pushSourceFiles("data", "Eval CI", "Bench runs", "suite, p95 ms:number", new Set());
    if (typeof files === "string") throw new Error(files);
    expect(files.folder).toBe("data/eval-ci");
    expect(files.about.path).toBe("data/eval-ci/about.md");
    expect(props(files.about.text)).toMatchObject({ source: "push", name: "Eval CI" });
    expect(files.sheet.path).toBe("data/eval-ci/bench-runs.csv");
    const sheet = parseSheet(files.sheet.text) as { columns: { name: string; type: string }[] };
    expect(sheet.columns.map((c) => [c.name, c.type])).toEqual([
      ["date", "date"],
      ["suite", "text"],
      ["p95 ms", "number"],
    ]);
  });

  test("keeps a date column the person named, and drops a repeated one", () => {
    expect(datasetHeader("at:date, n:number, N:number")).toBe("at:date,n:number\n");
  });

  test("says why when it cannot be made", () => {
    expect(pushSourceFiles("data", "!!", "rows", "n", new Set())).toMatch(/name/);
    expect(pushSourceFiles("data", "metrics", "rows", "n", new Set())).toMatch(/name/);
    expect(pushSourceFiles("data", "Eval CI", "", "n", new Set())).toMatch(/dataset/);
    expect(pushSourceFiles("data", "Eval CI", "rows", "n", new Set(["data/eval-ci"]))).toBe("There is already a source called eval-ci.");
  });

  test("a name cannot break out of its front matter line", () => {
    const files = pushSourceFiles("data", "Evil\n---\nsource: github", "rows", "n", new Set());
    if (typeof files === "string") throw new Error(files);
    expect(props(files.about.text).source).toBe("push");
    expect(slugOf("Evil\n---\nsource: github")).toBe("evil-source-github");
  });
});
