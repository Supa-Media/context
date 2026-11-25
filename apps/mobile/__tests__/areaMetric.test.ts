/**
 * Stage C of data sources and metrics: an area picks ONE workspace metric by
 * name and sets its own target (`folderPage/areas/areaMetric.ts`), and a sheet
 * a source syncs opens read-only under a lock line (`data/syncedSheet.ts`).
 * See `docs/decisions/data-and-metrics.md`, "What stage C draws".
 *
 * The properties with teeth: an area's metric name finds a workspace metric
 * note in any case; a name that finds none falls back to the area's own
 * `metrics.csv` exactly as before; a metric over a sheet the reader cannot
 * read reads exactly as one over a missing sheet, drawn "Hidden", and the
 * reading never names the sheet; the target is written in symbols; Save
 * writes the seat's own `metrics:` line and clears a hand-written `metric:`
 * and `target:`, which otherwise win; and only GitHub, Cloudflare and Stripe
 * sheets are "kept up to date", never a push source's or Context's.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `workspaceMetricFor` comparing names without lower-casing: "an area's
 *    metric name finds the workspace metric in any case" fails.
 * 2. `workspaceReading` drawing a hidden input as "—" (status "none") rather
 *    than "Hidden": "a sheet the reader cannot read reads exactly as a missing
 *    one" and "the panel says where a reading comes from" fail.
 * 3. `keptBy`'s SYNCED set gaining "push": "a push source's sheet and the
 *    Context source's are not kept up to date" fails.
 * 4. `seatChanges` no longer clearing `metric` and `target`: "Save writes the
 *    seat's metrics line and removes a hand-written metric and target" fails.
 */

import { describe, expect, test } from "@jest/globals";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";
import { metricsIn, usesByMetric } from "../features/console/files/data/metrics";
import { sourcesIn } from "../features/console/files/data/sources";
import { keptBy, sourceFolderOfSheet } from "../features/console/files/data/syncedSheet";
import { sheetOfText } from "../features/console/files/data/useData";
import { rowsReader } from "../features/console/files/data/useDataWorkspace";
import { workOut, type Sheet } from "../features/console/files/data/workOut";
import {
  areaReading,
  metricOptions,
  pickedEdit,
  readingSource,
  splitTarget,
  targetHint,
  targetWords,
  workspaceMetricFor,
  type WorkspaceMetrics,
} from "../features/console/files/folderPage/areas/areaMetric";
import { headlineOf } from "../features/console/files/folderPage/areas/headline";
import { readingsOf } from "../features/console/files/folderPage/areas/readings";
import { metricsOf, seatChanges, seatOf } from "../features/console/files/folderPage/areas/seat";
import { shortTarget } from "../features/console/files/folderPage/areas/shortTarget";

const NOW = Date.parse("2026-11-24T11:00:00Z");

function entry(path: string, kind: "file" | "folder" = "file"): FileEntry {
  return { kind, path, name: path.slice(path.lastIndexOf("/") + 1), visibility: "team", inherited: "team", exception: false, readOnly: false };
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}
const note = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path, properties });

const LISTINGS: Record<string, FolderListing> = {
  data: listing("data", [entry("data/stripe", "folder"), entry("data/cloudflare", "folder"), entry("data/eval-ci", "folder"), entry("data/metrics", "folder")]),
  "data/stripe": listing("data/stripe", [entry("data/stripe/about.md"), entry("data/stripe/revenue.csv")]),
  "data/cloudflare": listing("data/cloudflare", [entry("data/cloudflare/about.md"), entry("data/cloudflare/ai-spend.csv")]),
  "data/eval-ci": listing("data/eval-ci", [entry("data/eval-ci/about.md"), entry("data/eval-ci/bench-runs.csv")]),
};

const DATA_NOTES: ListNote[] = [
  note("data/stripe/about.md", { source: "stripe" }),
  note("data/cloudflare/about.md", { source: "cloudflare" }),
  note("data/eval-ci/about.md", { source: "push", name: "Eval CI" }),
  note("data/metrics/revenue-per-ai-dollar.md", { metric: "Revenue per AI dollar", formula: "sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)", every: "month", format: "$0.00" }),
  note("data/metrics/error-rate.md", { metric: "Error rate", formula: "sum(eval-ci/bench-runs.errors) / sum(eval-ci/bench-runs.requests)", every: "day", format: "0.0%" }),
];

