/**
 * Right-now metrics in the app (`features/console/files/data/`): a metric whose sheets have no dates is drawn as
 * its value right now, its past periods from the sheet the sync keeps beside its note, and Keep every hour asks the
 * gateway with the metric's note (`apps/mcp/src/data/sync/snap.js`).
 *
 * SABOTAGE (confirmed, reverted): pass no `kept` sheet from `workOut` to the engine → "past periods are the kept
 * readings" fails; send the metric's path as `about` in `callDataSync` → "Keep every hour names the metric" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { parseSheet } from "../../mcp/src/sheets/csv.js";
import { KEPT_HOUR, KEPT_VALUE } from "../../mcp/src/data/formula/index.js";
import { callDataSync } from "../features/console/files/data/dataSync";
import { metricOf } from "../features/console/files/data/metrics";
import { KEPT_HEADER, keptSheetPath } from "../features/console/files/data/useMetricKeep";
import { workOut, type Sheet } from "../features/console/files/data/workOut";

const NOW = Date.parse("2026-11-25T12:30:00Z");
const INCIDENTS = parseSheet("id,open:checkbox\nINC-1,true\nINC-2,true\nINC-3,false\n") as unknown as Sheet;
const rowsOf = (source: string, dataset: string) => (`${source}/${dataset}` === "ops/incidents" ? INCIDENTS : null);
const metric = metricOf({ path: "data/metrics/open-incidents.md", properties: { metric: "Open incidents", formula: "count(ops/incidents.id where open = true)", every: "day" } });

describe("a right-now metric", () => {
  test("its kept sheet sits beside its note, with the two columns the sync writes", () => {
    expect(keptSheetPath("data/metrics/open-incidents.md")).toBe("data/metrics/open-incidents.csv");
    const header = parseSheet(KEPT_HEADER) as unknown as Sheet;
    expect(header.columns.map((c) => [c.name, c.type])).toEqual([
      [KEPT_HOUR, "date"],
      [KEPT_VALUE, "number"],
    ]);
  });

  test("is its value right now, and its past periods are the kept readings", () => {
    const kept = parseSheet(`${KEPT_HEADER}2026-11-23T10:00Z,4\n2026-11-24T22:00Z,6\n`) as unknown as Sheet;
    const worked = workOut(metric, rowsOf, NOW, 3, kept);
    expect(worked.now).toBe(true);
    expect(worked.latest).toEqual({ value: 2, status: "ok" });
    expect(worked.periods.map((p) => [p.from.slice(0, 10), p.value])).toEqual([
      ["2026-11-23", 4],
      ["2026-11-24", 6],
      ["2026-11-25", 2],
    ]);
    // Nothing kept yet: only now has a value.
    expect(workOut(metric, rowsOf, NOW, 3).periods.map((p) => p.status)).toEqual(["no_data", "no_data", "ok"]);
  });

  test("a metric over sheets with dates is not a right-now one", () => {
    const dated = parseSheet("at:date,n:number\n2026-11-25,3\n") as unknown as Sheet;
    const worked = workOut(metricOf({ path: "data/metrics/n.md", properties: { formula: "sum(a/b.n)", every: "day" } }), () => dated, NOW, 2);
    expect(worked.now).toBe(false);
    expect(worked.latest).toEqual({ value: 3, status: "ok" });
  });

  test("Keep every hour names the metric, and its answer is read by the metric's note", async () => {
    const sent: unknown[] = [];
    const answer = await callDataSync({
      url: "https://gateway.test/@acme/files/data-sync",
      workspaceId: "ws1",
      body: { op: "arm", metric: "data/metrics/open-incidents.md" },
      token: async () => "t",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ metric: "data/metrics/open-incidents.md", armed: true, last: { at: NOW, outcome: "ok", rows: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(sent).toEqual([{ workspaceId: "ws1", op: "arm", metric: "data/metrics/open-incidents.md" }]);
    expect(answer).toEqual({ ok: true, sources: [{ about: "data/metrics/open-incidents.md", armed: true, last: { at: NOW, outcome: "ok", rows: 1 } }] });
  });
});
