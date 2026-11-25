/**
 * What the Data page's buttons write (stage B): a metric note from its
 * template, and a push source's about.md and first sheet. Pure text and
 * paths: never a value, never a credential.
 */

import { describe, expect, test } from "@jest/globals";
import { parseFormula } from "../../mcp/src/data/formula/index.js";
import { parseSheet } from "../../mcp/src/sheets/csv.js";
import { datasetHeader, freePath, pushSourceFiles, slugOf, startingFormula } from "../features/console/files/data/dataWrites";
import { properties, splitNote } from "../features/console/files/frontmatter";
import { metricOf } from "../features/console/files/data/metrics";
import type { DataSource } from "../features/console/files/data/sources";

const props = (text: string) => Object.fromEntries(properties(splitNote(text).frontmatter).map((row) => [row.key, row.value]));

describe("a new metric note", () => {
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

describe("the call that sends a row", () => {
  // Required here, not imported, so the pure tests above stay free of the page's components.
  const { sendRowCall } = require("../features/console/files/data/SourcePage") as typeof import("../features/console/files/data/SourcePage");
  const sheet = parseSheet("date:date,suite,p95 ms:number\n2026-11-24,answers,1500\n2026-11-25,search,1436\n") as never;

  test("reads like the sheet's latest row, with the key named and never written", () => {
    const { text } = sendRowCall("https://example.com/api/sheets/rows", sheet);
    expect(text).toContain(`'{"rows":[{"suite":"search","p95 ms":1436}]}'`);
    expect(text).toContain('"Authorization: Bearer $CONTEXT_KEY"');
    expect(text).not.toContain("date");
  });

  test("an empty sheet gets a value of each column's type", () => {
    const { text } = sendRowCall("https://example.com/api/sheets/rows", parseSheet("date:date,suite,n:number\n") as never);
    expect(text).toContain(`{"suite":"…","n":1}`);
  });
});
