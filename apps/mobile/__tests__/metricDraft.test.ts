/**
 * The metric builder's draft (boards 04 and 04b): the note it saves, where, why it can't save yet, and the column
 * suggestions the formula box offers. Pure: text, paths and lists.
 */

import { describe, expect, test } from "@jest/globals";
import {
  builderPeriod,
  columnSuggestions,
  columnWords,
  draftProblem,
  frontValue,
  insertSuggestion,
  metricNoteText,
  metricPathFor,
  previewWords,
  wordAt,
} from "../features/console/files/data/metricDraft";
import { frontMatterFields } from "../../mcp/src/data/sync/about.js";
import { metricOf } from "../features/console/files/data/metrics";
import { properties, splitNote } from "../features/console/files/frontmatter";
import type { DataSource } from "../features/console/files/data/sources";
import type { Sheet } from "../features/console/files/data/workOut";

const props = (text: string) => Object.fromEntries(properties(splitNote(text).frontmatter).map((row) => [row.key, row.value]));

const source = (slug: string, kind: DataSource["kind"], name: string, datasets: string[]): DataSource => ({
  folder: `data/${slug}`,
  slug,
  kind,
  name,
  aboutPath: `data/${slug}/about.md`,
  about: null,
  datasets: datasets.map((each) => ({ name: each, path: `data/${slug}/${each}.csv`, computed: false })),
});
const cloudflare = source("cloudflare", "cloudflare", "Cloudflare", ["ai-spend"]);
const stripe = source("stripe", "stripe", "Stripe", ["revenue"]);
const sheets = new Map<string, Sheet | null>([
  ["data/cloudflare/ai-spend.csv", { columns: [{ name: "usd", type: "number" }, { name: "service", type: "text" }, { name: "date", type: "date" }], rows: [] }],
  ["data/stripe/revenue.csv", { columns: [{ name: "usd", type: "number" }, { name: "plan", type: "text" }, { name: "time (ms)", type: "number" }], rows: [] }],
]);

describe("the note a draft saves", () => {
  const draft = { name: "Revenue per AI dollar", formula: "sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)", every: "month", format: "$0.00" };

  test("reads back as the same metric, with its plain reading and no value", () => {
    const text = metricNoteText(draft);
    const metric = metricOf({ path: "data/metrics/revenue-per-ai-dollar.md", properties: props(text) });
    expect(metric.name).toBe("Revenue per AI dollar");
    expect(metric.formula).toBe(draft.formula);
    expect(metric.every).toBe("month");
    expect(metric.format).toBe("$0.00");
    expect(metric.parsed.ok).toBe(true);
    const body = splitNote(text).body.trim();
    expect(body.length).toBeGreaterThan(10);
    expect(body).not.toMatch(/\$\d/);
  });

  test("a name or formula that would break the front matter stays one value, read the same by the app and the gateway", () => {
    const text = metricNoteText({ ...draft, name: 'Ratio: "a"\nevery: hour', formula: 'sum(stripe/revenue."time (ms)")' });
    const metric = metricOf({ path: "data/metrics/x.md", properties: props(text) });
    expect(metric.name).toBe('Ratio: "a" every: hour');
    expect(metric.every).toBe("month");
    expect(metric.parsed.ok).toBe(true);
    const fields = frontMatterFields(text) as Record<string, string>;
    expect(fields.metric).toBe(metric.name);
    expect(fields.formula).toBe(metric.formula);
    expect(fields.every).toBe("month");
  });

  test("text holding both kinds of quote is refused rather than written so the two readers differ", () => {
    expect(frontValue(`it's "this"`)).toBeNull();
    expect(draftProblem({ ...draft, name: `it's "this"` })).toMatch(/quote/);
    expect(frontValue("plain")).toBe('"plain"');
    expect(frontValue("back\\slash")).toBe("'back\\slash'");
  });

  test("the engine's plain number writes no format line", () => {
    expect(metricNoteText({ ...draft, format: "" })).not.toMatch(/^format:/m);
  });

  test("lands at its name as a slug, never on a note that is there", () => {
    expect(metricPathFor("data/metrics", "Revenue per AI dollar", new Set())).toBe("data/metrics/revenue-per-ai-dollar.md");
    expect(metricPathFor("data/metrics", "Revenue per AI dollar", new Set(["data/metrics/revenue-per-ai-dollar.md"]))).toBe("data/metrics/revenue-per-ai-dollar-2.md");
    expect(metricPathFor("data/metrics", "???", new Set())).toBe("data/metrics/new-metric.md");
  });

  test("can't be saved without a name, a formula, or with one that doesn't read", () => {
    expect(draftProblem({ ...draft, name: " " })).toBe("Give it a name.");
    expect(draftProblem({ ...draft, formula: "" })).toBe("Write its formula.");
    expect(draftProblem({ ...draft, formula: "sum(stripe/revenue.usd" })).toMatch(/\S/);
    expect(draftProblem(draft)).toBeNull();
  });
});

