/**
 * The Data page's model (`features/console/files/data/`): sources and their
 * datasets from the listings, metric notes and the areas that use them, the
 * formula drawn as chips, a metric worked out on read, and the built-in
 * Context source counted from notes.
 *
 * SABOTAGE (hidden == missing): make `classify` in `data/workOut.ts` keep the
 * engine's note on a "can't read" error, or draw a hidden input as "—" while a
 * missing one is "Hidden" → "a sheet the reader cannot read reads exactly as a
 * missing one" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { parseSheet } from "../../mcp/src/sheets/csv.js";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";
import { cardColumns, dataPageKind, sourceAt, sourcesIn, sourceKindOf } from "../features/console/files/data/sources";
import { isMetricNotePath, metricsIn, usedByWords, usesByMetric } from "../features/console/files/data/metrics";
import { formulaParts, HIDDEN, inputsOf, stateOf, targetOnScale, trendOf, workOut, type RowsOf, type Sheet } from "../features/console/files/data/workOut";
import { contextSheets, countedFolders } from "../features/console/files/data/contextSource";
import { ago, lastRowAt, lastRowWords, rowsWords, settingsOf, sourceStatus } from "../features/console/files/data/words";

const NOW = Date.parse("2026-11-25T11:00:00Z");

function entry(path: string, kind: "file" | "folder" = "file"): FileEntry {
  return { kind, path, name: path.slice(path.lastIndexOf("/") + 1), visibility: "team", inherited: "team", exception: false, readOnly: false };
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}
const note = (path: string, properties: ListNote["properties"] = {}, heading?: string): ListNote => ({ path, properties, ...(heading === undefined ? {} : { heading }) });

const LISTINGS: Record<string, FolderListing> = {
  data: listing("data", [entry("data/github", "folder"), entry("data/eval-ci", "folder"), entry("data/context", "folder"), entry("data/metrics", "folder")]),
  "data/github": listing("data/github", [entry("data/github/about.md"), entry("data/github/pull-requests.csv"), entry("data/github/deploys.csv")]),
  "data/eval-ci": listing("data/eval-ci", [entry("data/eval-ci/about.md"), entry("data/eval-ci/bench-runs.csv")]),
  "data/context": listing("data/context", [entry("data/context/about.md")]),
};
const listingOf = (path: string) => LISTINGS[path];

const NOTES: ListNote[] = [
  note("data/github/about.md", { source: "github", repositories: ["supa/app", "supa/context"], every: "hour" }),
  note("data/eval-ci/about.md", { source: "push", name: "Eval CI" }),
  note("data/context/about.md", { source: "context", "notes-by-status": ["projects/"], "time-to-answered": ["inbox/questions/"] }),
  note("data/metrics/open-to-live.md", { metric: "Open to live", formula: "median(github/pull-requests.deployed - opened)", every: "7 days", format: "duration" }),
  note("data/metrics/error-rate.md", { metric: "Error rate", formula: "sum(eval-ci/bench-runs.errors) / sum(requests)", every: "day", format: "0.0%" }),
  note("data/metrics/broken.md", { metric: "Broken", formula: "sum(github/pull-requests.lines" }),
];

describe("sources", () => {
  test("each subfolder but metrics/ is a source, named by its about.md or its app", () => {
    const sources = sourcesIn("data", listingOf, NOTES);
    expect(sources.map((s) => [s.slug, s.kind, s.name])).toEqual([
      ["github", "github", "GitHub"],
      ["eval-ci", "push", "Eval CI"],
      ["context", "context", "Context"],
    ]);
    expect(sources[0]!.datasets.map((d) => d.name)).toEqual(["pull-requests", "deploys"]);
    // The Context source's datasets are worked out on read, never sheets in the folder.
    expect(sources[2]!.datasets.map((d) => [d.name, d.computed])).toEqual([
      ["notes-by-status", true],
      ["time-to-answered", true],
    ]);
  });

  test("which page a folder under the data folder is", () => {
    expect(dataPageKind("data", "data")).toBe("data");
    expect(dataPageKind("data/metrics", "data")).toBe("metrics");
    expect(dataPageKind("data/github", "data")).toBe("source");
    expect(dataPageKind("data/github/old", "data")).toBeNull();
    expect(dataPageKind("database", "data")).toBeNull();
    expect(dataPageKind("ops/data/github", "ops/data")).toBe("source");
  });

  test("an unknown source word is other, never a guess", () => {
    expect(sourceKindOf("GitHub")).toBe("github");
    expect(sourceKindOf("salesforce")).toBe("other");
    expect(sourceKindOf(undefined)).toBe("other");
  });

  test("cards go under the shorter column, as the board's masonry lays them", () => {
    const card = (name: string, n: number) => ({ name, datasets: Array.from({ length: n }) });
    const [left, right] = cardColumns([card("GitHub", 3), card("Cloudflare", 1), card("Stripe", 1), card("Context", 2), card("Eval CI", 1)]);
    expect(left.map((c) => c.name)).toEqual(["GitHub", "Context"]);
    expect(right.map((c) => c.name)).toEqual(["Cloudflare", "Stripe", "Eval CI"]);
  });

  test("settings: about.md's lines in order, lists as chips, and where a sign-in is kept", () => {
    const github = sourceAt("data/github", listingOf, NOTES);
    expect(settingsOf(github)).toEqual([
      { key: "source", values: ["GitHub"], code: false },
      { key: "repositories", values: ["supa/app", "supa/context"], code: true },
      { key: "every", values: ["hour"], code: false },
      { key: "sign-in", values: ["Kept in the workspace vault, never in this file"], code: false, signIn: true },
    ]);
    // A push source keeps no sign-in, so it says none.
    expect(settingsOf(sourceAt("data/eval-ci", listingOf, NOTES)).some((s) => s.key === "sign-in")).toBe(false);
  });
});

describe("metrics", () => {
  test("one per note directly in metrics/, in the listing's order", () => {
    const metrics = metricsIn("data/metrics", [...NOTES, note("data/metrics/old/x.md", { metric: "X" })], ["data/metrics/error-rate.md"]);
    expect(metrics.map((m) => m.slug)).toEqual(["error-rate", "broken", "open-to-live"]);
    expect(metrics[0]!.every).toBe("day");
    expect(metrics[1]!.parsed.ok).toBe(false);
  });

  test("a metric note's path", () => {
    expect(isMetricNotePath("data/metrics/error-rate.md", "data")).toBe(true);
    expect(isMetricNotePath("data/metrics/readings.csv", "data")).toBe(false);
    expect(isMetricNotePath("data/metrics/about.md", "data")).toBe(false);
    expect(isMetricNotePath("data/github/about.md", "data")).toBe(false);
  });

  test("used by: the areas whose about.md names it, with each one's target", () => {
    const uses = usesByMetric("areas", [
      note("areas/about.md", { metric: "Error rate" }),
      note("areas/velocity/about.md", { metric: "Open to live, target under 30 min" }),
      note("areas/mcp/about.md", { metrics: ["Error rate · target under 1%"] }),
      note("areas/people/dev.md", { metric: "Error rate" }),
    ]);
    expect(uses.get("open to live")).toEqual([{ area: "Velocity", folder: "areas/velocity", target: "under 30 min" }]);
    expect(usedByWords(uses.get("error rate"))).toBe("Mcp");
    expect(usedByWords(uses.get("lines changed"))).toBeNull();
  });
});

const BENCH = parseSheet(
  "date:date,suite,errors:number,requests:number\n2026-11-24,search,3,100\n2026-11-25,search,2,100\n2026-11-25,mcp,1,100\n",
) as unknown as Sheet;

describe("working a metric out on read", () => {
  const [, errorRate] = metricsIn("data/metrics", NOTES).filter((m) => m.slug !== "broken");
  const metric = errorRate!.slug === "error-rate" ? errorRate! : metricsIn("data/metrics", NOTES).find((m) => m.slug === "error-rate")!;

  test("the latest period, its trend and how it stands against the area's target", () => {
    const rowsOf: RowsOf = (source, dataset) => (source === "eval-ci" && dataset === "bench-runs" ? BENCH : null);
    const worked = workOut(metric, rowsOf, NOW);
    expect(worked.shown).toBe("1.5%");
    expect(trendOf(worked)).toEqual([0.03, 0.015]);
    expect(stateOf(worked, "under 1%")).toBe("missed");
    expect(stateOf(worked, "under 2%")).toBe("met");
    expect(stateOf(worked, null)).toBe("unknown");
    // The target drawn on the trend's own scale: 1% against values of 0.015.
    expect(targetOnScale(worked, "under 1%")).toBeCloseTo(0.01, 6);
  });

  test("a sheet the reader cannot read reads exactly as a missing one", () => {
    const hidden: RowsOf = () => null; // the sheet exists, held back from this reader
    const missing: RowsOf = (source) => (source === "nowhere" ? BENCH : null); // it was never made
    const a = workOut(metric, hidden, NOW);
    const b = workOut(metric, missing, NOW);
    expect(a).toEqual(b);
    expect(a.shown).toBe(HIDDEN);
    expect(a.latest).toEqual({ value: null, status: "hidden" });
    // Nothing in the answer names the sheet, so it cannot tell anyone the sheet is there.
    expect(JSON.stringify(a)).not.toContain("bench-runs");
  });

  test("a formula that does not parse says the parser's own words", () => {
    const broken = metricsIn("data/metrics", NOTES).find((m) => m.slug === "broken")!;
    const worked = workOut(broken, () => BENCH, NOW);
    expect(worked.shown).toBe("—");
    expect(worked.latest.status).toBe("error");
    expect(worked.latest.note).toMatch(/\)/);
  });

  test("no rows in the period is no data, not zero", () => {
    const empty = parseSheet("date:date,suite,errors:number,requests:number\n") as unknown as Sheet;
    const worked = workOut(metric, () => empty, NOW);
    expect(worked.latest.status).toBe("no_data");
    expect(worked.shown).toBe("—");
  });
});

describe("formula chips", () => {
  const kindOf = (source: string) => sourceKindOf(source === "eval-ci" ? "push" : source);
  test("function word, one chip per aggregate, the dataset left off when it repeats", () => {
    const [metric] = metricsIn("data/metrics", NOTES).filter((m) => m.slug === "error-rate");
    if (!metric!.parsed.ok) throw new Error("parses");
    expect(formulaParts(metric!.parsed.ast, kindOf)).toEqual([
      { t: "fn", text: "sum" },
      { t: "chip", kind: "push", source: "eval-ci", dataset: "bench-runs", column: "errors" },
      { t: "op", text: "÷" },
      { t: "fn", text: "sum" },
      { t: "chip", kind: "push", source: "eval-ci", dataset: null, column: "requests" },
    ]);
    expect(inputsOf(metric!.parsed.ast)).toEqual([{ source: "eval-ci", dataset: "bench-runs" }]);
  });

  test("a per-row sum is one chip, and a where is a chip of its own", () => {
    const [metric] = metricsIn("data/metrics", [note("data/metrics/x.md", { formula: "median(github/pull-requests.deployed - opened where repo = app)" })]);
    if (!metric!.parsed.ok) throw new Error("parses");
    expect(formulaParts(metric!.parsed.ast, kindOf)).toEqual([
      { t: "fn", text: "median" },
      { t: "chip", kind: "github", source: "github", dataset: "pull-requests", column: "deployed − opened" },
      { t: "filter", text: "where repo = app" },
    ]);
  });

  test("brackets only where the reading needs them", () => {
    const [metric] = metricsIn("data/metrics", [note("data/metrics/x.md", { formula: "(sum(a/b.c) + sum(a/d.e)) / 2" })]);
    if (!metric!.parsed.ok) throw new Error("parses");
    expect(formulaParts(metric!.parsed.ast, () => "other").map((p) => ("text" in p ? p.text : p.column))).toEqual(["(", "sum", "c", "+", "sum", "e", ")", "÷", "2"]);
  });
});

describe("the Context source, counted on read", () => {
  const notes: ListNote[] = [
    note("projects/about.md", { statuses: "active, done" }),
    note("projects/launch/about.md", { status: "active" }),
    note("projects/site.md", { status: "done" }),
    note("projects/old.md", { status: "done" }),
    note("projects/plain.md"),
    note("inbox/questions/a.md", { asked: "2026-11-24T09:00:00Z", answered: "2026-11-24T09:45:00Z" }),
    note("inbox/questions/b.md", { asked: "2026-11-24T09:00:00Z" }),
    note("elsewhere/c.md", { status: "done" }),
  ];
  const counted = countedFolders(sourceAt("data/context", listingOf, NOTES));

  test("which folders it counts, from about.md, without their trailing slash", () => {
    expect(counted).toEqual({ byStatus: ["projects"], answered: ["inbox/questions"] });
  });

  test("notes by status: today's counts under each folder, nothing outside it", () => {
    const sheets = contextSheets(counted, notes, NOW);
    expect(sheets.get("notes-by-status")!.rows).toEqual([
      { date: "2026-11-25", folder: "projects", status: "active", notes: "1" },
      { date: "2026-11-25", folder: "projects", status: "done", notes: "2" },
    ]);
  });

  test("a note two folder reads both carry is counted once", () => {
    const twice = contextSheets(counted, [...notes, ...notes], NOW);
    expect(twice.get("notes-by-status")!.rows).toEqual(contextSheets(counted, notes, NOW).get("notes-by-status")!.rows);
    expect(twice.get("time-to-answered")!.rows).toHaveLength(1);
  });

  test("time to answered: minutes from asked to answered, only where both are written", () => {
    const sheets = contextSheets(counted, notes, NOW);
    expect(sheets.get("time-to-answered")!.rows).toEqual([
      { date: "2026-11-24", folder: "inbox/questions", asked: "2026-11-24T09:00:00Z", answered: "2026-11-24T09:45:00Z", minutes: "45" },
    ]);
  });
});

describe("words", () => {
  test("times, counts and the last row", () => {
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(ago(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(ago(NOW - 10 * 86_400_000, NOW)).toBe("Nov 15");
    expect(rowsWords(1284)).toBe("1,284 rows");
    expect(rowsWords(1)).toBe("1 row");
    expect(lastRowAt(BENCH)).toBe(Date.parse("2026-11-25"));
    expect(lastRowWords(Date.parse("2026-11-25T10:00:00Z"), NOW)).toBe("Last row 10:00");
    expect(lastRowWords(Date.parse("2026-11-23"), NOW)).toBe("Last row Nov 23");
  });

  test("a source's line: built in, a sync's last run, or its last row", () => {
    const sources = sourcesIn("data", listingOf, NOTES);
    const sheets = new Map<string, Sheet | null>([["data/eval-ci/bench-runs.csv", BENCH]]);
    expect(sourceStatus(sources[2]!, sheets, NOW).text).toBe("Built in · live");
    expect(sourceStatus(sources[0]!, sheets, NOW, { syncedAt: NOW - 5 * 60_000 })).toEqual({ tone: "ok", text: "Synced 5 min ago", short: "5 min ago" });
    expect(sourceStatus(sources[0]!, sheets, NOW, { syncedAt: NOW - 3_600_000, failedAt: NOW - 25 * 60_000 }).text).toBe("Sync failed 25 min ago");
    // No sync has run yet (stage B has none): said plainly, never "Synced".
    expect(sourceStatus(sources[0]!, sheets, NOW)).toEqual({ tone: "quiet", text: "Not synced yet", short: "not synced yet" });
    expect(sourceStatus(sources[1]!, sheets, NOW).text).toBe("Last row 11h ago");
  });
});
