/**
 * Background jobs (`jobs.ts`, `jobRun.ts`, `jobTexts.ts`): a long ask runs in
 * an object of its own, several at once, its status shown to every turn, and
 * its result texted under the ask, even when its first turn ran out of steps.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `startJobs` without the title check → "never starts the same job twice, nor a fourth".
 *  2. `runJob` delivering an exhausted answer at once → "carries on in a new turn when one ran out of steps".
 *  3. `jobUpdate` ignoring `sent` → "an update offered again repeats no text".
 *  4. `jobsFor` not passing `running` → "a texted turn is shown the chat's jobs and starts them".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { chatJobs, JOB_KEPT_MS, JOB_LINES, JOB_STALE_MS, MAX_JOB_ATTEMPTS, readStartedJobs, RUN_KEY, startJobs, type JobEntry, type JobRun, type JobUpdate } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";

const NOW = 1_000_000;
const PHONE = "+15555550100";

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Competitor research",
  brief: "Five competitors.",
  origin: { kind: "phone", phone: PHONE, question: "research our competitors and write it up" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

/** A gateway and control plane, answering each `/agent` call from `answers` in turn. */
function jobDeps(answers: Array<{ status?: number; body: Record<string, unknown> }>, extra: { linked?: boolean } = {}) {
  const asked: Array<Record<string, unknown>> = [];
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") {
        return Response.json(extra.linked === false ? { status: "unlinked" } : { status: "linked", accessToken: "t", timeZone: "America/New_York" });
      }
      if (path === "/agent") {
        asked.push(JSON.parse(String(init.body)));
        const next = answers.shift();
        if (!next) throw new Error("no answer left");
        return Response.json(next.body, { status: next.status ?? 200 });
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
  return { deps, asked, reports };
}

