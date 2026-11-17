/**
 * What follows a job's part is the config's Part end node (`jobPartEnd.ts`; Dev2, 2026-11-17, "jobs as config").
 *
 * Sabotage (temporary local edits, reverted):
 *  - `partEndChoice` ignoring the gateway's answer: "the gateway's choice is the one runJob follows" fails;
 *  - `choiceOf` taking any object: "a malformed answer falls back to the same rule" fails;
 *  - runJob's carry ignoring `choice.to`: "a node that says end ends the job" fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { bundledLimits, choiceOf, partEndChoice } from "./jobPartEnd";
import { runJob, type JobDeps } from "./jobRun";
import { RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const INPUT = { cause: "steps_out" as const, part: 1, startedAt: NOW, now: NOW, machine: false, hasDraft: false, idle: false, wasIdle: false };

afterEach(() => vi.restoreAllMocks());

describe("the Part end node's choice", () => {
  it("is the gateway's when it answers one", async () => {
    const choice = await partEndChoice(INPUT, async () => ({ to: "end", ended: "stuck", cause: "steps_out", room: true }));
    expect(choice).toEqual({ to: "end", ended: "stuck", cause: "steps_out", room: true });
  });

  it("a malformed answer, or none, falls back to the same rule", async () => {
    expect(choiceOf({ to: "jump", cause: "x", room: true })).toBeNull();
    expect(choiceOf(null)).toBeNull();
    expect((await partEndChoice(INPUT, async () => ({ to: "jump" }))).to).toBe("carry");
    expect((await partEndChoice(INPUT, async () => Promise.reject(new Error("down")))).to).toBe("carry");
  });

  it("reads its limits from the bundled config's node, or none while it is on the shelf", () => {
    expect(bundledLimits({ nodes: [{ id: "partEnd", limits: { parts: 3 } }] })).toEqual({ parts: 3 });
    expect(bundledLimits({ nodes: [] })).toBeNull();
  });
});

describe("runJob follows the node", () => {
  const RUN: JobRun = {
    id: "job-1234-abcd",
    inbox: "+15555550100",
    title: "Research",
    brief: "Five competitors.",
    origin: { kind: "phone", phone: "+15555550100", question: "research" },
    attempt: 1,
    tries: 0,
    startedAt: NOW,
  };

  function deps(partEnd: unknown) {
    const reports: JobUpdate[] = [];
    const asked: unknown[] = [];
    const d: JobDeps = {
      fetch: (async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "UTC" });
        if (path === "/agent/job/note") return Response.json({ ok: false, code: "no_note" });
        if (path === "/agent/job/part-end") {
          asked.push(JSON.parse(String(init?.body)));
          return Response.json(partEnd);
        }
        return Response.json({ answer: "Found three so far.", exhausted: true });
      }) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      now: () => NOW,
      report: async (_inbox, update) => (reports.push(update), true),
    };
    return { d, reports, asked };
  }

  it("a node that says carry starts the next part, and is asked with the part's facts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, RUN);
    const { d, asked } = deps({ to: "carry", cause: "steps_out", room: true });
    expect(await runJob(storage, d)).toEqual({ kind: "now" });
    expect(asked).toEqual([{ jobId: RUN.id, input: expect.objectContaining({ cause: "steps_out", part: 1, machine: false, hasDraft: false }) }]);
    expect((await storage.get<JobRun>(RUN_KEY))?.attempt).toBe(2);
  });

  it("a node that says end ends the job, though the old code would have carried it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, RUN);
    const { d, reports } = deps({ to: "end", ended: "stuck", cause: "steps_out", room: false });
    expect(await runJob(storage, d)).not.toEqual({ kind: "now" });
    expect(reports.at(-1)?.state).not.toBe("running");
  });
});