const SHEETS: Record<string, string> = {
  "data/stripe/revenue.csv": "date:date,plan,usd:number\n2026-10-12,Team,61\n2026-11-24,Team,94\n",
  "data/cloudflare/ai-spend.csv": "date:date,model,usd:number\n2026-10-12,claude,10\n2026-11-24T10:00:00Z,claude,10\n",
  "data/eval-ci/bench-runs.csv": "date:date,errors:number,requests:number\n2026-11-24,22,1000\n",
};

/** The workspace's metrics as the Areas page reads them, with `unreadable` sheets held back from this reader. */
function workspace(unreadable: readonly string[] = [], missing: readonly string[] = [], notes: ListNote[] = DATA_NOTES, areas: ListNote[] = []): WorkspaceMetrics {
  const sources = sourcesIn("data", (path) => LISTINGS[path], notes);
  const sheets = new Map<string, Sheet | null>();
  for (const [path, text] of Object.entries(SHEETS)) {
    // A sheet held back and one not there are one answer to the reader: null.
    sheets.set(path, unreadable.includes(path) || missing.includes(path) ? null : sheetOfText(text));
  }
  const metrics = metricsIn("data/metrics", notes);
  const rowsOf = rowsReader(sources, sheets);
  const worked = new Map(metrics.map((metric) => [metric.path, workOut(metric, rowsOf, NOW)]));
  return { metrics, worked, sources, sheets, uses: usesByMetric("areas", areas), settled: true, known: true, now: NOW };
}

