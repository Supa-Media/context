import { describe, expect, test } from "vitest";
import { sweepFinish } from "../functions/lib/organizer/settings";

/**
 * A sweep that asked about notes and heard nothing back did not read them, and
 * Settings must not say it did. This is what turned a model that never
 * answered into "done, nothing to tidy" before 2026-10-05.
 */
describe("how a sweep ends", () => {
  test("no answer to any question is a sweep that failed", () => {
    expect(sweepFinish(12, 0)).toBe("failed");
  });

  test("one answer is enough to call it done", () => {
    expect(sweepFinish(12, 1)).toBe("done");
    expect(sweepFinish(12, 12)).toBe("done");
  });

  test("nothing to ask about is done, not failed", () => {
    expect(sweepFinish(0, 0)).toBe("done");
  });
});
