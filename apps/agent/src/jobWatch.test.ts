/**
 * A job's object watches its own workflow (`jobWatch.ts`, Dev2, 2026-11-20).
 *
 * Sabotage (temporary local edits, reverted):
 *  - `acceptJob` returning early again when the job is stored: "a start retried after the workflow failed to
 *    start starts it" fails;
 *  - `watchJob` without its "no instance" branch: "a job whose start was lost is started by the watch" fails;
 *  - `DEAD` without "errored": "a job whose instance errored without a word ends with its couldn't-finish line" fails.
 */
import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, type JobDeps } from "./jobRun";
import { JOB_LINES, RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { armJobWatch, watchJob, WATCH_MS } from "./jobWatch";
import { jobFlowId, startJobFlow } from "./jobWorkflow";
import { AlarmStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const RUN: JobRun = {
  id: "job-watch-1",
  inbox: "+15555550100",
  title: "Competitor research",
  brief: "Five competitors.",
  origin: { kind: "phone", phone: "+15555550100", question: "research our competitors" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
};

function deps() {
  const reports: JobUpdate[] = [];
  const d: JobDeps = {
    fetch: (async () => new Response(null, { status: 500 })) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async (_inbox, update) => (reports.push(update), true),
  };
  return { d, reports };
}

/** Workflows, in memory: instances by id with a status; `failCreate` makes the next creates throw. */
function workflow() {
  const instances = new Map<string, string>();
  let failCreate = 0;
  const wf = {
    instances,
    failNext: (n: number) => void (failCreate = n),
    create: async ({ id }: { id: string }) => {
      if (failCreate > 0) {
        failCreate -= 1;
        throw new Error("workflows unavailable");
      }
      if (instances.has(id)) throw new Error("instance already exists");
      instances.set(id, "running");
      return { id } as never;
    },
    get: async (id: string) => {
      const status = instances.get(id);
      if (status === undefined) throw new Error("instance not found");
      return { id, status: async () => ({ status }) } as never;
    },
  };
  return wf;
}

describe("a job's object watches its workflow", () => {
  it("a start retried after the workflow failed to start starts it", async () => {
    const storage = new AlarmStorage();
    const wf = workflow();
    wf.failNext(1);
    await expect(acceptJob(storage, RUN, NOW, () => startJobFlow(wf as never, RUN.id))).rejects.toThrow();
    expect(await storage.get(RUN_KEY)).toBeDefined();
    expect(wf.instances.size).toBe(0);
    // The chat's retry of `/job-start` finds the job stored, and starts it now.
    await acceptJob(storage, RUN, NOW, () => startJobFlow(wf as never, RUN.id));
    expect(wf.instances.get(jobFlowId(RUN.id))).toBe("running");
  });

  it("a job whose start was lost is started by the watch, and the watch stays armed", async () => {
    const storage = new AlarmStorage();
    const wf = workflow();
    await storage.put(RUN_KEY, RUN);
    expect(await watchJob(storage, wf as never, deps().d)).toBe("started");
    expect(wf.instances.get(jobFlowId(RUN.id))).toBe("running");
    expect(storage.alarm).toBe(NOW + WATCH_MS);
    // Next check: alive, left alone, armed again.
    storage.fire();
    expect(await watchJob(storage, wf as never, deps().d)).toBe("alive");
    expect(storage.alarm).toBe(NOW + WATCH_MS);
  });

  it("a resumed job is watched under its restart's own instance", async () => {
    const storage = new AlarmStorage();
    const wf = workflow();
    wf.instances.set(jobFlowId(RUN.id), "complete"); // the first run's instance, ended
    await storage.put(RUN_KEY, { ...RUN, resumes: 2 });
    expect(await watchJob(storage, wf as never, deps().d)).toBe("started");
    expect(wf.instances.get(jobFlowId(RUN.id, 2))).toBe("running");
  });

  it("a job whose instance errored without a word ends with its couldn't-finish line", async () => {
    const storage = new AlarmStorage();
    const wf = workflow();
    await storage.put(RUN_KEY, RUN);
    wf.instances.set(jobFlowId(RUN.id), "errored");
    const { d, reports } = deps();
    expect(await watchJob(storage, wf as never, d)).toBe("failed");
    expect(reports.at(-1)?.texts).toEqual([JOB_LINES.failed(RUN.title)]);
    expect(await storage.get(RUN_KEY)).toBeUndefined();
  });

  it("an instance that completed with the job still stored is only logged, never ended or restarted", async () => {
    const storage = new AlarmStorage();
    const wf = workflow();
    await storage.put(RUN_KEY, RUN);
    wf.instances.set(jobFlowId(RUN.id), "complete");
    const { d, reports } = deps();
    expect(await watchJob(storage, wf as never, d)).toBe("orphaned");
    expect(reports).toEqual([]);
    expect(wf.instances.size).toBe(1);
  });

  it("nothing stored, or no workflows: the watch does nothing and arms nothing", async () => {
    const storage = new AlarmStorage();
    expect(await watchJob(storage, workflow() as never, deps().d)).toBe("none");
    await storage.put(RUN_KEY, RUN);
    expect(await watchJob(storage, undefined, deps().d)).toBe("none");
    expect(storage.alarm).toBeNull();
  });

  it("arming keeps a sooner alarm", async () => {
    const storage = new AlarmStorage();
    await storage.setAlarm(NOW + 5);
    await armJobWatch(storage, NOW);
    expect(storage.alarm).toBe(NOW + 5);
  });
});