describe("an area's metric is a workspace metric by name", () => {
  test("an area's metric name finds the workspace metric in any case", () => {
    const ws = workspace();
    expect(workspaceMetricFor("revenue PER ai DOLLAR ", ws.metrics)?.path).toBe("data/metrics/revenue-per-ai-dollar.md");
    expect(workspaceMetricFor("Monthly cost", ws.metrics)).toBeNull();
    // A seat line cannot hold a comma, so a metric named with one is still found after Save drops it.
    const comma = workspace([], [], [...DATA_NOTES, note("data/metrics/net.md", { metric: "Revenue, net", formula: "sum(stripe/revenue.usd)" })]);
    const line = new Map(seatChanges(pickedEdit(seatOf("areas/finance", "areas", []), "Revenue, net", "over", "5"))).get("metrics") as string[];
    expect(line).toEqual(["Revenue net · target over 5"]);
    expect(workspaceMetricFor(metricsOf({ metrics: line })[0]!.name, comma.metrics)?.path).toBe("data/metrics/net.md");
    expect(workspaceMetricFor("", ws.metrics)).toBeNull();
  });

  test("its reading is the metric worked out over the reader's sheets, with its sources and when the newest row is from", () => {
    const reading = areaReading({ name: "Revenue per AI dollar", target: "over $5" }, workspace(), undefined)!;
    expect(reading.from).toBe("workspace");
    expect(reading.value).toBe("$9.40");
    expect(reading.state).toBe("met");
    expect(reading.inputs).toBe("Stripe + Cloudflare");
    expect(reading.when).toBe("last row 1h ago");
    expect(reading.series).toEqual([6.1, 9.4]);
    expect(areaReading({ name: "Revenue per AI dollar", target: "over $10" }, workspace(), undefined)!.state).toBe("missed");
  });

  test("a name no metric note has falls back to the area's own metrics.csv, exactly as before", () => {
    const csv = readingsOf("date:date,metric,value\n2026-11-02,Monthly cost,$540\n2026-11-23,Monthly cost,$512");
    const reading = areaReading({ name: "Monthly cost", target: "under $600" }, workspace(), csv)!;
    expect(reading.from).toBe("sheet");
    expect(reading.value).toBe("$512");
    expect(reading.series).toEqual([540, 512]);
    expect(reading.state).toBe("met");
    expect(reading.inputs).toBe("");
    // No workspace at all (a page without the file browser's listings) reads the sheet too.
    expect(areaReading({ name: "Monthly cost", target: null }, null, csv)!.value).toBe("$512");
    // And a name in neither has no reading: the row shows only the name and target.
    expect(areaReading({ name: "Nothing", target: null }, workspace(), csv)).toBeUndefined();
  });

  test("a workspace metric wins over a metrics.csv row of the same name", () => {
    const csv = readingsOf("date:date,metric,value\n2026-11-23,Revenue per AI dollar,$1");
    expect(areaReading({ name: "Revenue per AI dollar", target: null }, workspace(), csv)!.value).toBe("$9.40");
  });

  test("a sheet the reader cannot read reads exactly as a missing one: Hidden, and the sheet is never named", () => {
    const metric = { name: "Revenue per AI dollar", target: "over $5" };
    const held = areaReading(metric, workspace(["data/cloudflare/ai-spend.csv"]), undefined)!;
    const gone = areaReading(metric, workspace([], ["data/cloudflare/ai-spend.csv"]), undefined)!;
    expect(held).toEqual(gone);
    expect(held.status).toBe("hidden");
    expect(held.value).toBe("Hidden");
    expect(held.state).toBe("unknown");
    expect(held.series).toEqual([]);
    expect(JSON.stringify(held)).not.toContain("ai-spend");
    const line = headlineOf(seatOf("areas/finance", "areas", [note("areas/finance/about.md", { metrics: ["Revenue per AI dollar · target over $5"] })]), held)!;
    expect(line.value).toBe("Hidden");
    expect(line.trend).toBeNull();
    expect(JSON.stringify(line)).not.toContain("ai-spend");
  });

  test("a reader who cannot read the metric note gets the area's metrics.csv, or nothing", () => {
    const ws = workspace([], [], DATA_NOTES.filter((each) => !each.path.endsWith("revenue-per-ai-dollar.md")));
    expect(areaReading({ name: "Revenue per AI dollar", target: "over $5" }, ws, undefined)).toBeUndefined();
  });

  test("two metric notes of one name: the first in the folder's order is read, and the second cannot be picked", () => {
    const twin = note("data/metrics/zz-revenue.md", { metric: "revenue per AI dollar", formula: "sum(stripe/revenue.usd)", every: "month" });
    const ws = workspace([], [], [...DATA_NOTES, twin]);
    expect(workspaceMetricFor("Revenue per AI dollar", ws.metrics)?.path).toBe("data/metrics/revenue-per-ai-dollar.md");
    const options = metricOptions(ws);
    expect(options.find((each) => each.path === twin.path)?.duplicate).toBe(true);
    expect(options.find((each) => each.path === "data/metrics/revenue-per-ai-dollar.md")?.duplicate).toBe(false);
  });

  test("the picker's rows say the sources and who uses each, and its value as worked out", () => {
    const areas = [note("areas/finance/about.md", { metrics: ["Revenue per AI dollar · target over $5"] })];
    const options = metricOptions(workspace([], [], DATA_NOTES, areas));
    const revenue = options.find((each) => each.name === "Revenue per AI dollar")!;
    expect(revenue.line).toBe("Stripe + Cloudflare · used by Finance");
    expect(revenue.shown).toBe("$9.40");
    expect(options.find((each) => each.name === "Error rate")!.line).toBe("Eval CI");
  });

  test("the panel says where a reading comes from", () => {
    const metric = { name: "Revenue per AI dollar", target: null };
    expect(readingSource(metric, areaReading(metric, workspace(), undefined))).toBe("Worked out as you read it from the workspace metric Revenue per AI dollar over Stripe + Cloudflare.");
    expect(readingSource({ name: "Monthly cost", target: null }, undefined)).toContain("metrics.csv");
    expect(readingSource(metric, areaReading(metric, workspace(["data/stripe/revenue.csv"]), undefined))).toContain("Hidden");
  });
});

describe("the target", () => {
  test.each([
    ["over $5", "> $5"],
    ["under 30 min", "< 30 min"],
    ["at least 10", "≥ 10"],
    ["at most 2 days", "≤ 2 days"],
    ["above 3", "> 3"],
    ["below 1%", "< 1%"],
    ["7", "7"],
  ])("%s is written %s", (target, short) => {
    expect(shortTarget(target)).toBe(short);
  });

  test("the picker splits a target into Over or Under and its value, and writes it back", () => {
    expect(splitTarget("over $5")).toEqual({ mode: "over", value: "$5" });
    expect(splitTarget("under 30 min")).toEqual({ mode: "under", value: "30 min" });
    expect(splitTarget("at most 2")).toEqual({ mode: "under", value: "2" });
    expect(splitTarget(null)).toEqual({ mode: "over", value: "" });
    expect(targetWords("under", " 30 min ")).toBe("under 30 min");
    expect(targetWords("over", "over 5")).toBe("over 5");
    expect(targetWords("over", "  ")).toBeNull();
    expect(targetHint("over", "$5")).toBe("Green when the latest value is over $5.");
    expect(targetHint("under", "")).toBe("With no target, the value is drawn without a colour.");
  });
});