describe("background jobs", () => {
  it("reads the jobs a turn started strictly", () => {
    expect(readStartedJobs(undefined)).toEqual([]);
    expect(
      readStartedJobs([
        { title: "Research", brief: "Do it", doneWhen: "a note", tainted: true },
        { title: "", brief: "x" },
        { title: "No brief" },
        "junk",
      ]),
    ).toEqual([{ title: "Research", brief: "Do it", doneWhen: "a note", tainted: true }]);
  });

  it("never starts the same job twice, nor a fourth", async () => {
    const storage = new MemoryStorage();
    const spawned: JobRun[] = [];
    const context = {
      now: NOW,
      inbox: PHONE,
      origin: { kind: "phone" as const, phone: PHONE, question: "q" },
      place: { chatId: "chat_1", messageId: "m1" },
      spawn: async (_id: string, job: JobRun) => void spawned.push(job),
    };
    expect(await startJobs(storage, [{ title: "Competitor research", brief: "b" }, { title: "competitor  research!", brief: "b" }], context)).toBe(1);
    expect(await startJobs(storage, [{ title: "Trip plan", brief: "b" }, { title: "Gift ideas", brief: "b" }, { title: "Fourth one", brief: "b" }], context)).toBe(2);
    expect(spawned.map((job) => job.title)).toEqual(["Competitor research", "Trip plan", "Gift ideas"]);
    expect(spawned[0]).toMatchObject({ inbox: PHONE, attempt: 1, origin: { kind: "phone", question: "q" } });
    const listed = await chatJobs(storage, NOW);
    expect(listed).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toContain("chat_1");

    const failing = { ...context, spawn: async () => Promise.reject(new Error("no")) };
    const other = new MemoryStorage();
    expect(await startJobs(other, [{ title: "x y", brief: "b" }], failing)).toBe(0);
    expect(await chatJobs(other, NOW)).toEqual([]);
  });

  it("forgets finished jobs after a while, and marks one that died as stopped", async () => {
    const storage = new MemoryStorage();
    const entry = (id: string, more: Partial<JobEntry>): JobEntry => ({ id, title: id, state: "running", startedAt: NOW, ...more });
    await storage.put("job:done-old-1", entry("done-old-1", { state: "done", finishedAt: NOW - JOB_KEPT_MS - 1 }));
    await storage.put("job:done-new-1", entry("done-new-1", { state: "done", finishedAt: NOW - 60_000 }));
    await storage.put("job:dead-run-1", entry("dead-run-1", { startedAt: NOW - JOB_STALE_MS - 1 }));
    await storage.put("job:live-run-1", entry("live-run-1", {}));
    const listed = await chatJobs(storage, NOW);
    expect(listed.map((job) => [job.id, job.state])).toEqual([
      ["live-run-1", "running"],
      ["done-new-1", "done"],
      ["dead-run-1", "failed"],
    ]);
    expect(storage.data.has("job:done-old-1")).toBe(false);
  });

  it("runs a phone job on the person's own words and reports the answer", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    expect(storage.alarms).toEqual([NOW]);
    const { deps, asked, reports } = jobDeps([{ body: { answer: "Done: wrote 1-projects/tex/competitors.md.\n\nNotion leads." } }]);
    await runJob(storage, deps);
    expect(asked[0]).toMatchObject({ question: "research our competitors and write it up", conversation: "texts", job: { id: "job-1234-abcd", title: "Competitor research", brief: "Five competitors.", attempt: 1 } });
    expect(asked[0].running).toBeUndefined();
    expect(reports.at(-1)).toMatchObject({ state: "done", status: "Done: wrote 1-projects/tex/competitors.md.", first: 0 });
    expect(reports.at(-1)?.texts?.join(" ")).toContain("Notion leads.");
    expect(storage.data.has(RUN_KEY)).toBe(false);
  });

  it("a job's turn that texted a link to save a login has its chat watch for the save (`vaultWatch.ts`)", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, reports } = jobDeps([{ body: { answer: "Saved the link for you to fill in.", vaultWatch: true, exhausted: true } }, { body: { answer: "Done." } }]);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "running", vaultWatch: PHONE });
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "done" });
    expect(reports.at(-1)?.vaultWatch).toBeUndefined();
  });

  it("carries on in a new turn when one ran out of steps", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, reports } = jobDeps([
      { body: { answer: "Found three so far.", exhausted: true } },
      { body: { answer: "Still more.", exhausted: true } },
      { body: { answer: "Wrote the note with what I have.", exhausted: true } },
    ]);
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i += 1) await runJob(storage, deps);
    expect(asked.map((body) => (body.job as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect(reports.filter((update) => update.texts).map((update) => update.texts)).toEqual([["Wrote the note with what I have."]]);
    expect(reports.at(-1)?.state).toBe("done");
    expect(storage.data.has(RUN_KEY)).toBe(false);
  });

  it("tries a turn that could not start again later, then says it couldn't finish", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const busy = { status: 503, body: { error: "model_unavailable" } };
    const { deps, reports } = jobDeps([busy, busy, busy]);
    await runJob(storage, deps);
    expect(storage.alarms.at(-1)).toBeGreaterThan(NOW);
    await runJob(storage, deps);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "failed", texts: [JOB_LINES.failed("Competitor research")] });
  });

  it("ends silently for a phone that was unlinked meanwhile", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, reports } = jobDeps([], { linked: false });
    await runJob(storage, deps);
    expect(asked).toEqual([]);
    expect(reports).toEqual([{ id: "job-1234-abcd", state: "failed", first: 0 }]);
  });

  it("texts the result under the ask it came from, and an update offered again repeats no text", async () => {
    const storage = new MemoryStorage();
    await startJobs(storage, [{ title: "Competitor research", brief: "b" }], {
      now: NOW,
      inbox: PHONE,
      origin: { kind: "phone", phone: PHONE, question: "q" },
      place: { chatId: "chat_1", messageId: "m_ask" },
      spawn: async () => {},
    });
    const [id] = (await chatJobs(storage, NOW)).map((job) => job.id);
    const sent: Array<{ text: string; key: string }> = [];
    const deps = {
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sent.push({ text: body.message.parts[0].value, key: body.message.idempotency_key });
        return new Response("{}", { status: 200 });
      }) as unknown as Fetch,
      linqApiKey: "k",
      controlPlaneOrigin: "",
      workerSecret: "",
      gatewayOrigin: "",
      now: () => NOW + 1,
    };
    const update: JobUpdate = { id, state: "done", status: "Wrote it.", texts: ["Wrote it.", "https://context.lc/n/abc"], first: 0 };
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(sent.map((entry) => entry.text)).toEqual(["Wrote it.", "https://context.lc/n/abc"]);
    expect(sent[0].key).toBe(`job:${id}:0`);
    const [listed] = await chatJobs(storage, NOW + 1);
    expect(listed).toMatchObject({ state: "done", status: "Wrote it.", finishedAt: NOW + 1 });
    expect(await jobUpdate(storage, deps, { id: "someone-elses", state: "done" })).toBe(false);
  });

  it("a texted turn is shown the chat's jobs and starts them", async () => {
    const storage = new MemoryStorage();
    await storage.put<JobEntry>("job:running-job-1", { id: "running-job-1", title: "Trip plan", state: "running", startedAt: NOW - 60_000, status: "Comparing hotels" });
    const message: Message = { kind: "message", eventId: "e1", chatId: "chat_1", from: PHONE, messageId: "m_e1", text: "research our competitors" };
    await accept(storage, { ...message, quoted: "x" }, NOW);
    const bodies: Array<Record<string, unknown>> = [];
    const spawned: Array<[string, JobRun]> = [];
    const deps: InboxDeps = {
      fetch: (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
        if (path === "/agent") {
          bodies.push(JSON.parse(String(init.body)));
          return Response.json({ answer: "On it, I'll text you when it's done.", jobs: [{ title: "Competitor research", brief: "Five." }] });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "k",
      now: () => NOW,
      spawnJob: async (id, job) => void spawned.push([id, job]),
    };
    await drain(storage, deps);
    expect(bodies[0].running).toEqual([{ id: "running-job-1", title: "Trip plan", state: "running", startedAt: NOW - 60_000, status: "Comparing hotels" }]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0][1]).toMatchObject({ title: "Competitor research", inbox: PHONE, origin: { kind: "phone", phone: PHONE, question: "research our competitors" } });
    const entry = await storage.get<JobEntry>(`job:${spawned[0][0]}`);
    expect(entry).toMatchObject({ chatId: "chat_1", messageId: "m_e1", state: "running" });
    expect(JSON.stringify(entry)).not.toContain("research our competitors");
  });
});
