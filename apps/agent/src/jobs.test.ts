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
 *  5. `runJob` ignoring `unfinished` (2026-10-26) → "gives a job whose answer stopped short another part, built on that answer".
 *  6. `runJob` without the 30-minute limit (2026-10-31) → "a job the advisor says isn't finished stops at its limit, stuck, saying it ran out of time".
 *  7. `runJob` ending `waiting` as done → "a job waiting on them ends waiting, and one with no way forward ends stuck".
 *  8. `chatJobs` giving the advice without `results` → "keeps the advisor's call and the report for the chat's turns, never the live view".
 *  9. `noteJobUpdate` keeping an earlier part's verdict on a finished job → the same test.
 * 10. `outcomeOf` mapping `daily_limit`/`no_model` to a silent stop (2026-10-31) → "a part the gateway refused ends waiting and says why".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { chatJobs, JOB_KEPT_MS, JOB_LIMIT_MS, JOB_LINES, JOB_STALE_MS, noteJobUpdate, MAX_JOB_ATTEMPTS, MAX_RUNNING_JOBS, notStartedText, readStartedJobs, RUN_KEY, startJobs, type JobEntry, type JobRun, type JobUpdate } from "./jobs";
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
    expect(await startJobs(storage, [{ title: "Competitor research", brief: "b" }, { title: "competitor  research!", brief: "b" }], context)).toEqual({ started: 1, notStarted: [] });
    expect(await startJobs(storage, [{ title: "Trip plan", brief: "b" }, { title: "Gift ideas", brief: "b" }, { title: "Fourth one", brief: "b" }], context)).toEqual({ started: 2, notStarted: ["Fourth one"] });
    expect(spawned.map((job) => job.title)).toEqual(["Competitor research", "Trip plan", "Gift ideas"]);
    expect(spawned[0]).toMatchObject({ inbox: PHONE, attempt: 1, origin: { kind: "phone", question: "q" } });
    const listed = await chatJobs(storage, NOW);
    expect(listed).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toContain("chat_1");

    const failing = { ...context, spawn: async () => Promise.reject(new Error("no")) };
    const other = new MemoryStorage();
    expect(await startJobs(other, [{ title: "x y", brief: "b" }], failing)).toEqual({ started: 0, notStarted: ["x y"] });
    expect(await chatJobs(other, NOW)).toEqual([]);
  });

  it("tells them about a job it said it started that never did, and says nothing when every one started", () => {
    expect(notStartedText([])).toBeUndefined();
    const said = notStartedText(["Fourth one"]);
    expect(said).toContain('"Fourth one"');
    expect(said).toContain(`${MAX_RUNNING_JOBS} jobs at once`);
    expect(notStartedText(["A", "B"])).toContain('"A" and "B"');
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
    const { deps, asked, reports } = jobDeps(
      Array.from({ length: MAX_JOB_ATTEMPTS }, (_, i) => ({ body: { answer: i === MAX_JOB_ATTEMPTS - 1 ? "Wrote the note with what I have." : "Still more.", exhausted: true } })),
    );
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i += 1) await runJob(storage, deps);
    expect(asked.map((body) => (body.job as { attempt: number }).attempt)).toEqual(Array.from({ length: MAX_JOB_ATTEMPTS }, (_, i) => i + 1));
    expect(reports.filter((update) => update.texts).map((update) => update.texts)).toEqual([["Wrote the note with what I have."]]);
    expect(reports.at(-1)?.state).toBe("done");
    expect(storage.data.has(RUN_KEY)).toBe(false);
  });

  it("gives a job whose answer stopped short another part, built on that answer (self-review, 2026-10-26)", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const short = "Mains are about $1 a head. Next step is pricing the sides.";
    const { deps, asked, reports } = jobDeps([
      { body: { answer: short, unfinished: true } },
      { body: { answer: "Three caterers at $8.50, $9.50 and $10 a head, all in." } },
    ]);
    await runJob(storage, deps);
    expect(reports.filter((update) => update.texts)).toEqual([]);
    expect(reports.at(-1)).toMatchObject({ state: "running", status: "Finishing what was still missing" });
    await runJob(storage, deps);
    expect(asked[1].job).toMatchObject({ attempt: 2, draft: short, unfinished: true });
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Three caterers at $8.50, $9.50 and $10 a head, all in."] });
    expect(storage.data.has(RUN_KEY)).toBe(false);
  });

  it("a part that ran out of steps after an unfinished one is not told it stopped short", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked } = jobDeps([
      { body: { answer: "Next step is pricing the sides.", unfinished: true } },
      { body: { answer: "Pricing.", exhausted: true } },
      { body: { answer: "Done." } },
    ]);
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i += 1) await runJob(storage, deps);
    expect((asked[2].job as { unfinished?: true }).unfinished).toBeUndefined();
  });

  it("a job the advisor says to keep going carries on, starting on its advice (2026-10-31, the a16z job)", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ doneWhen: "the application is submitted" }), NOW);
    const { deps, asked, reports } = jobDeps([
      { body: { answer: "Opened the form; I'll begin with the sign-in.", unfinished: true, verdict: "keep_going", advice: "Sign in with the emailed link." } },
      { body: { answer: "Submitted it.", verdict: "done", advice: "The form is submitted." } },
    ]);
    await runJob(storage, deps);
    expect(reports.filter((update) => update.texts)).toEqual([]);
    expect(reports.at(-1)).toMatchObject({ state: "running", verdict: "keep_going", advice: "Sign in with the emailed link.", status: "Not done yet; next: Sign in with the emailed link." });
    await runJob(storage, deps);
    expect(asked[1].job).toMatchObject({ attempt: 2, advice: "Sign in with the emailed link.", doneWhen: "the application is submitted" });
    expect(reports.at(-1)).toMatchObject({ state: "done", verdict: "done", texts: ["Submitted it."] });
  });

  it("a job waiting on them ends waiting, and one with no way forward ends stuck", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const waiting = jobDeps([{ body: { answer: "It needs the code they were texted.", verdict: "waiting", advice: "The six-digit code texted to them." } }]);
    await runJob(storage, waiting.deps);
    expect(waiting.reports.at(-1)).toMatchObject({ state: "waiting", verdict: "waiting", status: "The six-digit code texted to them.", texts: ["It needs the code they were texted."] });
    expect(storage.data.has(RUN_KEY)).toBe(false);

    await acceptJob(storage, run({ id: "job-5678-efgh" }), NOW);
    const stuck = jobDeps([{ body: { answer: "The site is down.", verdict: "stuck", advice: "The site has been down for every try." } }]);
    await runJob(storage, stuck.deps);
    expect(stuck.reports.at(-1)).toMatchObject({ state: "stuck", status: "The site has been down for every try." });
  });

  it("a job the advisor says isn't finished stops at its limit, stuck, saying it ran out of time", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run({ startedAt: NOW - JOB_LIMIT_MS }), NOW);
    const { deps, reports } = jobDeps([{ body: { answer: "Got to page two.", unfinished: true, verdict: "keep_going", advice: "Fill page three." } }]);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "stuck", status: "Ran out of time. Fill page three.", texts: ["Got to page two."] });
    expect(storage.data.has(RUN_KEY)).toBe(false);

    await acceptJob(storage, run({ id: "job-5678-efgh", attempt: MAX_JOB_ATTEMPTS }), NOW);
    const last = jobDeps([{ body: { answer: "Still short.", unfinished: true } }]);
    await runJob(storage, last.deps);
    expect(last.reports.at(-1)).toMatchObject({ state: "stuck", status: "Ran out of time. Still short." });
  });

  it("keeps the advisor's call and the report for the chat's turns, never the live view", async () => {
    const storage = new MemoryStorage();
    await startJobs(storage, [{ title: "Apply to the accelerator", brief: "b" }], { now: NOW, inbox: PHONE, origin: { kind: "phone", phone: PHONE, question: "q" }, place: { chatId: "chat_1", messageId: "m_ask" }, spawn: async () => {} });
    const [{ id }] = await chatJobs(storage, NOW);
    await noteJobUpdate(storage, { id, state: "running", step: "send open_page: https://example.com/apply", verdict: "keep_going", advice: "Sign in first." }, NOW);
    expect((await chatJobs(storage, NOW, { results: true }))[0]).toMatchObject({ verdict: "keep_going", advice: "Sign in first.", steps: [{ at: NOW, text: "send open_page: https://example.com/apply" }] });
    expect(JSON.stringify(await chatJobs(storage, NOW))).not.toMatch(/keep_going|Sign in first/);
    await noteJobUpdate(storage, { id, state: "done", status: "Submitted.", texts: ["Submitted it: confirmation 42."] }, NOW + 1);
    const [ended] = await chatJobs(storage, NOW + 1, { results: true });
    expect(ended).toMatchObject({ state: "done", result: "Submitted it: confirmation 42.", steps: [{ text: "send open_page: https://example.com/apply" }] });
    expect(ended.verdict).toBeUndefined();
    const [shown] = await chatJobs(storage, NOW + 1);
    expect(shown.result).toBeUndefined();
    expect(JSON.stringify(shown)).not.toMatch(/confirmation 42|Sign in first/);
  });

  it("tries a turn that could not start again later, then says it couldn't finish", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const busy = { status: 503, body: { error: "model_unavailable" } };
    const { deps, reports } = jobDeps([busy, busy, busy]);
    // The pass says when to try again; its driver (workflow or alarm, `armJobNext`) waits.
    expect(await runJob(storage, deps)).toMatchObject({ kind: "after" });
    await runJob(storage, deps);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "failed", texts: [JOB_LINES.failed("Competitor research")] });
  });

  it("a part the gateway refused ends waiting and says why, never failing silently", async () => {
    // Dev2, 2026-10-31: three restarted jobs used up the day's turns and every one after was refused about a second in.
    for (const [status, why] of [[429, "daily_limit"], [409, "no_model"]] as const) {
      const storage = new MemoryStorage();
      await acceptJob(storage, run(), NOW);
      const { deps, reports } = jobDeps([{ status, body: { error: why } }]);
      expect(await runJob(storage, deps)).toEqual({ kind: "done" });
      expect(reports.at(-1)).toMatchObject({ state: "waiting", status: JOB_LINES.refusedStatus[why], texts: [JOB_LINES.refused("Competitor research", why)] });
      expect(await storage.get(RUN_KEY)).toBeUndefined();
    }
    expect(JOB_LINES.refused("Competitor research", "daily_limit")).toMatch(/"Competitor research".*today's limit/);
    expect(JOB_LINES.refused("Competitor research", "no_model")).toMatch(/can't reach my model/);
  });

  it("ends silently for a phone that was unlinked meanwhile", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, reports } = jobDeps([], { linked: false });
    await runJob(storage, deps);
    expect(asked).toEqual([]);
    expect(reports).toEqual([{ id: "job-1234-abcd", state: "failed", first: 0, pass: expect.any(String) }]);
  });

  it("hands the result to the chat's own turn under the ask it came from, never texting it, and queues an update offered again once", async () => {
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
    const update: JobUpdate = { id, state: "done", status: "Wrote it.", texts: ["Wrote it.", "https://context.lc/n/abc"], first: 0, asked: { from: PHONE, text: "q" } };
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(sent).toEqual([]);
    const queued = [...(await storage.list<{ message: Message }>({ prefix: "pending:" })).values()].map((item) => item.message);
    expect(queued).toEqual([
      expect.objectContaining({ chatId: "chat_1", from: PHONE, messageId: "m_ask", text: "q", event: "job_report", jobReport: { title: "Competitor research", state: "done", texts: ["Wrote it.", "https://context.lc/n/abc"] } }),
    ]);
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
