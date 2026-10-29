/**
 * One job, one result (`jobRun.ts` `PASS_KEY`, `jobs.ts` `finalPass`).
 *
 * Tex Devs, 2026-10-29 17:44–17:55 UTC: a background job's Durable Object was
 * reset mid-pass ("this Durable Object instance is no longer active"), its
 * workflow retried the step, and two turns of the same job ran side by side.
 * The first texted "I couldn't save the page update" with a bug report, the
 * second, which had re-armed the finished job, texted "The save went through
 * after all". Each pass now takes the job's lease; a pass overtaken by another
 * says and stores nothing, and the chat's inbox texts one finishing word per job.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `runJob` without the lease check after the turn → "a pass overtaken by a newer one texts nothing and re-arms nothing".
 *  2. `noteJobUpdate` without the `finalPass` check → "the chat texts one result per job: a second pass's is dropped, the same pass's retry is not".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, PASS_KEY, runJob, type JobDeps } from "./jobRun";
import { chatJobs, RUN_KEY, startJobs, type JobRun, type JobUpdate } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Agentic benchmarks",
  brief: "Compare three models.",
  origin: { kind: "phone", phone: PHONE, question: "compare these models for agent work" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

/** A gateway whose `/agent` answers are functions, so one turn can let another pass run while it is still going. */
function jobDeps(answers: Array<() => Promise<Record<string, unknown>>>) {
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "America/New_York" });
      if (path === "/agent") {
        const next = answers.shift();
        if (!next) throw new Error("no answer left");
        return Response.json(await next());
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async (_inbox, update) => {
      reports.push(update);
      return true;
    },
  };
  return { deps, reports };
}

describe("one result per background job", () => {
  it("a pass overtaken by a newer one texts nothing and re-arms nothing", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    let retried: Promise<unknown> = Promise.resolve();
    const { deps, reports } = jobDeps([
      // The first pass's turn is still running when its step is retried: the retry's turn saves and finishes first.
      async () => {
        retried = runJob(storage, deps);
        await retried;
        return { answer: "I couldn't save the page update. Here's the bug report I'd send.", exhausted: true };
      },
      async () => ({ answer: "None of the three beat Haiku. https://context.lc/note/@team/models.page.md" }),
    ]);
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    await retried;
    const texted = reports.filter((update) => update.texts);
    expect(texted.map((update) => update.texts)).toEqual([["None of the three beat Haiku. https://context.lc/note/@team/models.page.md"]]);
    expect(reports.filter((update) => update.state !== "running")).toHaveLength(1);
    // Finished stays finished: the overtaken pass never writes the run back for another part.
    expect(storage.data.has(RUN_KEY)).toBe(false);
    expect(storage.data.has(PASS_KEY)).toBe(false);
  });

  it("a pass that still holds the job reports as before", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, reports } = jobDeps([async () => ({ answer: "Saved it." })]);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Saved it."], pass: expect.any(String) });
  });

  it("the chat texts one result per job: a second pass's is dropped, the same pass's retry is not", async () => {
    const storage = new MemoryStorage();
    await startJobs(storage, [{ title: "Agentic benchmarks", brief: "b" }], {
      now: NOW,
      inbox: PHONE,
      origin: { kind: "phone", phone: PHONE, question: "q" },
      place: { chatId: "chat_1", messageId: "m_ask" },
      spawn: async () => {},
    });
    const [id] = (await chatJobs(storage, NOW)).map((job) => job.id);
    const sent: string[] = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)).message.parts[0].value);
        return new Response("{}", { status: 200 });
      }) as unknown as Fetch,
      linqApiKey: "k",
      controlPlaneOrigin: "",
      workerSecret: "",
      gatewayOrigin: "",
      now: () => NOW + 1,
    };
    const first: JobUpdate = { id, pass: "pass-aaaaaaaa", state: "done", status: "Couldn't save.", texts: ["I couldn't save the page."], first: 0 };
    expect(await jobUpdate(storage, deps, first)).toBe(true);
    // The same pass offering its last word again (the inbox's answer was lost) repeats nothing and is not refused.
    expect(await jobUpdate(storage, deps, first)).toBe(true);
    // Another pass of the same job, finishing later, is not texted, and its steps don't reopen the job.
    expect(await jobUpdate(storage, deps, { id, pass: "pass-bbbbbbbb", state: "running", step: "write_note" })).toBe(true);
    expect(await jobUpdate(storage, deps, { id, pass: "pass-bbbbbbbb", state: "done", status: "Saved after all.", texts: ["The save went through after all."], first: 0 })).toBe(true);
    expect(sent).toEqual(["I couldn't save the page."]);
    const [listed] = await chatJobs(storage, NOW + 1);
    expect(listed).toMatchObject({ state: "done", status: "Couldn't save." });
  });
});
