/**
 * A job paused at the daily limit picks itself back up once the limit resets (`jobPause.ts`; Dev2, 2026-11-05: the
 * pause said "text me tomorrow and I'll pick it back up", and the next day nothing was left to pick up).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `finish` keeping the run two hours from the pause (no `keepUntil`) → "starts again by itself just after midnight UTC".
 *  2. `sweptJobs` lapsing a paused job two hours from its pause → "starts again by itself just after midnight UTC".
 *  3. `resumePausedJobs` not checking `resumeAt` → "does nothing before the reset, and arms the alarm for it".
 *  4. `steerJobs` skipping a waiting job's stop → "stopped while paused, it never starts again".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, resumeJob, runJob, type JobDeps } from "./jobRun";
import { chatJobs, JOB_LINES, JOB_SHOWN_MS, noteJobUpdate, RUN_KEY, startJobs, steerJobs, WAIT_ENDED_STATUS, type JobRun, type JobUpdate } from "./jobs";
import { AFTER_RESET_MS, limitResetAt, resumePausedJobs, RETRY_MS } from "./jobPause";
import { AlarmStorage, MemoryStorage } from "./memoryStorage.testing";

// 11 PM Eastern on November 4th, 2026: the limit resets at midnight UTC, an hour later.
const NOW = Date.UTC(2026, 10, 5, 3, 0);
const RESET = Date.UTC(2026, 10, 6, 0, 0) + AFTER_RESET_MS;
const PHONE = "+15555550100";

function gateway(answers: Array<{ status: number; body: Record<string, unknown> }>, now: number) {
  const reports: JobUpdate[] = [];
  const asked: Record<string, unknown>[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "America/New_York" });
      if (path === "/agent") {
        asked.push(JSON.parse(String(init.body)));
        const next = answers.shift();
        if (!next) throw new Error("no answer left");
        return Response.json(next.body, { status: next.status });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => now,
    report: async (_inbox, update) => {
      reports.push(update);
      return true;
    },
  };
  return { deps, reports, asked };
}

/** A chat's inbox and its job's own object, with a job paused at the daily limit at `NOW`. */
async function pausedJob(why: "daily_limit" | "no_model" = "daily_limit") {
  const inbox = new AlarmStorage();
  const object = new MemoryStorage();
  let run: JobRun | undefined;
  await startJobs(inbox, [{ title: "Morocco trip plan", brief: "Plan the trip." }], {
    now: NOW,
    inbox: PHONE,
    origin: { kind: "phone", phone: PHONE, question: "plan my morocco trip" },
    place: { chatId: "chat_1" },
    spawn: async (_id, started) => void (run = started),
  });
  await acceptJob(object, run!, NOW);
  const paused = gateway([{ status: why === "daily_limit" ? 429 : 409, body: { error: why } }], NOW);
  await runJob(object, paused.deps);
  const update = paused.reports.at(-1)!;
  await noteJobUpdate(inbox, update, NOW);
  const id = run!.id;
  const restarts: number[] = [];
  const send = async (jobId: string, steer: Parameters<typeof resumeJob>[3]) => jobId === id && (await resumeJob(object, clock.now, async () => void restarts.push(clock.now), steer));
  const clock = { now: NOW };
  return { inbox, object, update, id, send, restarts, clock };
}

describe("a job paused at the daily limit", () => {
  it("restarts just after midnight UTC", () => {
    expect(limitResetAt(NOW)).toBe(RESET);
    expect(limitResetAt(Date.UTC(2026, 10, 5, 23, 59))).toBe(RESET);
  });

  it("says it will pick itself back up, not to text tomorrow", async () => {
    const { update } = await pausedJob();
    expect(update).toMatchObject({ state: "waiting", resumeAt: RESET, texts: [JOB_LINES.refused("Morocco trip plan", "daily_limit")] });
    expect(update.texts?.[0]).toMatch(/pick it back up by myself as soon as the limit resets/);
    expect(update.texts?.[0]).not.toMatch(/tomorrow/i);
  });

  it("does nothing before the reset, and arms the alarm for it", async () => {
    const { inbox, send, restarts, clock } = await pausedJob();
    clock.now = RESET - 60_000;
    await resumePausedJobs(inbox, send, clock.now);
    expect(restarts).toEqual([]);
    expect(await inbox.getAlarm?.()).toBe(RESET);
  });

  it("starts again by itself just after midnight UTC, hours after its pause", async () => {
    const { inbox, object, id, send, restarts, clock } = await pausedJob();
    clock.now = RESET;
    // Still waiting for its restart, long past two hours from its pause.
    expect(RESET - NOW).toBeGreaterThan(JOB_SHOWN_MS);
    expect((await chatJobs(inbox, clock.now)).find((job) => job.id === id)).toMatchObject({ state: "waiting" });
    await resumePausedJobs(inbox, send, clock.now);
    expect(restarts).toEqual([RESET]);
    expect(object.data.has(RUN_KEY)).toBe(true);
    const [entry] = await chatJobs(inbox, clock.now);
    expect(entry).toMatchObject({ id, state: "running", status: "Picking up where it stopped" });
    // Its next part is the same ask.
    const next = gateway([{ status: 200, body: { answer: "Here's the plan: https://context.lc/note/@seyi/morocco.page.md", verdict: "done" } }], clock.now);
    await runJob(object, next.deps);
    expect(next.asked[0]).toMatchObject({ question: "plan my morocco trip" });
    expect(next.reports.at(-1)).toMatchObject({ state: "done" });
  });

  it("tries again later when three jobs are already running", async () => {
    const { inbox, send, restarts, clock, id } = await pausedJob();
    await startJobs(inbox, [{ title: "a", brief: "a" }, { title: "b", brief: "b" }, { title: "c", brief: "c" }], {
      now: RESET, inbox: PHONE, origin: { kind: "phone", phone: PHONE, question: "abc" }, place: { chatId: "chat_1" }, spawn: async () => {},
    });
    clock.now = RESET;
    await resumePausedJobs(inbox, send, clock.now);
    expect(restarts).toEqual([]);
    expect(await inbox.getAlarm?.()).toBe(RESET + RETRY_MS);
    expect((await chatJobs(inbox, clock.now, { all: true })).find((job) => job.id === id)).toMatchObject({ state: "waiting" });
  });

  it("lapses two hours after its restart time if it never could start", async () => {
    const { inbox, id } = await pausedJob();
    const [lapsed] = (await chatJobs(inbox, RESET + JOB_SHOWN_MS + 1, { all: true })).filter((job) => job.id === id);
    expect(lapsed).toMatchObject({ state: "stuck", status: WAIT_ENDED_STATUS });
  });

  it("a pause for no model keeps the two hours, and is not restarted by itself", async () => {
    const { update, inbox, send, restarts } = await pausedJob("no_model");
    expect(update.resumeAt).toBeUndefined();
    await resumePausedJobs(inbox, send, RESET);
    expect(restarts).toEqual([]);
  });

  it("stopped while paused, it never starts again", async () => {
    const { inbox, id, send, restarts } = await pausedJob();
    // "Never mind the trip plan": the turn stops it (`apps/mcp/src/agent/background.js` steer).
    expect(await steerJobs(inbox, [{ id, stop: true }], { id: "ev_stop", text: "never mind the trip plan" }, async () => true, NOW + 60_000)).toBe(1);
    expect((await chatJobs(inbox, NOW + 60_000))[0]).toMatchObject({ id, state: "failed", status: "Stopped when they asked" });
    await resumePausedJobs(inbox, send, RESET);
    expect(restarts).toEqual([]);
  });
});
