/**
 * A background job wakes itself (`jobDrive.ts`, Dev2, 2026-11-21): its own alarm runs each pass, waits between them,
 * retries a pass that failed and ends the job when every try did, as the `job-run` workflow did before.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `driveJob` without its catch around a pass: "a pass that keeps failing is tried four times, 10, 20 and 40 s
 *    apart, then the job ends with its couldn't-finish line" fails;
 *  - `driveJob` arming no watch before the pass: "a pass that never comes back is tried again from its watch" fails;
 *  - overlap waits counted as passes: "waits out a pass still running without spending the job's passes" fails;
 *  - `superseded` dropped: "a restart while a pass ran keeps the restart's drive" fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, ENDED_KEY, failJob, jobAlarm, resumeJob, runJob, type JobDeps, type JobNext } from "./jobRun";
import { DRIVE_KEY, driveJob, MAX_FAIL_TRIES, MAX_JOB_PASSES, MAX_OVERLAP_WAITS, PASS_WATCH_MS, startDrive, type Drive, type JobStep } from "./jobDrive";
import { JOB_KEPT_MS, JOB_LINES, jobTag, MAX_JOB_ATTEMPTS, RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { AlarmStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const RUN: JobRun = {
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Competitor research",
  brief: "Five competitors.",
  origin: { kind: "phone", phone: PHONE, question: "research our competitors" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
};

function deps(answers: Array<{ status?: number; body: Record<string, unknown> }>, clock: { now: number }) {
  const reports: JobUpdate[] = [];
  const d: JobDeps = {
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "UTC" });
      if (path === "/agent/job/note") return Response.json({ ok: false, code: "no_note" });
      if (path === "/agent/job/part-end") return new Response(null, { status: 404 });
      const next = answers.shift();
      if (!next) throw new Error("no answer left");
      return Response.json(next.body, { status: next.status ?? 200 });
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => clock.now,
    report: async (_inbox, update) => (reports.push(update), true),
  };
  return { d, reports };
}

/** The job's object as its alarm reaches it: the alarm fires at the time it was set for, until none is left. */
async function runAlarms(storage: AlarmStorage, clock: { now: number }, step: JobStep, max = 2_000): Promise<number[]> {
  const fired: number[] = [];
  for (let i = 0; i < max && storage.alarm !== null; i += 1) {
    clock.now = Math.max(clock.now, storage.alarm);
    fired.push(clock.now);
    storage.fire();
    const outcome = await driveJob(storage, step, () => clock.now);
    if (outcome === "none" || outcome === "legacy") break;
  }
  return fired;
}

/** The job's real pass and couldn't-finish line, run in the object. */
const steps = (storage: AlarmStorage, d: JobDeps): JobStep => async (step) => (step === "pass" ? await runJob(storage, d) : await failJob(storage, d));

type DriveLine = { event?: string; outcome?: string; job?: string; [key: string]: unknown };
function driveLines(logs: { mock: { calls: unknown[][] } }): DriveLine[] {
  return logs.mock.calls.flat().map((line): DriveLine => JSON.parse(String(line))).filter((line) => line.event === "job_drive");
}

afterEach(() => vi.restoreAllMocks());

