/**
 * A job never ends "done" while it says it is still working, and the chat's
 * turn can read what a finished job did (a tester's 1:1 chat, 2026-10-31).
 *
 * A profile-filling job ran one forty-second pass and ended on "I'm filling
 * in the profile, and I'll text you each answer". Its object marked it done,
 * the live view said Done, and the chat's turn, shown only its first line,
 * kept saying it was still filling it in, then said it couldn't see the
 * answers. The gateway now marks such an answer `unfinished` (another part)
 * or, on the last part, `incomplete`; a finished job keeps its steps and its
 * report for the chat's turns, never for the live view.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `runJob` ignoring `incomplete` → "a last part that still says it is working ends as stopped, never done".
 *  2. `chatJobs` dropping finished jobs' steps → "the chat's turn is shown what a finished job did".
 *  3. `chatJobs` giving `result` without `results` → "the live view never shows a job's report".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { chatJobs, MAX_JOB_ATTEMPTS, noteJobUpdate, serveThreads, startJobs, mintThreadsLink, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const STILL = "Nothing's submitted yet. I'm filling in the profile from your resume, and I'll text you each answer before anything goes in.";

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Fill in the job-site profile",
  brief: "Fill in every profile field from the resume note.",
  origin: { kind: "phone", phone: PHONE, question: "fill in the profile" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

function jobDeps(answers: Array<Record<string, unknown>>) {
  const reports: JobUpdate[] = [];
  const asked: Array<Record<string, unknown>> = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "America/New_York" });
      if (path === "/agent") {
        asked.push(JSON.parse(String(init.body)));
        const next = answers.shift();
        if (!next) throw new Error("no answer left");
        return Response.json(next);
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
  return { deps, reports, asked };
}

describe("a job that says it is still working", () => {
  it("an earlier part that still says it is working gets another part, built on its words", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, reports, asked } = jobDeps([
      { answer: STILL, unfinished: true },
      { answer: "Filled in all six fields (copied below) and stopped at Submit, waiting for your yes." },
    ]);
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
    expect(reports.filter((update) => update.texts?.length)).toEqual([]);
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(asked[1]).toMatchObject({ job: { attempt: 2, draft: STILL, unfinished: true } });
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Filled in all six fields (copied below) and stopped at Submit, waiting for your yes."] });
  });

  it("a last part that still says it is working ends as stopped, never done", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ attempt: MAX_JOB_ATTEMPTS }), NOW);
    const { deps, reports } = jobDeps([{ answer: STILL, incomplete: true }]);
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const last = reports.at(-1)!;
    expect(last.state).toBe("failed");
    expect(last.status).toMatch(/^Ended before finishing: /);
    // The coordinator still gets its words, to fix or start again.
    expect(last.texts).toEqual([STILL]);
  });
});

describe("what a finished job did", () => {
  async function finishedJob(storage: MemoryStorage): Promise<string> {
    await startJobs(storage, [{ title: "Fill in the job-site profile", brief: "b" }], {
      now: NOW,
      inbox: PHONE,
      origin: { kind: "phone", phone: PHONE, question: "q" },
      place: { chatId: "chat_1", messageId: "m_ask" },
      spawn: async () => {},
    });
    const [{ id }] = await chatJobs(storage, NOW);
    await noteJobUpdate(storage, { id, state: "running", step: "browse type: Headline" }, NOW + 1);
    await noteJobUpdate(storage, { id, state: "running", step: "browse type: Work location" }, NOW + 2);
    await noteJobUpdate(storage, { id, pass: "pass-aaaaaaaa", state: "done", status: "Filled six fields.", texts: ["Headline: Staff engineer.", "Work location: hybrid."] }, NOW + 3);
    return id;
  }

  it("the chat's turn is shown what a finished job did", async () => {
    const storage = new MemoryStorage();
    await finishedJob(storage);
    const [job] = await chatJobs(storage, NOW + 4, { results: true });
    expect(job).toMatchObject({ state: "done", result: "Headline: Staff engineer.\n\nWork location: hybrid." });
    expect(job.steps?.map((step) => step.text)).toEqual(["browse type: Headline", "browse type: Work location"]);
  });

  it("the live view never shows a job's report", async () => {
    const storage = new MemoryStorage();
    await finishedJob(storage);
    const [job] = await chatJobs(storage, NOW + 4);
    expect(job.result).toBeUndefined();
    const link = await mintThreadsLink(storage, "a".repeat(64), NOW + 4);
    const token = link.split(".").at(-1)!;
    const shown = await (await serveThreads(storage, token, NOW + 5)).text();
    expect(shown).not.toContain("Staff engineer");
  });
});
