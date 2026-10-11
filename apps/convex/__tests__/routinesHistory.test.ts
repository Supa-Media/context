import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifestForFolders } from "../functions/lib/scaffold";
import { asUser, captureError, errorCode } from "./fixtures.helpers";
import { DAILY, DAILY_TEXT, routineFixture, type RoutineFixture } from "./routines.helpers";

/**
 * ROUTINES: READING A ROUTINE'S RECENT RUNS FROM THE APP.
 *
 * The history is plumbing in the customer's bucket
 * (`.context/agent/routines/daily/standup.json`), read by the routine note's
 * own path, and only for someone who can see that note — the same `canSee`
 * every note read goes through. Nothing is kept in the control plane.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `readRoutineRuns` without its `canSee` check
 *     → "a member cannot read the runs of a routine they cannot see" fails
 *   `readRoutineRuns` without its routine-path check
 *     → "only a routine's history, never another plumbing key" fails
 */

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

const HISTORY = ".context/agent/routines/daily/standup.json";

function seedRuns(f: RoutineFixture, count: number) {
  const runs = Array.from({ length: count }, (_, i) => ({
    at: 1_700_000_000_000 + i * 60_000,
    outcome: i % 2 === 0 ? "answered" : "skipped",
    text: i % 2 === 0 ? `run ${i}` : "",
  }));
  f.backend.seed(HISTORY, JSON.stringify({ version: 1, runs }));
}

/** `routines/` shared with the workspace, the way an owner sharing the folder would. */
function shareRoutines(f: RoutineFixture) {
  f.backend.seed(
    PRIVACY_KEY,
    renderPrivacyManifestForFolders(["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "routines"], "shared"),
  );
}

function runsFor(f: RoutineFixture, user: RoutineFixture["owner"], path = DAILY, workspaceId = f.workspaceId) {
  return asUser(f.t, user).action(api.functions.routines.routineRuns, { workspaceId, path });
}

describe("a routine's recent runs", () => {
  test("come back newest first, at most the twenty kept", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    seedRuns(f, 25);
    const runs = await runsFor(f, f.owner);
    expect(runs).toHaveLength(20);
    expect(runs[0]).toEqual({ at: 1_700_000_000_000 + 24 * 60_000, outcome: "answered", text: "run 24" });
    expect(runs[19]!.at).toBe(1_700_000_000_000 + 5 * 60_000);
  });

  test("a routine that has never run has none, and a broken file is none rather than an error", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    expect(await runsFor(f, f.owner)).toEqual([]);
    f.backend.seed(HISTORY, "{not json");
    expect(await runsFor(f, f.owner)).toEqual([]);
  });

  test("a member cannot read the runs of a routine they cannot see", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    seedRuns(f, 3);
    // `routines/` is private until the owner shares it.
    const refused = await captureError(() => runsFor(f, f.member));
    expect(errorCode(refused)).toBe("FILE_NOT_FOUND");
    shareRoutines(f);
    expect(await runsFor(f, f.member)).toHaveLength(3);
  });

  test("a stranger is refused, as for a workspace that does not exist", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    shareRoutines(f);
    seedRuns(f, 3);
    const refused = await captureError(() => runsFor(f, f.stranger));
    expect(errorCode(refused)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a deleted routine has no history to read, though its file is still there", async () => {
    const f = await routineFixture();
    seedRuns(f, 3);
    const refused = await captureError(() => runsFor(f, f.owner));
    expect(errorCode(refused)).toBe("FILE_NOT_FOUND");
  });

  test("only a routine's history, never another plumbing key or a note's", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    seedRuns(f, 3);
    f.backend.seed("1-projects/plan.md", "# Plan\n");
    for (const path of [HISTORY, ".context/agent/routines/daily/standup.md", "1-projects/plan.md", "routines/standup.md", "routines/daily/../daily/standup.md"]) {
      const refused = await captureError(() => runsFor(f, f.owner, path));
      expect(["FILE_NOT_FOUND", "PATH_INVALID"]).toContain(errorCode(refused));
    }
  });
});

describe("a person's fallback time zone", () => {
  test("is null until set, then what was set", async () => {
    const f = await routineFixture();
    expect(await asUser(f.t, f.owner).query(api.functions.routines.myTimeZone, {})).toBeNull();
    await asUser(f.t, f.owner).mutation(api.functions.routines.setMyTimeZone, { timeZone: "Europe/London" });
    expect(await asUser(f.t, f.owner).query(api.functions.routines.myTimeZone, {})).toBe("Europe/London");
    expect(await asUser(f.t, f.member).query(api.functions.routines.myTimeZone, {})).toBeNull();
  });
});