describe("a background job's own alarm", () => {
  it("runs every pass on its alarm, waits between them there, and ends the job", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    expect(storage.alarm).toBe(NOW);
    const busy = { status: 503, body: { error: "model_unavailable" } };
    const { d, reports } = deps([busy, { body: { answer: "Found three so far.", exhausted: true } }, { body: { answer: "Wrote the note." } }], clock);
    await runAlarms(storage, clock, steps(storage, d));
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Wrote the note."] });
    expect(storage.data.has(RUN_KEY)).toBe(false);
    expect(storage.data.has(DRIVE_KEY)).toBe(false);
    // Every pass logged, the job by its tag and never its id.
    const lines = driveLines(logs);
    expect(lines.map((line) => line.outcome)).toEqual(["started", "passed", "passed", "done"]);
    expect(lines.every((line) => line.job === jobTag(RUN.id))).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(RUN.id);
  });

  it("a job that takes every one of its parts, each after a busy model, still ends on its alarm", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    const busy = { status: 503, body: { error: "model_unavailable" } };
    const parts = Array.from({ length: MAX_JOB_ATTEMPTS }, (_, i) => [busy, busy, { body: { answer: i === MAX_JOB_ATTEMPTS - 1 ? "Wrote the note." : "More to do.", unfinished: true, verdict: "keep_going", advice: "Carry on." } }]).flat();
    const { d, reports } = deps(parts, clock);
    await runAlarms(storage, clock, steps(storage, d));
    const last = reports.at(-1)!;
    expect(last).toMatchObject({ state: "stuck" });
    expect(last.texts?.[0]).toBe("Wrote the note.");
    expect(storage.data.has(DRIVE_KEY)).toBe(false);
  });

  it("a pass that keeps failing is tried four times, 10, 20 and 40 s apart, then the job ends with its couldn't-finish line", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    const { d, reports } = deps([], clock);
    let passes = 0;
    const step: JobStep = async (which) => {
      if (which === "pass") {
        passes += 1;
        throw new Error("job /job-pass answered 500");
      }
      return await failJob(storage, d);
    };
    const fired = await runAlarms(storage, clock, step);
    expect(passes).toBe(4);
    // The waits between its four tries; the alarm after them is the ended job's, to drop its kept run.
    expect(fired.slice(1, 4).map((at, i) => at - fired[i])).toEqual([10_000, 20_000, 40_000]);
    expect(reports).toEqual([expect.objectContaining({ state: "failed", texts: [], end: { action: "job", status: "failed", why: "every_try_failed" } })]);
    expect(storage.data.has(RUN_KEY)).toBe(false);
    expect(storage.data.has(DRIVE_KEY)).toBe(false);
  });

  it("a pass that never comes back (its object reset, its alarm out of time) is tried again from its watch", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    storage.fire();
    // The first pass hangs for ever: the isolate running it is gone.
    void driveJob(storage, () => new Promise<JobNext>(() => {}), () => clock.now);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.alarm).toBe(NOW + PASS_WATCH_MS);
    expect(await storage.get<Drive>(DRIVE_KEY)).toMatchObject({ pass: 0, tries: 1 });
    const { d, reports } = deps([{ body: { answer: "Wrote the note." } }], clock);
    await runAlarms(storage, clock, steps(storage, d));
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Wrote the note."] });
  });

  it("a watch that fires early, or a stray alarm, waits for the pass's time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new AlarmStorage();
    await storage.put(RUN_KEY, RUN);
    await storage.put<Drive>(DRIVE_KEY, { pass: 2, tries: 0, overlaps: 0, dueAt: NOW + 3_600_000, resumes: 0 });
    let ran = 0;
    expect(await driveJob(storage, async () => (ran++, { kind: "done" }), () => NOW)).toBe("waiting");
    expect(ran).toBe(0);
    expect(storage.alarm).toBe(NOW + 3_600_000);
  });

  it("waits out a pass still running without spending the job's passes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    // Ten overlaps, then every pass the job has: had the overlaps been counted as passes, it would have run out.
    let overlapping = 10;
    let passes = 0;
    const finished: string[] = [];
    const fired = await runAlarms(storage, clock, async (which) => {
      if (which === "failed") return (finished.push("failed"), { kind: "done" });
      if (overlapping-- > 0) return { kind: "after", ms: 30_000, overlap: true };
      passes += 1;
      if (passes < MAX_JOB_PASSES) return { kind: "now" };
      await storage.delete(RUN_KEY);
      return { kind: "done" };
    });
    expect(finished).toEqual([]);
    expect(passes).toBe(MAX_JOB_PASSES);
    expect(fired.slice(1, 11).map((at, i) => at - fired[i])).toEqual(Array(10).fill(30_000));
  });

  it("stops waiting on overlaps after its cap", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    let asked = 0;
    const finished: string[] = [];
    await runAlarms(storage, clock, async (which) => {
      if (which === "failed") return (finished.push("failed"), await storage.delete(RUN_KEY), { kind: "done" });
      asked += 1;
      return { kind: "after", ms: 30_000, overlap: true };
    });
    expect(finished).toEqual(["failed"]);
    expect(asked).toBe(MAX_OVERLAP_WAITS + 1);
  });

  it("never takes more than its passes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    let passes = 0;
    let failed = 0;
    await runAlarms(storage, clock, async (which) => {
      if (which === "failed") return (failed++, await storage.delete(RUN_KEY), { kind: "done" });
      passes += 1;
      return { kind: "now" };
    });
    expect(passes).toBe(MAX_JOB_PASSES);
    expect(failed).toBe(1);
  });

  it("the couldn't-finish line is tried until it lands, then dropped loudly", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    let fails = 0;
    await runAlarms(storage, clock, async (which) => {
      if (which === "failed") fails += 1;
      throw new Error("down");
    });
    expect(fails).toBe(MAX_FAIL_TRIES);
    expect(storage.data.has(DRIVE_KEY)).toBe(false);
    expect(errors.mock.calls.flat().join("")).toContain('"outcome":"dropped"');
  });

  it("a start retried for a stored job keeps its drive; a job its workflow started is left to it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    await storage.put<Drive>(DRIVE_KEY, { pass: 3, tries: 1, overlaps: 0, dueAt: NOW + 20_000, resumes: 0 });
    storage.fire();
    await acceptJob(storage, RUN, NOW + 5_000);
    expect(await storage.get<Drive>(DRIVE_KEY)).toMatchObject({ pass: 3, tries: 1 });
    expect(storage.alarm).toBe(NOW + 20_000);

    const legacy = new AlarmStorage();
    await legacy.put(RUN_KEY, RUN);
    let ran = 0;
    expect(await driveJob(legacy, async () => (ran++, { kind: "done" }), () => NOW)).toBe("legacy");
    expect(ran).toBe(0);
    expect(legacy.alarm).toBeNull();
  });

  it("a restart while a pass ran keeps the restart's drive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    storage.fire();
    const outcome = await driveJob(storage, async () => {
      // The pass ended the job, and "restart it" came in before the alarm wrote what's next.
      await storage.put(RUN_KEY, { ...RUN, resumes: 1 });
      await startDrive(storage, 1, NOW);
      return { kind: "done" };
    }, () => NOW);
    expect(outcome).toBe("passed");
    expect(await storage.get<Drive>(DRIVE_KEY)).toEqual({ pass: 0, tries: 0, overlaps: 0, dueAt: NOW, resumes: 1 });
  });

  it("through the object's alarm: runs the job's own pass, then drops the kept run of one that ended", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, RUN, NOW);
    const busy = { status: 503, body: { error: "model_unavailable" } };
    const { d, reports } = deps([busy, { body: { answer: "Wrote the note." } }], clock);
    storage.fire();
    await jobAlarm(storage, d);
    expect(storage.alarm).toBe(NOW + 20_000);
    clock.now = NOW + 20_000;
    storage.fire();
    await jobAlarm(storage, d);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Wrote the note."] });

    const kept = new AlarmStorage();
    await kept.put(ENDED_KEY, { run: RUN, endedAt: NOW - JOB_KEPT_MS - 1 });
    await jobAlarm(kept, deps([], clock).d);
    expect(kept.data.has(ENDED_KEY)).toBe(false);
  });

  it("a job picked back up is driven again from its first pass", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = { now: NOW };
    const storage = new AlarmStorage();
    await acceptJob(storage, { ...RUN, attempt: 10 }, NOW);
    const first = deps([{ body: { answer: "Couldn't sign in.", unfinished: true } }], clock);
    await runAlarms(storage, clock, steps(storage, first.d));
    expect(first.reports.at(-1)).toMatchObject({ state: "stuck" });
    expect(storage.data.has(DRIVE_KEY)).toBe(false);
    clock.now = NOW + 60_000;
    expect(await resumeJob(storage, clock.now)).toBe(true);
    expect(await storage.get<Drive>(DRIVE_KEY)).toMatchObject({ pass: 0, resumes: 1, dueAt: clock.now });
    const again = deps([{ body: { answer: "Signed in and booked.", verdict: "done" } }], clock);
    await runAlarms(storage, clock, steps(storage, again.d));
    expect(again.reports.at(-1)).toMatchObject({ state: "done" });
  });
});
