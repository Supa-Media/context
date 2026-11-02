/**
 * The live head reads the log one row at a time (`newestTold`): every open
 * device re-runs it on each change in its workspace, and taking all
 * `NODE_HEAD_SCAN` rows each time was 34 GB of Convex reads in eighteen days
 * (owner 2026-10-30). Sabotage: collect the rows before judging them and the
 * "stops at the first" case fails.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { newestTold, type LogRow, type Rules } from "../../functions/lib/nodes/log";

const NO_RULES: Rules = { rules: [], overrides: new Map() } as unknown as Rules;

function counted(rows: LogRow[]): { iterable: AsyncIterable<LogRow>; pulled: () => number } {
  let pulled = 0;
  return {
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (const row of rows) {
          pulled += 1;
          yield row;
        }
      },
    },
    pulled: () => pulled,
  };
}

const log = (count: number): LogRow[] =>
  Array.from({ length: count }, (_, index) => ({ seq: 1000 - index, path: `notes/n${index}.md`, gone: false }));

describe("the live head", () => {
  test("stops at the first row the reader may hear of", async () => {
    const rows = counted(log(100));
    expect(await newestTold(rows.iterable, 100, clearanceOf("private"), NO_RULES)).toBe(1000);
    expect(rows.pulled()).toBe(1);
  });

  test("steps over what it skips, and reads no more than its limit", async () => {
    const skipped = counted(log(100));
    const skipFirstTwo = (path: string) => path === "notes/n0.md" || path === "notes/n1.md";
    expect(await newestTold(skipped.iterable, 100, clearanceOf("private"), NO_RULES, skipFirstTwo)).toBe(998);
    expect(skipped.pulled()).toBe(3);

    const none = counted(log(100));
    expect(await newestTold(none.iterable, 10, clearanceOf("private"), NO_RULES, () => true)).toBeNull();
    expect(none.pulled()).toBeLessThanOrEqual(11);
  });
});
