import { afterEach, describe, expect, test, vi } from "vitest";
import { ONE_OFF_RETRY_EVERY_MS, ONE_OFF_RETRY_MS } from "../functions/lib/routines/model";
import { agentPost, due, routineFixture, rowAt, signal } from "./routines.helpers";

/**
 * ROUTINES: A ONE-OFF REMINDER.
 *
 * A note in `routines/once/` names a date and time and runs once (the owner,
 * 2026-10-14: "remind me" must work). The gateway marks it `done:` after it
 * texts; here, the schedule row runs it at that instant, never again on its
 * own, and a run that failed is tried again for a while rather than lost.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the retry in `recordRoutineResultHandler` removed
 *     → "a failed one-off is tried again soon after" fails
 *   the `ONE_OFF_RETRY_MS` window check removed
 *     → "…but not once its moment is long past" fails
 */

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ONCE = "routines/once/call-sam.md";
const ONCE_TEXT = "---\nat: 2030-03-14 9:00 am\n---\nRemind me to call Sam about the venue deposit.\n";
// 9:00 am in New York (the fixture writer's zone) on 2030-03-14 is EDT.
const SET_FOR = Date.UTC(2030, 2, 14, 13, 0);

async function oneOff() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2030, 2, 1));
  const f = await routineFixture();
  f.backend.seed(ONCE, ONCE_TEXT);
  await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [ONCE] });
  return f;
}

async function fail(f: Awaited<ReturnType<typeof oneOff>>, runId: string) {
  await agentPost(f.t, "/agent-texts/routines/result", { runId, outcome: "failed", texted: 0 });
}

describe("a one-off", () => {
  test("is scheduled for the moment its file names, and runs once", async () => {
    const f = await oneOff();
    expect((await rowAt(f.t, f.workspaceId, ONCE))!.nextRunAt).toBe(SET_FOR);
    expect(await due(f.t)).toHaveLength(0);

    vi.setSystemTime(SET_FOR + 1000);
    const runs = await due(f.t);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.path).toBe(ONCE);
    expect((await rowAt(f.t, f.workspaceId, ONCE))!.nextRunAt).toBeNull();

    await agentPost(f.t, "/agent-texts/routines/result", { runId: runs[0]!.runId, outcome: "answered", texted: 1 });
    expect((await rowAt(f.t, f.workspaceId, ONCE))!.nextRunAt).toBeNull();
    vi.setSystemTime(SET_FOR + 24 * 60 * 60 * 1000);
    expect(await due(f.t)).toHaveLength(0);
  });

  test("a failed one-off is tried again soon after", async () => {
    const f = await oneOff();
    vi.setSystemTime(SET_FOR + 1000);
    const [run] = await due(f.t);
    await fail(f, run!.runId);
    expect((await rowAt(f.t, f.workspaceId, ONCE))!.nextRunAt).toBe(SET_FOR + 1000 + ONE_OFF_RETRY_EVERY_MS);

    vi.setSystemTime(SET_FOR + 2000 + ONE_OFF_RETRY_EVERY_MS);
    expect(await due(f.t)).toHaveLength(1);
  });

  test("…but not once its moment is long past", async () => {
    const f = await oneOff();
    vi.setSystemTime(SET_FOR + 1000);
    const [first] = await due(f.t);
    // The run hung until its moment was more than the window ago.
    vi.setSystemTime(SET_FOR + ONE_OFF_RETRY_MS + 1000);
    await fail(f, first!.runId);
    expect((await rowAt(f.t, f.workspaceId, ONCE))!.nextRunAt).toBeNull();
    vi.setSystemTime(SET_FOR + ONE_OFF_RETRY_MS + 10 * 60 * 1000);
    expect(await due(f.t)).toHaveLength(0);
  });
});
