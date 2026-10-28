/**
 * A background job seen through by its own Workflow instance (`jobWorkflow.ts`,
 * Dev2, 2026-10-28). Workflows itself never runs here: `step` is a stand-in
 * that runs each step inline and honours its retry limit.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `startJobFlow` treating "already exists" as a failure: "the same job
 *    started twice runs once" fails;
 *  - `runJobFlow` without its catch around a pass: "a pass that keeps failing
 *    is retried, then the job ends with its couldn't-finish line" fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { ANSWER_RETRIES } from "./groupTurnWorkflow";
import { acceptJob, armJobNext, failJob, runJob, type JobDeps, type JobNext } from "./jobRun";
import { JOB_LINES, RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { handOverJob, jobInstanceId, runJobFlow, startJobFlow, type JobCall } from "./jobWorkflow";
import { MemoryStorage } from "./memoryStorage.testing";

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

function deps(answers: Array<{ status?: number; body: Record<string, unknown> }>) {
  const reports: JobUpdate[] = [];
  const d: JobDeps = {
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "UTC" });
      const next = answers.shift();
      if (!next) throw new Error("no answer left");
      return Response.json(next.body, { status: next.status ?? 200 });
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async (_inbox, update) => (reports.push(update), true),
  };
  return { d, reports };
}

/** Workflows' step, inline: a throwing step is run again up to its retry limit. */
function fakeStep() {
  const runs: string[] = [];
  const sleeps: number[] = [];
  return {
    runs,
    sleeps,
    step: {
      do: (async (name: string, a: unknown, b?: unknown) => {
        const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
        const limit = typeof a === "object" && a !== null ? ((a as { retries?: { limit: number } }).retries?.limit ?? 0) : 0;
        for (let attempt = 0; ; attempt += 1) {
          runs.push(name);
          try {
            return await fn();
          } catch (error) {
            if (attempt >= limit) throw error;
          }
        }
      }) as never,
      sleep: (async (_name: string, ms: number) => void sleeps.push(ms)) as never,
    },
  };
}

/** The job's object as its workflow reaches it. */
function objectCall(storage: MemoryStorage, d: JobDeps, broken = false): JobCall {
  return async (path) => {
    if (broken && path === "/job-pass") return new Response("down", { status: 500 });
    const next: JobNext = path === "/job-pass" ? await runJob(storage, d) : await failJob(storage, d);
    return Response.json({ next });
  };
}

afterEach(() => vi.restoreAllMocks());

describe("a background job's workflow", () => {
  it("runs every pass through the instance, waits between them there, and never sets the object's alarm", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    const started: string[] = [];
    await acceptJob(storage, RUN, NOW, async () => void started.push(jobInstanceId(RUN.id)));
    const busy = { status: 503, body: { error: "model_unavailable" } };
    const { d, reports } = deps([busy, { body: { answer: "Found three so far.", exhausted: true } }, { body: { answer: "Wrote the note." } }]);
    const { step, sleeps } = fakeStep();
    expect(await runJobFlow(step, objectCall(storage, d))).toBe("done");
    expect(started).toEqual(["job-job-1234-abcd"]);
    expect(storage.alarms).toEqual([]);
    expect(sleeps).toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Wrote the note."] });
    expect(storage.data.has(RUN_KEY)).toBe(false);
    const lines = logs.mock.calls.flat().map((line) => JSON.parse(String(line))).filter((line) => line.kind === "job");
    expect(lines).toEqual([{ event: "group_turn", outcome: "workflow_answered", kind: "job", attempts: 3 }]);
  });

  it("a pass that keeps failing is retried, then the job ends with its couldn't-finish line", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW, async () => {});
    const { d, reports } = deps([]);
    const { step, runs } = fakeStep();
    expect(await runJobFlow(step, objectCall(storage, d, true))).toBe("failed");
    expect(runs.filter((name) => name === "pass 0")).toHaveLength(1 + ANSWER_RETRIES.limit);
    expect(reports).toEqual([expect.objectContaining({ state: "failed", texts: [JOB_LINES.failed(RUN.title)] })]);
    expect(storage.data.has(RUN_KEY)).toBe(false);
  });

  it("the same job started twice runs once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const created: string[] = [];
    const workflow = {
      create: async ({ id }: { id: string }) => {
        if (created.includes(id)) throw new Error("instance already exists");
        created.push(id);
        return {} as never;
      },
      get: async (id: string) => {
        if (!created.includes(id)) throw new Error("not found");
        return {} as never;
      },
    };
    await startJobFlow(workflow as never, RUN.id);
    await startJobFlow(workflow as never, RUN.id);
    expect(created).toEqual(["job-job-1234-abcd"]);
  });

  it("without a workflow (self-hosted, no Workflows), the alarm drives each pass as before", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    expect(storage.alarms).toEqual([NOW]);
    await armJobNext(storage, { kind: "after", ms: 20_000 }, NOW);
    await armJobNext(storage, { kind: "done" }, NOW);
    expect(storage.alarms).toEqual([NOW, NOW + 20_000]);
  });

  it("a job armed before workflows ran it is handed to its instance by its old alarm", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const alarmsBefore = storage.alarms.length;
    const created: string[] = [];
    const workflow = { create: async ({ id }: { id: string }) => (created.push(id), {} as never), get: async () => ({}) as never };
    expect(await handOverJob(storage, workflow as never)).toBe(true);
    expect(created).toEqual(["job-job-1234-abcd"]);
    expect(storage.alarms).toHaveLength(alarmsBefore);
    expect(await handOverJob(new MemoryStorage(), workflow as never)).toBe(false);
  });
});
