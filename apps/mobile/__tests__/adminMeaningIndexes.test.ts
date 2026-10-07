import { describe, expect, test } from "@jest/globals";
import {
  canRestartMeaning,
  meaningFailureLine,
  meaningProgressLine,
  meaningStatePill,
  restartedLine,
  stuckMeaningCount,
} from "../features/admin/meaningIndexes";

/**
 * The staff console's search-by-meaning panel, as words. The rules worth a red
 * test: an owner's off is never offered Restart, a failure says which call
 * failed, and "Restart everything stuck" counts what the server will restart.
 */

const row = (fields: Partial<Parameters<typeof meaningStatePill>[0]> = {}) => ({
  status: "failed" as const,
  enabled: true,
  ...fields,
});

describe("the indexing panel's words", () => {
  test("a failure names the call that failed", () => {
    expect(meaningFailureLine({ errorCode: "REFUSED", errorCause: "http_400" })).toBe(
      "Cloudflare refused a request (http_400)",
    );
    expect(meaningFailureLine({ errorCode: "STORE_FAILED", errorCause: null })).toBe(
      "Could not save progress to the bucket",
    );
    expect(meaningFailureLine({ errorCode: null, errorCause: null })).toBeNull();
  });

  test("progress reads as notes done of the total", () => {
    expect(meaningProgressLine({ notesIndexed: 40, notesPending: 703 })).toBe("40 of 743 notes");
    expect(meaningProgressLine({ notesIndexed: null, notesPending: null })).toBe("—");
  });

  test("an owner's off is never offered Restart, and is not counted as stuck", () => {
    const off = row({ enabled: false, status: "off" });
    expect(canRestartMeaning(off)).toBe(false);
    expect(meaningStatePill(off).label).toBe("Turned off by owner");
    expect(canRestartMeaning(row())).toBe(true);
    expect(canRestartMeaning(row({ status: "ready" }))).toBe(true);
    expect(
      stuckMeaningCount([row(), row({ status: "backfilling" }), row({ status: "ready" }), off]),
    ).toBe(2);
  });

  test("what a restart says", () => {
    expect(restartedLine(1, "restarted")).toBe("Restarted. It picks up where it stopped.");
    expect(restartedLine(3)).toBe("Restarted 3 workspaces.");
    expect(restartedLine(0, "turnedOff")).toBe("Not restarted: the owner turned search by meaning off.");
    expect(meaningStatePill(row()).tone).toBe("crit");
  });
});