describe("the seat line Save writes", () => {
  const about = note("areas/finance/about.md", { owner: "@dev", metrics: ["Monthly cost, target under $600"], approvals: ["Spending over $20"] });

  test("Save writes the seat's metrics line and removes a hand-written metric and target", () => {
    const seat = seatOf("areas/finance", "areas", [about]);
    const changes = new Map(seatChanges(pickedEdit(seat, "Revenue per AI dollar", "over", "$5")));
    expect(changes.get("metrics")).toEqual(["Revenue per AI dollar · target over $5"]);
    expect(changes.get("metric")).toBeNull();
    expect(changes.get("target")).toBeNull();
    // The rest of the seat is written as it was.
    expect(changes.get("owner")).toBe("@dev");
    expect(changes.get("approvals")).toEqual(["Spending over $20"]);
    // A thousands comma cannot sit in an inline list item, so it is dropped.
    expect(new Map(seatChanges(pickedEdit(seat, "Revenue", "under", "$1,000"))).get("metrics")).toEqual(["Revenue · target under $1000"]);
    // No value, no target.
    expect(new Map(seatChanges(pickedEdit(seat, "Revenue", "under", ""))).get("metrics")).toEqual(["Revenue"]);
  });

  test("a metric and target line, as the design review sketches it, wins over metrics", () => {
    expect(metricsOf({ metric: "Revenue per AI dollar", target: "over 5", metrics: ["Monthly cost · target under $600"] })).toEqual([
      { name: "Revenue per AI dollar", target: "over 5" },
      { name: "Monthly cost", target: "under $600" },
    ]);
    expect(metricsOf({ metric: "Revenue per AI dollar, target over $5" })).toEqual([{ name: "Revenue per AI dollar", target: "over $5" }]);
    expect(metricsOf({ metric: "Revenue", metrics: ["revenue · target over 1"] })).toEqual([{ name: "Revenue", target: null }]);
    // usesByMetric reads the same lines.
    const uses = usesByMetric("areas", [note("areas/finance/about.md", { metric: "Revenue per AI dollar", target: "over 5" })]);
    expect(uses.get("revenue per ai dollar")).toEqual([{ area: "Finance", folder: "areas/finance", target: "over 5" }]);
    // And a deeper folder that says only `metric:` is a seat.
    const deep = seatOf("areas/finance/ops", "areas", [note("areas/finance/ops/about.md", { metric: "Error rate", target: "under 1%" })]);
    expect(deep.metrics).toEqual([{ name: "Error rate", target: "under 1%" }]);
  });
});

describe("a sheet a source keeps up to date", () => {
  const notes = [
    note("data/github/about.md", { source: "github" }),
    note("data/cloudflare/about.md", { source: "cloudflare" }),
    note("data/stripe/about.md", { source: "stripe", name: "Payments" }),
    note("data/eval-ci/about.md", { source: "push", name: "Eval CI" }),
    note("data/context/about.md", { source: "context" }),
  ];

  test("GitHub, Cloudflare and Stripe sheets are kept up to date, named as their source is", () => {
    expect(keptBy("data/github/pull-requests.csv", "data", notes)).toEqual({ name: "GitHub", folder: "data/github" });
    expect(keptBy("data/cloudflare/ai-spend.csv", "data", notes)).toEqual({ name: "Cloudflare", folder: "data/cloudflare" });
    expect(keptBy("data/stripe/revenue.csv", "data", notes)).toEqual({ name: "Payments", folder: "data/stripe" });
  });

  test("a push source's sheet and the Context source's are not kept up to date", () => {
    expect(keptBy("data/eval-ci/bench-runs.csv", "data", notes)).toBeNull();
    expect(keptBy("data/context/notes-by-status.csv", "data", notes)).toBeNull();
  });

  test("only a CSV directly in a source folder of the data folder is a source's", () => {
    expect(sourceFolderOfSheet("data/github/pull-requests.csv", "data")).toBe("data/github");
    expect(sourceFolderOfSheet("data/github/old/pull-requests.csv", "data")).toBeNull();
    expect(sourceFolderOfSheet("data/metrics/readings.csv", "data")).toBeNull();
    expect(sourceFolderOfSheet("data/github/about.md", "data")).toBeNull();
    expect(sourceFolderOfSheet("areas/github/pull-requests.csv", "data")).toBeNull();
    expect(sourceFolderOfSheet("data/github/pull-requests.csv", "")).toBeNull();
    // A source whose about.md this reader cannot read is no source to them: no lock line, nothing named.
    expect(keptBy("data/github/pull-requests.csv", "data", [])).toBeNull();
  });
});
