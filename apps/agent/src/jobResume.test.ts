/**
 * "Restart it" picks an ended job back up where it stopped (`jobRun.ts`
 * `resumeJob`, `jobs.ts` `resumeJobs`), and a job whose parts do no work ends
 * instead of spending more (Dev2, 2026-10-31: three restarted jobs answered
 * "it's running again" eight times each, from the restart text).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `finish` keeping no run for an unfinished job → "a stuck job picks back up on its own task, with what it had got to".
 *  2. `resumeJob` ignoring `JOB_SHOWN_MS` → "nothing to pick up after two hours, or after it finished".
 *  3. `runJob` without the repeat guard → "two parts in a row with no tool call end the job stuck".
 *  4. `resumeJobs` past the running limit → "the chat picks up only this chat's ended jobs, within the limit".
 *  5. `readSteers` dropping `resume` → "the chat picks up only this chat's ended jobs, within the limit".
 *  6. `resumeJob` not keeping the restart's text → "a restart's own words reach the job it picks up".
 *  7. `resumeJobs` sending the placeholder over their words → "the chat's restart hands the job their words".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, ENDED_KEY, resumeJob, runJob, type JobDeps } from "./jobRun";
import { chatJobs, JOB_SHOWN_MS, notResumedText, PICKED_UP, readSteers, resumeJobs, RUN_KEY, startJobs, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "YC application",
  brief: "Fill in the YC application from my notes.",
  doneWhen: "the application is submitted",
  origin: { kind: "phone", phone: PHONE, question: "apply to YC for Tex" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

function jobDeps(answers: Array<{ status?: number; body: Record<string, unknown> }>, now = NOW) {
  const asked: Array<Record<string, unknown>> = [];
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "America/New_York" });
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
    now: () => now,
    report: async (_inbox, update) => {
      reports.push(update);
      return true;
    },
  };
  return { deps, asked, reports };
}

describe("picking an ended job back up", () => {
  it("a stuck job picks back up on its own task, with what it had got to", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ startedAt: NOW - 31 * 60_000 }), NOW);
    const first = jobDeps([{ body: { answer: "Filled page one.", unfinished: true, verdict: "keep_going", advice: "Fill page two." } }]);
    await runJob(storage, first.deps);
    expect(first.reports.at(-1)).toMatchObject({ state: "stuck" });
    expect(storage.data.has(RUN_KEY)).toBe(false);
    expect(storage.alarms.at(-1)).toBeGreaterThan(NOW + JOB_SHOWN_MS);

    const started: Array<[string, number]> = [];
    expect(await resumeJob(storage, NOW + 60_000, async (id, resumes) => void started.push([id, resumes]))).toBe(true);
    expect(started).toEqual([["job-1234-abcd", 1]]);
    expect(storage.data.has(ENDED_KEY)).toBe(false);
    expect(await resumeJob(storage, NOW + 60_000)).toBe(false);

    const second = jobDeps([{ body: { answer: "Submitted it.", verdict: "done" } }], NOW + 60_000);
    await runJob(storage, second.deps);
    expect(second.asked[0]).toMatchObject({
      question: "apply to YC for Tex",
      job: { attempt: 1, brief: "Fill in the YC application from my notes.", doneWhen: "the application is submitted", draft: "Filled page one.", unfinished: true, advice: "Fill page two." },
    });
    expect(second.reports.at(-1)).toMatchObject({ state: "done", texts: ["Submitted it."] });
    expect(storage.data.has(ENDED_KEY)).toBe(false);
  });

  it("nothing to pick up after two hours, or after it finished", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ attempt: 10 }), NOW);
    await runJob(storage, jobDeps([{ body: { answer: "Short.", unfinished: true } }]).deps);
    expect(storage.data.has(ENDED_KEY)).toBe(true);
    expect(await resumeJob(storage, NOW + JOB_SHOWN_MS + 1)).toBe(false);
    await runJob(storage, jobDeps([], NOW + JOB_SHOWN_MS + 1).deps);
    expect(storage.data.has(ENDED_KEY)).toBe(false);

    const done = new MemoryStorage();
    await acceptJob(done, run(), NOW);
    await runJob(done, jobDeps([{ body: { answer: "Submitted.", verdict: "done" } }]).deps);
    expect(await resumeJob(done, NOW + 1)).toBe(false);
  });

  it("a computer job picked back up runs where the computer's settings say now, not where it first ran", async () => {
    // 2026-11-05: a GitHub sign-in restarted after its folder was cleared kept the old folder and was refused at once.
    const machine = { workspaceId: "ws_a", machineId: "mch_1", name: "dev2", tool: "claude" as const, folder: "/code", repo: "Supa-Media/context" };
    const storage = new MemoryStorage();
    await storage.put(ENDED_KEY, { run: run({ machine, machineSession: "sess_old" }), endedAt: NOW });
    const now = { ...machine, folder: "@work", repo: undefined };
    delete now.repo;
    expect(await resumeJob(storage, NOW + 60_000, undefined, { id: "e1", text: "try again", resume: true, machine: now })).toBe(true);
    const kept = await storage.get<JobRun>(RUN_KEY);
    expect(kept?.machine).toEqual({ ...machine, folder: "@work" });
    // A new folder is a new session there: Claude Code keeps its sessions per folder.
    expect(kept?.machineSession).toBeUndefined();
    // Another computer's settings never move a job.
    const other = new MemoryStorage();
    await other.put(ENDED_KEY, { run: run({ machine, machineSession: "sess_old" }), endedAt: NOW });
    await resumeJob(other, NOW + 60_000, undefined, { id: "e2", text: "again", resume: true, machine: { ...now, machineId: "mch_2" } });
    expect((await other.get<JobRun>(RUN_KEY))?.machine).toEqual(machine);
    expect((await other.get<JobRun>(RUN_KEY))?.machineSession).toBe("sess_old");
  });

  it("the gateway's restart carries the computer as it is now, read strictly", () => {
    const machine = { workspaceId: "ws_a", machineId: "mch_1", name: "dev2", tool: "claude", folder: "@work" };
    expect(readSteers([{ id: "c1667a96-c13d-4594-ad0a-28918542283f", resume: true, machine }])).toEqual([{ id: "c1667a96-c13d-4594-ad0a-28918542283f", resume: true, machine }]);
    expect(readSteers([{ id: "c1667a96-c13d-4594-ad0a-28918542283f", resume: true, machine: { ...machine, tool: "rm" } }])).toEqual([{ id: "c1667a96-c13d-4594-ad0a-28918542283f", resume: true }]);
  });

  it("the chat hands a restarted computer job the computer as it is now, and only that computer's", async () => {
    const storage = new MemoryStorage();
    const id = "c1667a96-c13d-4594-ad0a-28918542283f";
    await storage.put(`job:${id}`, { id, title: "Sign in", state: "failed", startedAt: NOW, finishedAt: NOW + 1, machine: true, on: "mch_1", onName: "dev2" });
    const steers: JobSteer[] = [];
    const send = async (_id: string, steer: JobSteer) => (steers.push(steer), true);
    const machine = { workspaceId: "ws_a", machineId: "mch_1", name: "dev2", tool: "claude" as const, folder: "@work" };
    await resumeJobs(storage, [{ id, resume: true, machine }], { id: "e1", text: "" }, send, NOW + 2);
    expect(steers[0]?.machine).toEqual(machine);
    await storage.put(`job:${id}`, { ...(await storage.get<object>(`job:${id}`)), state: "failed", finishedAt: NOW + 3 });
    await resumeJobs(storage, [{ id, resume: true, machine: { ...machine, machineId: "mch_2" } }], { id: "e2", text: "" }, send, NOW + 4);
    expect(steers[1]?.machine).toBeUndefined();
  });

  it("a restart's own words reach the job it picks up", async () => {
    // 2026-11-03: "book with santana, mens adult style cut" restarted a haircut job that never saw the barber or the cut.
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ attempt: 10, title: "Book the haircut" }), NOW);
    await runJob(storage, jobDeps([{ body: { answer: "Couldn't sign in.", unfinished: true } }]).deps);
    expect(await resumeJob(storage, NOW + 60_000, undefined, { id: "e1", text: "book with santana, mens adult style cut", resume: true })).toBe(true);
    const next = jobDeps([{ body: { answer: "Booked with Santana.", verdict: "done" } }], NOW + 60_000);
    await runJob(storage, next.deps);
    expect(next.asked[0]).toMatchObject({ job: { followUps: ["book with santana, mens adult style cut"] } });

    // A restart with no words of theirs (a turn by code) shows the job nothing new.
    const quiet = new MemoryStorage();
    await acceptJob(quiet, run({ attempt: 10 }), NOW);
    await runJob(quiet, jobDeps([{ body: { answer: "Short.", unfinished: true } }]).deps);
    expect(await resumeJob(quiet, NOW + 60_000, undefined, { id: "e2", text: PICKED_UP, resume: true })).toBe(true);
    const after = jobDeps([{ body: { answer: "Done.", verdict: "done" } }], NOW + 60_000);
    await runJob(quiet, after.deps);
    expect((after.asked[0]?.job as Record<string, unknown>)?.followUps).toBeUndefined();
  });

  it("two parts in a row with no tool call end the job stuck", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, reports } = jobDeps([
      { body: { answer: "It's running again.", unfinished: true, verdict: "keep_going", advice: "Do the YC work.", idle: true } },
      { body: { answer: "Read the form.", unfinished: true, verdict: "keep_going", advice: "Fill it." } },
      { body: { answer: "It's running again.", unfinished: true, verdict: "keep_going", advice: "Do the YC work.", idle: true } },
      { body: { answer: "Still running.", unfinished: true, verdict: "keep_going", advice: "Do the YC work.", idle: true } },
    ]);
    for (let i = 0; i < 3; i += 1) await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "running" });
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "stuck", status: "Two parts in a row did none of the work. Do the YC work." });
  });
});

describe("the chat's restart", () => {
  it("the chat picks up only this chat's ended jobs, within the limit", async () => {
    expect(readSteers([{ id: "job-1234-abcd", resume: true, stop: true }, { id: "bad id!" }])).toEqual([{ id: "job-1234-abcd", resume: true }]);
    const storage = new MemoryStorage();
    const ids: string[] = [];
    await startJobs(storage, ["One", "Two", "Three"].map((title) => ({ title, brief: "b" })), {
      now: NOW,
      inbox: PHONE,
      origin: { kind: "phone", phone: PHONE, question: "q" },
      place: { chatId: "chat_1" },
      spawn: async (id) => void ids.push(id),
    });
    const [one, two, three] = ids;
    for (const id of [one, two]) await storage.put(`job:${id}`, { ...(await storage.get<object>(`job:${id}`)), state: "stuck", finishedAt: NOW + 1, finalPass: "p1", verdict: "stuck", advice: "a" });
    const sent: string[] = [];
    const send = async (id: string) => (sent.push(id), true);
    const missed = await resumeJobs(storage, [{ id: one, resume: true }, { id: two, resume: true }, { id: three, resume: true }, { id: "someone-elses", resume: true }], { id: "e1", text: "" }, send, NOW + 2);
    expect(sent).toEqual([one, two]);
    expect(missed).toEqual([]);
    const listed = await chatJobs(storage, NOW + 2, { results: true });
    expect(listed.filter((job) => job.state === "running")).toHaveLength(3);
    const picked = await storage.get<Record<string, unknown>>(`job:${one}`);
    expect(picked).toMatchObject({ state: "running", startedAt: NOW + 2, status: "Picking up where it stopped" });
    expect(picked?.finalPass).toBeUndefined();
    expect(picked?.verdict).toBeUndefined();

    await storage.put(`job:${three}`, { ...(await storage.get<object>(`job:${three}`)), state: "failed", finishedAt: NOW + 3 });
    await storage.put(`job:${one}`, { ...(await storage.get<object>(`job:${one}`)), state: "stuck", finishedAt: NOW + 3 });
    const full = await resumeJobs(storage, [{ id: one, resume: true }, { id: three, resume: true }], { id: "e2", text: "" }, send, NOW + 4);
    expect(full).toEqual([]);
    await storage.put(`job:${one}`, { ...(await storage.get<object>(`job:${one}`)), state: "stuck", finishedAt: NOW + 5 });
    await startJobs(storage, [{ title: "Four", brief: "b" }], { now: NOW + 5, inbox: PHONE, origin: { kind: "phone", phone: PHONE, question: "q" }, place: { chatId: "chat_1" }, spawn: async () => {} });
    const over = await resumeJobs(storage, [{ id: one, resume: true }], { id: "e3", text: "" }, send, NOW + 6);
    expect(over).toEqual(["One"]);
    expect(notResumedText(over)).toMatch(/couldn't pick "One" back up/);
  });

  it("the chat's restart hands the job their words", async () => {
    const storage = new MemoryStorage();
    const ids: string[] = [];
    await startJobs(storage, [{ title: "Haircut", brief: "b" }], { now: NOW, inbox: PHONE, origin: { kind: "phone", phone: PHONE, question: "q" }, place: { chatId: "chat_1" }, spawn: async (id) => void ids.push(id) });
    const [id] = ids;
    await storage.put(`job:${id}`, { ...(await storage.get<object>(`job:${id}`)), state: "failed", finishedAt: NOW + 1 });
    const sent: JobSteer[] = [];
    const send = async (_id: string, steer: JobSteer) => (sent.push(steer), true);
    await resumeJobs(storage, [{ id: id!, resume: true }], { id: "e1", text: "book with santana" }, send, NOW + 2);
    expect(sent).toEqual([{ id: "e1", text: "book with santana", resume: true }]);
    await storage.put(`job:${id}`, { ...(await storage.get<object>(`job:${id}`)), state: "failed", finishedAt: NOW + 3 });
    await resumeJobs(storage, [{ id: id!, resume: true }], { id: "e2", text: "" }, send, NOW + 4);
    expect(sent.at(-1)).toEqual({ id: "e2", text: PICKED_UP, resume: true });
  });
});
