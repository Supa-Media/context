/**
 * Steering, stopping and auditing a running background job (`jobRun.ts`,
 * `jobs.ts`; owner, 2026-10-21: "steering already running jobs, auditing it").
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `jobsFor`'s `onSteers` handing over the model's words instead of the text's
 *     → "a later text reaches the running job in the person's own words".
 *  2. `steerJob` not sending into the live turn → "a text sent while the job's turn runs is sent into it".
 *  3. `runJob` texting an answer that missed a later text → "a change that came after the turn's last look gets a turn of its own".
 *  4. `runJob` ignoring `STOP_KEY` after the turn → "a stopped job texts nothing more and runs no further turn".
 *  5. `noteJobUpdate` dropping `step` → "each step is kept for the chat, the last few only".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { drain, accept, type InboxDeps } from "./inbox";
import { acceptJob, runJob, steerJob, STEERS_KEY, STOP_KEY, type JobDeps } from "./jobRun";
import { chatJobs, JOB_LINES, MAX_STEPS_KEPT, noteJobUpdate, readSteers, RUN_KEY, steerJobs, type JobEntry, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";

const NOW = 1_000_000;
const PHONE = "+15555550100";

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Logo",
  brief: "A green logo.",
  origin: { kind: "phone", phone: PHONE, question: "make me a green logo" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

type Answer = { body: Record<string, unknown>; during?: () => Promise<void>; steps?: string[] };

/** A gateway answering each `/agent` call in turn; `during` runs while that call is open, as a text arriving would. */
function jobDeps(answers: Answer[]) {
  const asked: Array<Record<string, unknown>> = [];
  const steered: Array<{ token: string | null; body: Record<string, unknown> }> = [];
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "job_token" });
      if (path === "/agent/steer") {
        steered.push({ token: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
        return Response.json({ queued: true });
      }
      if (path === "/agent") {
        asked.push(JSON.parse(String(init.body)));
        const next = answers.shift();
        if (!next) throw new Error("no answer left");
        await next.during?.();
        if (!next.steps) return Response.json(next.body);
        const lines = [...next.steps.map((step) => ({ step })), { status: 200, body: next.body }].map((line) => JSON.stringify(line)).join("\n");
        return new Response(`${lines}\n`, { headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async (_inbox, update) => (reports.push(update), true),
  };
  return { deps, asked, steered, reports };
}

const yellow: JobSteer = { id: "e2", text: "never mind, make it yellow not green" };

describe("steering a running job", () => {
  it("a later text reaches the running job in the person's own words", async () => {
    const storage = new MemoryStorage();
    await storage.put<JobEntry>("job:job-1234-abcd", { id: "job-1234-abcd", title: "Logo", state: "running", startedAt: NOW - 60_000, chatId: "chat_1" });
    await storage.put<JobEntry>("job:job-done-0001", { id: "job-done-0001", title: "Trip", state: "done", startedAt: NOW - 60_000, finishedAt: NOW });
    const message: Message = { kind: "message", eventId: "e2", chatId: "chat_1", from: PHONE, messageId: "m_e2", text: yellow.text };
    await accept(storage, message, NOW);
    const sent: Array<[string, JobSteer]> = [];
    const deps: InboxDeps = {
      fetch: (async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
        if (path === "/agent") {
          // The model names jobs; it never writes what they are handed.
          return Response.json({ answer: "Passed it on.", steers: [{ id: "job-1234-abcd" }, { id: "job-done-0001" }, { id: "not-this-chats-1" }] });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "k",
      now: () => NOW,
      spawnJob: async () => {},
      steerJob: async (id, steer) => (sent.push([id, steer]), true),
    };
    await drain(storage, deps);
    expect(sent).toEqual([["job-1234-abcd", yellow]]);
  });

  it("reads what a turn asked of its jobs strictly", () => {
    expect(readSteers([{ id: "job-1234-abcd", stop: true }, { id: "job-5678-abcd", stop: "yes" }, { id: "../x" }, "junk"])).toEqual([
      { id: "job-1234-abcd", stop: true },
      { id: "job-5678-abcd" },
    ]);
  });

  it("a text sent while the job's turn runs is sent into it, with the job's own grant", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, steered, reports } = jobDeps([
      { body: { answer: "Made it yellow: 1-projects/logo.md", steered: ["e2"] }, during: async () => void (await steerJob(storage, yellow)) },
    ]);
    await runJob(storage, deps);
    expect(steered).toEqual([{ token: "Bearer job_token", body: { turn: asked[0].turn, ...yellow } }]);
    expect(typeof asked[0].turn).toBe("string");
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Made it yellow: 1-projects/logo.md"] });
    expect(storage.data.has(STEERS_KEY)).toBe(false);
    expect(await steerJob(storage, yellow)).toBe(false); // ended: the chat's turn answers it itself
  });

  it("a change that came after the turn's last look gets a turn of its own", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, reports } = jobDeps([
      // The turn never took it in (no `steered`): its green answer is not texted.
      { body: { answer: "Made a green logo." }, during: async () => void (await steerJob(storage, yellow)) },
      { body: { answer: "Made it yellow." } },
    ]);
    await runJob(storage, deps);
    expect(reports.some((update) => update.texts?.includes("Made a green logo."))).toBe(false);
    expect(reports.at(-1)).toMatchObject({ state: "running", status: "Changing it to what you texted" });
    await runJob(storage, deps);
    // The green answer it replaces is handed on, so the yellow one builds on it and is the one result texted.
    expect(asked[1].job).toMatchObject({ attempt: 2, followUps: [yellow.text], draft: "Made a green logo." });
    expect(asked[1].question).toBe("make me a green logo");
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Made it yellow."] });
  });

  it("says so when the change came after its last turn", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ attempt: 3 }), NOW);
    const { deps, reports } = jobDeps([{ body: { answer: "Made a green logo." }, during: async () => void (await steerJob(storage, yellow)) }]);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Made a green logo.", JOB_LINES.missed] });
  });
});