describe("the formula box's suggestions", () => {
  test("the word at the caret stops at a space, a bracket or an operator", () => {
    expect(wordAt("sum(clou", 8)).toEqual({ from: 4, word: "clou" });
    expect(wordAt("sum(a/b.c)-co", 13)).toEqual({ from: 11, word: "co" });
    expect(wordAt("sum(cloudflare/ai-spend.u) + 1", 25)).toEqual({ from: 4, word: "cloudflare/ai-spend.u" });
    expect(wordAt("", 5)).toEqual({ from: 0, word: "" });
  });

  test("after a dataset and a dot, that dataset's columns starting with what follows", () => {
    const found = columnSuggestions([stripe, cloudflare], sheets, "cloudflare/ai-spend.");
    expect(found.map((each) => each.column)).toEqual(["usd", "service", "date"]);
    expect(found[0]!.insert).toBe("cloudflare/ai-spend.usd");
    expect(columnSuggestions([stripe, cloudflare], sheets, "cloudflare/ai-spend.s").map((each) => each.column)).toEqual(["service"]);
  });

  test("otherwise every column whose source, dataset or name holds the word", () => {
    expect(columnSuggestions([stripe, cloudflare], sheets, "usd").map((each) => each.insert)).toEqual(["stripe/revenue.usd", "cloudflare/ai-spend.usd"]);
    expect(columnSuggestions([stripe, cloudflare], sheets, "spend").every((each) => each.dataset === "ai-spend")).toBe(true);
  });

  test("nothing for an empty word, a number, a function or a keyword", () => {
    for (const word of ["", "3", "sum", "where", "and", "count"]) expect(columnSuggestions([stripe, cloudflare], sheets, word)).toEqual([]);
  });

  test("a sheet the reader can't read offers nothing", () => {
    expect(columnSuggestions([stripe], new Map([["data/stripe/revenue.csv", null]]), "usd")).toEqual([]);
  });

  test("a column that isn't plain words is quoted, so the formula still reads", () => {
    const [found] = columnSuggestions([stripe], sheets, "time");
    expect(found!.insert).toBe('stripe/revenue."time (ms)"');
    expect(columnWords("lines added")).toBe("lines added");
    expect(columnWords('say "hi"')).toBe(`'say "hi"'`);
  });

  test("picking one replaces the word being typed and puts the caret after it", () => {
    const [usd] = columnSuggestions([cloudflare], sheets, "cloudflare/ai-spend.u");
    const next = insertSuggestion("sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.u)", 51, usd!);
    expect(next.formula).toBe("sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)");
    expect(next.caret).toBe(53);
  });
});

describe("the period and the preview's words", () => {
  test("a note's own period when the builder offers it, else month", () => {
    expect(builderPeriod("Week")).toBe("week");
    expect(builderPeriod("6 hours")).toBe("month");
  });

  test("say the period being read", () => {
    expect(previewWords("month", 6)).toEqual({ now: "this month, so far", span: "Last 6 months" });
    expect(previewWords("hour", 6).span).toBe("Last 6 hours");
  });
});
