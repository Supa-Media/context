/**
 * The once-per-search rule for reporting an opened search result.
 *
 * Pure: no React, so it runs in plain node. The palette's wiring is in
 * `paletteRender/searchOpen.test.ts`.
 */

import { describe, expect, test } from "@jest/globals";
import { createSearchOpenReporter } from "../features/console/files/searchOpenReport";

describe("createSearchOpenReporter", () => {
  test("the first open after a search reports its position", () => {
    const reported: number[] = [];
    const reporter = createSearchOpenReporter((p) => reported.push(p));
    reporter.opened(2);
    expect(reported).toEqual([2]);
  });

  test("a second open of the same search reports nothing", () => {
    const reported: number[] = [];
    const reporter = createSearchOpenReporter((p) => reported.push(p));
    reporter.opened(2);
    reporter.opened(3);
    expect(reported).toEqual([2]);
  });

  test("a new search re-arms the report", () => {
    const reported: number[] = [];
    const reporter = createSearchOpenReporter((p) => reported.push(p));
    reporter.opened(2);
    reporter.rearm();
    reporter.opened(1);
    expect(reported).toEqual([2, 1]);
  });

  test("a failed or rejected report is swallowed", () => {
    const sync = createSearchOpenReporter(() => {
      throw new Error("offline");
    });
    expect(() => sync.opened(1)).not.toThrow();

    const async = createSearchOpenReporter(() => Promise.reject(new Error("offline")));
    expect(() => async.opened(1)).not.toThrow();
  });
});