describe("stopping a running job", () => {
  it("a stopped job texts nothing more and runs no further turn", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const stop: JobSteer = { id: "e3", text: "stop the logo", stop: true };
    const { deps, asked, steered, reports } = jobDeps([
      { body: { answer: "Stopped. I had a draft in 1-projects/logo.md.", exhausted: true }, during: async () => void (await steerJob(storage, stop)) },
    ]);
    await runJob(storage, deps);
    expect(steered[0].body).toMatchObject({ text: "stop the logo", stop: true }); // its turn winds up at its next step
    expect(asked).toHaveLength(1);
    expect(reports.at(-1)).toEqual({ id: "job-1234-abcd", state: "failed", status: "Stopped", first: 0 });
    expect(storage.data.has(RUN_KEY)).toBe(false);
    expect(storage.data.has(STOP_KEY)).toBe(false);
  });

  it("one stopped between turns ends without another", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ attempt: 2 }), NOW);
    await steerJob(storage, { id: "e3", text: "cancel that", stop: true });
    const { deps, asked, reports } = jobDeps([]);
    await runJob(storage, deps);
    expect(asked).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ state: "failed", status: "Stopped" });
  });

  it("the chat shows it stopped at once, and anything it says on its way out is not texted", async () => {
    const storage = new MemoryStorage();
    await storage.put<JobEntry>("job:job-1234-abcd", { id: "job-1234-abcd", title: "Logo", state: "running", startedAt: NOW, chatId: "chat_1" });
    expect(await steerJobs(storage, [{ id: "job-1234-abcd", stop: true }], { id: "e3", text: "stop" }, async () => true, NOW + 5)).toBe(1);
    expect((await chatJobs(storage, NOW + 5))[0]).toMatchObject({ state: "failed", status: "Stopped when they asked" });
    const known = await jobUpdate(
      storage,
      { fetch: (async () => Response.json({})) as unknown as Fetch, linqApiKey: "k", now: () => NOW, controlPlaneOrigin: "", workerSecret: "", gatewayOrigin: "", sendblue: null },
      { id: "job-1234-abcd", state: "done", texts: ["Here is the green logo."] },
    );
    expect(known).toBe(true);
    expect((await storage.get<JobEntry>("job:job-1234-abcd"))?.state).toBe("failed");
  });
});

describe("auditing a running job", () => {
  it("each step is kept for the chat, the last few only", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const steps = ["search_notes: logo colours", "read_note: 1-projects/brand.md", "write_note: 1-projects/logo.md", "open_page: https://example.com", "write_note: 1-projects/logo.md", "search_web: yellow"];
    const { deps, reports } = jobDeps([{ body: { answer: "Done." }, steps }]);
    await runJob(storage, deps);
    expect(reports.filter((update) => update.step).map((update) => update.step)).toEqual(steps);

    const inbox = new MemoryStorage();
    await inbox.put<JobEntry>("job:job-1234-abcd", { id: "job-1234-abcd", title: "Logo", state: "running", startedAt: NOW, chatId: "chat_1" });
    for (const [i, step] of steps.entries()) await noteJobUpdate(inbox, { id: "job-1234-abcd", state: "running", step }, NOW + i);
    const [shown] = await chatJobs(inbox, NOW + 10);
    expect(shown.steps?.map((step) => step.text)).toEqual(steps.slice(-MAX_STEPS_KEPT));
    expect(shown.steps?.at(-1)).toEqual({ at: NOW + 5, text: "search_web: yellow" });
  });
});
