/**
 * The device's pairing of a search with its first open and with the next search (`searchOpenReport.ts`).
 *
 * Pure: no React, so it runs in plain node. The palette's wiring is in `paletteRender/searchOpen.test.ts`.
 */

import { describe, expect, test } from "@jest/globals";
import { AGAIN_WINDOW_MS, createSearchOpenReporter } from "../features/console/files/searchOpenReport";

function recorder() {
  const opened: [string, number][] = [];
  const again: string[] = [];
  const refined: string[] = [];
  const reporter = createSearchOpenReporter({
    reportOpen: (row, position) => {
      opened.push([row, position]);
    },
    reportAgain: (row, wasRefined) => {
      (wasRefined ? refined : again).push(row);
    },
  });
  return { opened, again, refined, reporter };
}

const T0 = 1_000_000;

describe("createSearchOpenReporter: opens", () => {
  test("the first open after an answered search reports its row and position", () => {
    const { opened, reporter } = recorder();
    const answered = reporter.searchStarted(T0);
    answered("row-a");
    reporter.opened(2);
    expect(opened).toEqual([["row-a", 2]]);
  });

  test("a second open of the same search reports nothing", () => {
    const { opened, reporter } = recorder();
    reporter.searchStarted(T0)("row-a");
    reporter.opened(2);
    reporter.opened(3);
    expect(opened).toEqual([["row-a", 2]]);
  });

  test("a tap that lands before the row id arrives is sent with it", () => {
    const { opened, reporter } = recorder();
    const answered = reporter.searchStarted(T0);
    reporter.opened(4);
    expect(opened).toEqual([]);
    answered("row-a");
    expect(opened).toEqual([["row-a", 4]]);
  });

  test("a search whose row was not recorded (a refusal) reports no open", () => {
    const { opened, reporter } = recorder();
    reporter.searchStarted(T0)(null);
    reporter.opened(1);
    expect(opened).toEqual([]);
  });

  test("an open reports against the latest search only", () => {
    const { opened, reporter } = recorder();
    reporter.searchStarted(T0)("row-a");
    reporter.searchStarted(T0 + 120_000)("row-b");
    reporter.opened(1);
    expect(opened).toEqual([["row-b", 1]]);
  });

  test("a late row id for an earlier search does not take the later search's open", () => {
    const { opened, reporter } = recorder();
    const earlier = reporter.searchStarted(T0);
    reporter.searchStarted(T0 + 120_000);
    earlier("row-a");
    reporter.opened(1);
    expect(opened).toEqual([]);
  });
});

describe("createSearchOpenReporter: re-searches", () => {
  test("a search started within 60 s of an unopened answered one re-searches that row", () => {
    const { again, reporter } = recorder();
    reporter.searchStarted(T0)("row-a");
    reporter.searchStarted(T0 + AGAIN_WINDOW_MS);
    expect(again).toEqual(["row-a"]);
  });

  test("a search more than 60 s later does not", () => {
    const { again, reporter } = recorder();
    reporter.searchStarted(T0)("row-a");
    reporter.searchStarted(T0 + AGAIN_WINDOW_MS + 1);
    expect(again).toEqual([]);
  });

  test("an opened search is not re-searched", () => {
    const { again, reporter } = recorder();
    reporter.searchStarted(T0)("row-a");
    reporter.opened(1);
    reporter.searchStarted(T0 + 1_000);
    expect(again).toEqual([]);
  });

  test("a search with no recorded row is not re-searched", () => {
    const { again, reporter } = recorder();
    reporter.searchStarted(T0)(null);
    reporter.searchStarted(T0 + 1_000);
    expect(again).toEqual([]);
  });

  test("a row is re-searched once, however many searches follow", () => {
    const { again, reporter } = recorder();
    reporter.searchStarted(T0)("row-a");
    reporter.searchStarted(T0 + 1_000)("row-b");
    reporter.searchStarted(T0 + 2_000);
    expect(again).toEqual(["row-a", "row-b"]);
  });
});

describe("createSearchOpenReporter: typing", () => {
  test("a query that only extends or trims the last one takes the last one out of the counts, not re-searched", () => {
    const { again, refined, reporter } = recorder();
    reporter.searchStarted(T0, "pro")("row-a");
    reporter.searchStarted(T0 + 400, "Project ")("row-b");
    reporter.searchStarted(T0 + 900, "proj")("row-c");
    expect(refined).toEqual(["row-a", "row-b"]);
    expect(again).toEqual([]);
  });

  test("a different query is a re-search", () => {
    const { again, refined, reporter } = recorder();
    reporter.searchStarted(T0, "project")("row-a");
    reporter.searchStarted(T0 + 5_000, "invoice");
    expect(again).toEqual(["row-a"]);
    expect(refined).toEqual([]);
  });

  test("a search followed before its row id arrives is settled when the id does", () => {
    const { again, refined, reporter } = recorder();
    const first = reporter.searchStarted(T0, "pro");
    const second = reporter.searchStarted(T0 + 300, "project");
    reporter.searchStarted(T0 + 5_000, "invoice");
    expect(refined).toEqual([]);
    first("row-a");
    second("row-b");
    expect(refined).toEqual(["row-a"]);
    expect(again).toEqual(["row-b"]);
  });

  test("an open of the refined search counts against it, and nothing else is sent for it", () => {
    const { opened, again, refined, reporter } = recorder();
    reporter.searchStarted(T0, "pro")("row-a");
    reporter.searchStarted(T0 + 400, "project")("row-b");
    reporter.opened(2);
    reporter.searchStarted(T0 + 5_000, "projects");
    expect(opened).toEqual([["row-b", 2]]);
    expect(refined).toEqual(["row-a"]);
    expect(again).toEqual([]);
  });
});

describe("createSearchOpenReporter: failures", () => {
  test("a failed or rejected report is swallowed", () => {
    const sync = createSearchOpenReporter({
      reportOpen: () => {
        throw new Error("offline");
      },
      reportAgain: () => {
        throw new Error("offline");
      },
    });
    const answered = sync.searchStarted(T0);
    answered("row-a");
    expect(() => sync.opened(1)).not.toThrow();
    expect(() => sync.searchStarted(T0 + 1)).not.toThrow();

    const async = createSearchOpenReporter({
      reportOpen: () => Promise.reject(new Error("offline")),
      reportAgain: () => Promise.reject(new Error("offline")),
    });
    async.searchStarted(T0)("row-a");
    expect(() => async.opened(1)).not.toThrow();
    expect(() => async.searchStarted(T0 + 1)).not.toThrow();
  });
});
