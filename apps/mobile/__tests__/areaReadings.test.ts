/**
 * A seat's readings come from its area's `metrics.csv` (the owner,
 * 2026-11-23): the latest row per metric, as written, with the series for the
 * box's sparkline.
 */
import { describe, expect, test } from "@jest/globals";
import { leadingNumber, meetsTarget, readingFor, readingsOf } from "../features/console/files/folderPage/areas/readings";

const SHEET = [
  "date:date,metric,value,source,by",
  "2026-11-02,Monthly cost,$540,csv,@seyi",
  "2026-11-23,Monthly cost,$512,csv,@seyi",
  "2026-11-09,Monthly cost,\"$1,020\",csv,@seyi",
  "2026-11-23,PR time to ship,2.4 days,webhook,github",
  "2026-11-23,,ignored,csv,@seyi",
].join("\n");

describe("metric readings from metrics.csv", () => {
  test("the latest row per metric wins, matched by name in any case, with its series in date order", () => {
    const readings = readingsOf(SHEET);
    const cost = readingFor(readings, { name: "monthly COST", target: "under $600" });
    expect(cost).toEqual({ value: "$512", date: "2026-11-23", series: [540, 1020, 512] });
    expect(readingFor(readings, { name: "PR time to ship", target: null })?.value).toBe("2.4 days");
    expect(readings.size).toBe(2);
  });

  test("a sheet without metric and value columns has no readings", () => {
    expect(readingsOf("name,notes\nx,y").size).toBe(0);
    expect(readingsOf("").size).toBe(0);
  });

  test("of two rows on one date, the later row is the newer reading", () => {
    const readings = readingsOf("date,metric,value\n2026-11-23,Score,6/10\n2026-11-23,Score,7/10");
    expect(readingFor(readings, { name: "Score", target: null })?.value).toBe("7/10");
  });

  test("the leading number of a value as written", () => {
    expect(leadingNumber("$1,200")).toBe(1200);
    expect(leadingNumber("2.4 days")).toBe(2.4);
    expect(leadingNumber("7/10")).toBe(7);
    expect(leadingNumber("none")).toBeNull();
  });

  test("a target that says which way is good is met or missed", () => {
    const at = (value: string) => ({ value, date: "", series: [] });
    expect(meetsTarget(at("$512"), "under $600")).toBe(true);
    expect(meetsTarget(at("$640"), "under $600")).toBe(false);
    expect(meetsTarget(at("8/10"), "at least 7")).toBe(true);
    expect(meetsTarget(at("2.4 days"), "2 days")).toBeNull();
  });
});
