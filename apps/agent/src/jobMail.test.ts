/**
 * Note mail handed to a running background job (`jobMail.ts`, `jobRun.ts`;
 * `docs/decisions/note-mail.md`). Mail sent into a part running now is taken
 * in as another agent's words; mail kept between parts is shown to the next
 * part as `job.mail`, never as a follow-up text; an ask the part never looked
 * at gets a part of its own; a busy note never pushes out a person's text.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, runJob, steerJob, STEERS_KEY, type JobDeps } from "./jobRun";
import { JOB_LINES, RUN_KEY, readStartedJobs, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { mailJob, mailSteer, readMailDelivery, type MailDelivery } from "./jobMail";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const AT = "2026-11-04T10:00:00.000Z";
const PATH = "projects/x/overview.md";

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Pricing",
  brief: "Price the plans.",
  origin: { kind: "phone", phone: PHONE, question: "price the plans" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

const mailFor = (over: Partial<MailDelivery["mail"]> = {}): MailDelivery => ({
  jobId: "job-1234-abcd",
  mailboxId: "mb_abcdef12",
  to: "builder",
  mail: { path: PATH, at: AT, from: "lead", app: "Claude", kind: "ask", text: "Which file?", ...over },
});

type Answer = { body: Record<string, unknown>; during?: () => Promise<void> };

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
        return Response.json(next.body);
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

describe("reading a mail delivery", () => {
  it("accepts a well-formed delivery and trims its text", () => {
    const delivery = readMailDelivery({
      jobId: "job-1234-abcd",
      mailboxId: "mb_abcdef12",
      to: "builder",
      mail: { path: PATH, at: AT, from: "lead", app: "Claude", kind: "ask", text: "Which file?" },
    });
    expect(delivery).toEqual({
      jobId: "job-1234-abcd",
      mailboxId: "mb_abcdef12",
      to: "builder",
      mail: { path: PATH, at: AT, from: "lead", app: "Claude", kind: "ask", text: "Which file?" },
    });
  });

  it("refuses what it cannot read strictly", () => {
    const good = mailFor().mail;
    const base = { jobId: "job-1234-abcd", mailboxId: "mb_abcdef12", to: "builder", mail: good };
    expect(readMailDelivery({ ...base, jobId: "../short" })).toBeNull();
    expect(readMailDelivery({ ...base, mailboxId: "mb_ABC" })).toBeNull();
    expect(readMailDelivery({ ...base, mail: { ...good, kind: "shout" } })).toBeNull();
    expect(readMailDelivery({ ...base, mail: { ...good, text: "   " } })).toBeNull();
    expect(readMailDelivery({ ...base, mail: { ...good, path: "projects/x\noverview.md" } })).toBeNull();
    expect(readMailDelivery({ ...base, mail: { ...good, at: "yesterday" } })).toBeNull();
  });

  it("cleans the app name it is shown with", () => {
    const delivery = readMailDelivery({
      jobId: "job-1234-abcd",
      mailboxId: "mb_abcdef12",
      to: "builder",
      mail: { path: PATH, at: AT, from: "lead", app: "Claude (beta) [x]", kind: "note", text: "Hi" },
    });
    expect(delivery).not.toBeNull();
    // The app is shown in parentheses after the sender (`mailLine`), so parentheses never reach it.
    expect(delivery!.mail.app).not.toMatch(/[()]/);
    // Brackets are kept: the kind tag comes after the recipient, never inside the sender's parentheses.
    expect(delivery!.mail.app).toBe("Claude  beta  [x]");
  });

  it("caps a text at 4000 characters", () => {
    const delivery = readMailDelivery({
      jobId: "job-1234-abcd",
      mailboxId: "mb_abcdef12",
      to: "builder",
      mail: { path: PATH, at: AT, from: "lead", kind: "note", text: "x".repeat(5_000) },
    });
    expect(delivery?.mail.text).toHaveLength(4_000);
  });
});

describe("mail to a running job", () => {
  it("mail delivered while a part runs is sent into that part at once", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, steered } = jobDeps([
      { body: { answer: "Answered the lead." }, during: async () => void (expect(await mailJob(storage, mailFor(), steerJob)).toBe(true)) },
    ]);
    await runJob(storage, deps);
    expect(steered).toHaveLength(1);
    expect(steered[0].body).toEqual({
      turn: asked[0].turn,
      id: `mail:${Date.parse(AT)}:lead`,
      text: "Which file?",
      mail: { from: "lead", kind: "ask", path: PATH, app: "Claude" },
    });
    expect(asked[0].job).toMatchObject({ id: "job-1234-abcd" });
    expect((asked[0].job as Record<string, unknown>).followUps).toBeUndefined();
    expect(JSON.stringify(asked[0].job)).not.toContain("Which file?");
  });

  it("mail kept between parts is shown to the next part as job.mail, never job.followUps", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    expect(await mailJob(storage, mailFor(), steerJob)).toBe(true);
    const { deps, asked } = jobDeps([{ body: { answer: "Done." } }]);
    await runJob(storage, deps);
    const job = asked[0].job as Record<string, unknown>;
    expect((job.mail as unknown[])[0]).toEqual({ from: "lead", kind: "ask", path: PATH, app: "Claude", text: "Which file?" });
    expect(job.followUps).toBeUndefined();
  });

  it("an ask mailed after the part's last look gets another part, and no missed-text line", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, asked, reports } = jobDeps([
      // The part never took the ask in (no `steered`): its answer is not texted the old way.
      { body: { answer: "Priced it." }, during: async () => void (await mailJob(storage, mailFor(), steerJob)) },
      { body: { answer: "Answered the lead." } },
    ]);
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
    expect(reports.at(-1)?.state).toBe("running");
    expect(reports.at(-1)?.status?.startsWith("Answering mail from lead")).toBe(true);
    expect(reports.every((update) => !update.texts?.includes(JOB_LINES.missed))).toBe(true);
    expect(reports.some((update) => update.texts?.includes("Priced it."))).toBe(false);

    await runJob(storage, deps);
    expect((asked[1].job as Record<string, unknown>).mail).toEqual([{ from: "lead", kind: "ask", path: PATH, app: "Claude", text: "Which file?" }]);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Answered the lead."] });
  });

  it("a plain note mailed after the last look does not hold the job", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const { deps, reports } = jobDeps([
      { body: { answer: "Priced it." }, during: async () => void (await mailJob(storage, mailFor({ kind: "note", text: "FYI" }), steerJob)) },
    ]);
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Priced it."] });
    expect(reports.every((update) => !update.texts?.includes(JOB_LINES.missed))).toBe(true);
  });

  it("a busy note never pushes out a person's text", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    const person: JobSteer = { id: "e2", text: "make it yearly too" };
    expect(await steerJob(storage, person)).toBe(true);
    for (let i = 0; i < 25; i += 1) {
      const at = new Date(Date.parse(AT) + i * 1_000).toISOString();
      expect(await mailJob(storage, mailFor({ at, text: `mail ${i}` }), steerJob)).toBe(true);
    }
    const steers = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
    expect(steers.filter((steer) => steer.mail === undefined)).toEqual([person]);
    expect(steers.filter((steer) => steer.mail !== undefined)).toHaveLength(20);
  });

  it("the same line delivered twice is kept once", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(), NOW);
    expect(await mailJob(storage, mailFor(), steerJob)).toBe(true);
    expect(await mailJob(storage, mailFor(), steerJob)).toBe(true);
    const steers = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
    expect(steers).toHaveLength(1);
    expect(steers[0]).toEqual(mailSteer(mailFor()));
  });

  it("mail for a job that has ended is not taken", async () => {
    const storage = new MemoryStorage();
    expect(await mailJob(storage, mailFor(), steerJob)).toBe(false);
    expect(storage.data.has(STEERS_KEY)).toBe(false);
    expect(storage.data.has(RUN_KEY)).toBe(false);
  });

  it("two jobs exchange an ask and an answer within the same tick", async () => {
    const a = new MemoryStorage();
    const b = new MemoryStorage();
    await acceptJob(a, run({ id: "job-1234-abcd" }), NOW);
    await acceptJob(b, run({ id: "job-5678-abcd", title: "Trip" }), NOW);
    // Each job's part waits until both are inside their turns, so each delivery lands in a turn that is running.
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    const meet = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const ask = mailFor({ from: "a-part", kind: "ask", text: "Which tier?" });
    const note = mailFor({ from: "b-part", kind: "note", text: "Tier is set." });
    const jobA = jobDeps([
      {
        body: { answer: "A done." },
        during: async () => {
          await meet();
          await mailJob(b, ask, steerJob);
        },
      },
    ]);
    // B took the ask in, so its answer lists it as taken and it is not a change.
    const jobB = jobDeps([
      {
        body: { answer: "B done.", steered: [mailSteer(ask).id] },
        during: async () => {
          await meet();
          await mailJob(a, note, steerJob);
        },
      },
    ]);
    const started = Date.now();
    await Promise.all([runJob(a, jobA.deps), runJob(b, jobB.deps)]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(jobB.steered).toEqual([
      { token: "Bearer job_token", body: { turn: jobB.asked[0].turn, ...mailSteer(ask) } },
    ]);
    expect(jobA.steered).toEqual([
      { token: "Bearer job_token", body: { turn: jobA.asked[0].turn, ...mailSteer(note) } },
    ]);
    expect(jobA.reports.at(-1)).toMatchObject({ state: "done", texts: ["A done."] });
    expect(jobB.reports.at(-1)).toMatchObject({ state: "done", texts: ["B done."] });
  });
});

describe("reading started jobs with a note", () => {
  it("keeps a valid split-ask note and drops a bad one", () => {
    const jobs = readStartedJobs([
      { title: "Pricing", brief: "Price the plans.", mail: { path: PATH, name: "pricing" } },
      { title: "Everyone", brief: "Price the plans.", mail: { path: PATH, name: "everyone" } },
      { title: "Not a note", brief: "Price the plans.", mail: { path: "projects/x/overview.txt", name: "pricing" } },
    ]);
    expect(jobs).toHaveLength(3);
    expect(jobs[0].mail).toEqual({ path: PATH, name: "pricing" });
    expect(jobs[1].mail).toBeUndefined();
    expect(jobs[2].mail).toBeUndefined();
  });
});
