/** The staff storage move's pure rules (`functions/adminStorageRules.ts`): stages, staleness and the copy's paging. */
import { describe, expect, test } from "vitest";
import { copyStep, isStale, MOVE_STALE_MS, planMove, reportState } from "../functions/adminStorageRules";

describe("the move's rules", () => {
  const row = (over: Partial<Parameters<typeof reportState>[0]> = {}) => ({
    to: "dual" as const,
    state: "running" as const,
    startedAt: 0,
    heartbeatAt: 0,
    ...over,
  });

  test("a heartbeat older than two minutes is stale, and exactly two minutes is still running", () => {
    const now = 10 * MOVE_STALE_MS;
    expect(isStale(row({ heartbeatAt: now - MOVE_STALE_MS }), now)).toBe(false);
    expect(isStale(row({ heartbeatAt: now - MOVE_STALE_MS - 1 }), now)).toBe(
      true,
    );
    expect(reportState(row({ heartbeatAt: now - 1000 }), now)).toBe("running");
    expect(
      reportState(row({ heartbeatAt: now - MOVE_STALE_MS - 1 }), now),
    ).toBe("stale");
    expect(reportState(row({ state: "incomplete", heartbeatAt: 0 }), now)).toBe(
      "incomplete",
    );
  });

  test("the stage check: bucket to dual and dual to object only, and a second run is refused while fresh", () => {
    const now = 1_000_000;
    expect(
      planMove({ name: "x", home: "bucket", to: "dual", row: null, now }),
    ).toEqual({
      ok: true,
      switched: false,
      gaps: false,
    });
    expect(
      planMove({ name: "x", home: "dual", to: "object", row: null, now }),
    ).toEqual({
      ok: true,
      switched: false,
      gaps: false,
    });
    expect(
      planMove({ name: "x", home: "bucket", to: "object", row: null, now }),
    ).toMatchObject({
      ok: false,
      message: "Copy @x first",
    });
    expect(
      planMove({ name: "x", home: "object", to: "dual", row: null, now }),
    ).toMatchObject({
      ok: false,
      message: "@x is already on its object",
    });
    expect(
      planMove({
        name: "x",
        home: "dual",
        to: "dual",
        row: row({ state: "done", heartbeatAt: now }),
        now,
      }),
    ).toMatchObject({
      ok: false,
      message: "@x is already copied; move its reads to its object",
    });
    expect(
      planMove({
        name: "x",
        home: "dual",
        to: "dual",
        row: row({ heartbeatAt: now - 1000 }),
        now,
      }),
    ).toMatchObject({ ok: false, message: "A move for @x is already running" });
  });

  test("a stale copy resumes from its cursor and carries its gaps", () => {
    const now = 1_000_000;
    const stale = row({
      heartbeatAt: now - MOVE_STALE_MS - 1,
      cursor: "C",
      gaps: true,
    });
    expect(
      planMove({ name: "x", home: "dual", to: "dual", row: stale, now }),
    ).toEqual({
      ok: true,
      switched: true,
      cursor: "C",
      gaps: true,
    });
    // A stale switch that never reached the copy starts again from the switch.
    expect(
      planMove({ name: "x", home: "bucket", to: "dual", row: stale, now }),
    ).toEqual({ ok: true, switched: false, gaps: false });
  });

  test("the copy's paging: a page that is not the last hands on its cursor; gaps stick once seen", () => {
    const page = {
      done: false,
      cursor: "next",
      failed: 0,
      unreachable: 0,
      heldBack: 0,
    };
    expect(copyStep(page, false)).toEqual({
      done: false,
      cursor: "next",
      gaps: false,
    });
    expect(copyStep({ ...page, heldBack: 1 }, false).gaps).toBe(true);
    expect(copyStep({ ...page, done: true, cursor: "" }, true)).toEqual({
      done: true,
      cursor: "",
      gaps: true,
    });
  });
});
