/**
 * A background job's part goes on from saved rounds (Dev2, 2026-11-17: "jobs must be reliable"; `jobResume.ts`, the
 * gateway's `apps/mcp/src/agent/turnResume.js`). The Worker only names the part to go on from; the rounds stay in
 * the chat's own home, never here.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `resumePlan` ignoring `resumedTry` → "the mark is on the run before the ask" (a dead pass would carry again).
 *  2. `carryPatch` setting `carryFrom` on any broken part → "a part that ran out of check rounds ... start fresh".
 *  3. `runJob` not writing the mark before the ask → "the mark is on the run before the ask".
 */
import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { carryPatch, resumePlan } from "./jobResume";
import { RUN_KEY, type JobRun } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const RUN: JobRun = { id: "job-1234-abcd", inbox: PHONE, title: "Timecards", brief: "Check this week's timecards.", origin: { kind: "phone", phone: PHONE, question: "check the timecards" }, attempt: 1, tries: 0, startedAt: NOW };

/** A gateway streaming each `/agent` call's lines as given; `seen` gets the run as stored when each ask arrives. */
function jobDeps(parts: unknown[][], storage: MemoryStorage) {
  const asked: Array<Record<string, any>> = [];
  const seen: Array<JobRun | undefined> = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "job_token" });
      if (path === "/agent/job/note") return Response.json({ ok: false, code: "no_note" });
      if (path === "/agent") {
        asked.push(JSON.parse(String(init.body)));
        seen.push(await storage.get<JobRun>(RUN_KEY));
        const lines = parts.shift();
        if (!lines) throw new Error("no answer left");
        return new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async () => true,
  };
  return { deps, asked, seen };
}

const CRASH = [{ step: "Searched mail for timecards", result: "2 emails" }, { tick: 1 }];
const DONE = [{ status: 200, body: { answer: "Done." } }];
const DOWN = [{ step: "Searched mail", result: "2 emails" }, { status: 502, body: { error: "model_unavailable" } }];

describe("a job's part goes on from saved rounds", () => {
  it("a part cut off before it answered: the next part goes on from it, and a part that answered names none", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked } = jobDeps([CRASH, DONE], storage);
    await runJob(storage, deps);
    expect((await storage.get<JobRun>(RUN_KEY))).toMatchObject({ attempt: 2, carryFrom: 1 });
    await runJob(storage, deps);
    expect(asked[0].job.resumeFrom).toBeUndefined();
    expect(asked[1].job).toMatchObject({ attempt: 2, resumeFrom: 1 });
  });

  it("the same part tried again goes on from its own try", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked } = jobDeps([DOWN, DONE], storage);
    await runJob(storage, deps);
    await runJob(storage, deps);
    expect(asked[1].job).toMatchObject({ attempt: 1, resumeFrom: 1 });
  });

  it("a try handed saved rounds that died is followed by a fresh one, never the same rounds twice in a row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked } = jobDeps([CRASH, CRASH, DONE], storage);
    await runJob(storage, deps); // part 1 cut off
    await runJob(storage, deps); // part 2 goes on from part 1, and is cut off too
    expect(asked[1].job.resumeFrom).toBe(1);
    expect((await storage.get<JobRun>(RUN_KEY))?.carryFrom).toBeUndefined();
    await runJob(storage, deps); // part 3 starts fresh
    expect(asked[2].job).toMatchObject({ attempt: 3 });
    expect(asked[2].job.resumeFrom).toBeUndefined();
  });

  it("the mark is on the run before the ask, so a pass whose object dies mid-part is followed by a fresh try", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, { ...RUN, attempt: 2, carryFrom: 1 }, NOW);
    const { deps, seen } = jobDeps([DONE], storage);
    await runJob(storage, deps);
    expect(seen[0]?.resumedTry).toBe(2);
    // The object died mid-part: its saved progress is left over, and the mark says that try was handed saved rounds.
    const run: JobRun = { ...RUN, attempt: 2, resumedTry: 2 };
    expect(resumePlan(run, true)).toEqual({ ask: {}, changed: true });
    expect(run.resumedTry).toBeUndefined();
    // A pass that died on a fresh try goes on from that try's rounds.
    expect(resumePlan({ ...RUN, attempt: 2 }, true).ask).toEqual({ resumeFrom: 2 });
  });

  it("a part that ran out of check rounds, a part on their computer, and a restarted job start fresh", async () => {
    expect(carryPatch(RUN, { kind: "broken", cause: "check_limit" })).toEqual({});
    expect(carryPatch(RUN, { kind: "broken", cause: "timeout" })).toEqual({ carryFrom: 1 });
    expect(carryPatch({ ...RUN, advice: "Open the payroll tab first." }, { kind: "broken", cause: "crash" })).toEqual({ carryFrom: 1, advice: "Open the payroll tab first." });
    expect(carryPatch({ ...RUN, machine: { id: "m1" } as unknown as JobRun["machine"] }, { kind: "broken", cause: "crash" })).toEqual({});
    expect(resumePlan({ ...RUN, attempt: 2, tries: 1, machine: { id: "m1" } as unknown as JobRun["machine"] }, true).ask).toEqual({});
    // `resumeJob` starts again at part 1: an old run's carryFrom names no part before it. The gateway's key holds the restart.
    expect(resumePlan({ ...RUN, attempt: 1, carryFrom: 3, resumes: 1 }, false).ask).toEqual({ resumes: 1 });
    expect(resumePlan({ ...RUN, attempt: 1, tries: 1, resumes: 2 }, false).ask).toEqual({ resumes: 2, resumeFrom: 1 });
  });
});
