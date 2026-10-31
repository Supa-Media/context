/**
 * The texting Worker's alarm asks for ONE routine, by its workspace and path,
 * on the due route (`{ scope: { workspaceId, path } }`). It is handed out only
 * if it is due now, and the cron's unscoped call still sees everything else.
 *
 * Mutation survival: a scoped claim that ignored `nextRunAt` would hand out a
 * routine early ("not yet due" fails); one that skipped the lease would run a
 * fired routine twice ("double fire" fails); one that claimed other rows would
 * strand them claimed-and-unrun ("only that routine" fails).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { DAILY, DAILY_TEXT, agentPost, due, makeDue, routineFixture, signal, stubBuckets, type DueRun, type RoutineFixture } from "./routines.helpers";

const OTHER = "routines/daily/lunch.md";

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function twoDailyRoutines(f: RoutineFixture): Promise<void> {
  f.backend.seed(DAILY, DAILY_TEXT);
  f.backend.seed(OTHER, DAILY_TEXT);
  await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY, OTHER] });
  await makeDue(f.t, f.workspaceId, DAILY);
  await makeDue(f.t, f.workspaceId, OTHER);
}

/** The run's result, as the texting Worker reports it. */
async function finish(f: RoutineFixture, runId: string): Promise<void> {
  const { body } = await agentPost(f.t, "/agent-texts/routines/result", { runId, outcome: "answered", texted: 0 });
  expect(body).toEqual({ status: "recorded" });
}

/** A run as the due route answers it: the shared helper's, and the next time an alarm re-arms at. */
type ScopedRun = DueRun & { nextRunAt?: number | null };

/** The alarm's call: one routine by its workspace and path. */
async function scopedDue(f: RoutineFixture, path: string): Promise<{ status: number; runs: ScopedRun[] }> {
  const { status, body } = await agentPost(f.t, "/agent-texts/routines/due", {
    scope: { workspaceId: f.workspaceId, path },
  });
  return { status, runs: (body.runs ?? []) as ScopedRun[] };
}

describe("an alarm asks for one routine", () => {
  test("hands out that routine's run, and leaves every other due routine for the cron", async () => {
    const f = await routineFixture();
    await twoDailyRoutines(f);
    const { status, runs } = await scopedDue(f, DAILY);
    expect(status).toBe(200);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.path).toBe(DAILY);
    // The writer's run is out until its result comes back (one grant per writer, `runs.ts`), so the cron
    // waits on the other routine until then, as it always has. The agent reports each result.
    expect(await due(f.t)).toEqual([]);
    await finish(f, runs[0]!.runId);
    // The other one is still due, and the cron's own call takes it.
    const cron = await due(f.t);
    expect(cron.map((run) => run.path)).toEqual([OTHER]);
  });

  test("a routine not yet due is not handed out early, and keeps its time", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY] });
    const before = await f.t.run(async (ctx) =>
      (await ctx.db.query("routines").collect()).find((row) => row.path === DAILY)?.nextRunAt,
    );
    expect(before).toBeGreaterThan(Date.now());
    const { status, runs } = await scopedDue(f, DAILY);
    expect(status).toBe(200);
    expect(runs).toEqual([]);
    const after = await f.t.run(async (ctx) =>
      (await ctx.db.query("routines").collect()).find((row) => row.path === DAILY)?.nextRunAt,
    );
    expect(after).toBe(before);
  });

  test("the run it hands out carries the routine's next time, after this one", async () => {
    const f = await routineFixture();
    await twoDailyRoutines(f);
    const { runs } = await scopedDue(f, DAILY);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.nextRunAt).toBeGreaterThan(Date.now());
  });

  test("a double fire is harmless: the second alarm, and the cron, find nothing to run", async () => {
    const f = await routineFixture();
    await twoDailyRoutines(f);
    const first = await scopedDue(f, DAILY);
    expect(first.runs).toHaveLength(1);
    // The same alarm again, while the first run is still out under its lease: nothing.
    expect((await scopedDue(f, DAILY)).runs).toEqual([]);
    await finish(f, first.runs[0]!.runId);
    // Once the result is in, the cron takes the other routine and never the one the alarm ran.
    const cron = await due(f.t);
    expect(cron.map((run) => run.path)).toEqual([OTHER]);
    expect((await scopedDue(f, DAILY)).runs).toEqual([]);
  });

  test("a malformed scope is refused, and an unknown routine hands out nothing", async () => {
    const f = await routineFixture();
    await twoDailyRoutines(f);
    const bad = await agentPost(f.t, "/agent-texts/routines/due", { scope: { workspaceId: "not-a-workspace", path: DAILY } });
    expect(bad.status).toBe(400);
    const unknown = await scopedDue(f, "routines/daily/never-written.md");
    expect(unknown).toEqual({ status: 200, runs: [] });
  });
});
