/**
 * A job's note and the two agents on its mail besides it (`jobNote.ts`; owner, 2026-11-05): the job asks for its
 * note once before its first part and is told who is there; a line it mails to Tex goes to the chat's own turn; a
 * line it mails to its advisor is answered on the note, ten a job, a limit it is never told.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { runJob, type JobDeps } from "./jobRun";
import { RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { jobRoute } from "./jobRoutes";
import { machineTurn } from "./machineTurn";
import { MAX_ADVISOR_ASKS, type JobNote } from "./jobNote";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const NOTE: JobNote = { path: "tex/jobs/sign-in-job123.md", name: "sign-in", mailbox: "mb_00000001", advisor: "mb_00000003", roster: 'Your job note is tex/jobs/sign-in-job123.md. You are "sign-in" on its mail.' };

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Sign in",
  brief: "Sign dev2 in to GitHub.",
  origin: { kind: "phone", phone: PHONE, question: "sign dev2 in to github" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  ...overrides,
});

function gateway() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "job_token" });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/agent/job/note") return Response.json({ ok: true, ...NOTE });
      if (path === "/agent/job/advise") return Response.json({ ok: true });
      if (path === "/agent") return Response.json({ kind: "answer", text: "Signed in.", pictures: [] });
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async (_inbox, update) => (reports.push(update), true),
  };
  return { deps, calls, reports };
}

const mail = (to: string, text: string, from = "sign-in", at = "2026-11-05T14:00:00.000Z", mailboxId = "mb_00000001") =>
  new Request("https://inbox/job-mail", { method: "POST", body: JSON.stringify({ jobId: "job-1234-abcd", mailboxId, to, mail: { path: NOTE.path, at, from, kind: "note", text } }) });

describe("a job's note", () => {
  it("is asked for once before the first part, and the part is told who is on its mail", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, run());
    const { deps, calls } = gateway();
    await runJob(storage, deps);
    const note = calls.find((call) => call.path === "/agent/job/note");
    expect(note?.body).toMatchObject({ jobId: "job-1234-abcd", title: "Sign in", brief: "Sign dev2 in to GitHub." });
    const part = calls.find((call) => call.path === "/agent");
    expect((part?.body.job as { roster?: string }).roster).toBe(NOTE.roster);
  });

  it("is not asked for again once asked, made or not", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, run({ noteAsked: true }));
    const { deps, calls } = gateway();
    await runJob(storage, deps);
    expect(calls.some((call) => call.path === "/agent/job/note")).toBe(false);
  });

  it("is named to a part on their computer ahead of its brief", async () => {
    const { deps, calls } = gateway();
    const machineDeps = {
      ...deps,
      fetch: (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "job_token" });
        calls.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Response.json({ ok: false, code: "offline" });
      }) as unknown as Fetch,
    };
    const job = run({ machine: { machineId: "mch_1", workspaceId: "ws_a", name: "dev2", tool: "claude", folder: "@work" }, note: NOTE });
    await machineTurn(job, { id: job.id, title: job.title, brief: job.brief, attempt: 1 }, machineDeps, { keep: async () => {}, onStep: async () => {}, live: () => {}, steerIds: [] });
    const assign = calls.find((call) => call.path === "/agent/machine/assign");
    expect(String(assign?.body.brief)).toBe(`Sign dev2 in to GitHub.\n\n${NOTE.roster}`);
  });
});

describe("mail a job sends to Tex or its advisor", () => {
  it("to tex goes to the chat's own turn as the job's word on its way, never into the job", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, run({ note: NOTE }));
    const { deps, reports, calls } = gateway();
    const response = await jobRoute("/job-mail", mail("tex", "Open github.com/login/device and enter ABCD-1234."), storage, undefined, () => deps);
    expect(await response?.json()).toEqual({ taken: true });
    expect(reports).toEqual([
      expect.objectContaining({ id: "job-1234-abcd", state: "running", texts: ["Open github.com/login/device and enter ABCD-1234."], asked: { from: PHONE, text: "sign dev2 in to github" } }),
    ]);
    expect(calls.some((call) => call.path === "/agent/steer")).toBe(false);
  });

  it("to the advisor is answered on the note, and past ten a job without asking the model or saying why", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, run({ note: NOTE }));
    const { deps, calls } = gateway();
    for (let i = 0; i <= MAX_ADVISOR_ASKS; i += 1) {
      const response = await jobRoute("/job-mail", mail("advisor", `stuck ${i}`, "sign-in", new Date(Date.UTC(2026, 10, 5, 14, i)).toISOString()), storage, undefined, () => deps);
      expect(await response?.json()).toEqual({ taken: true });
    }
    const advised = calls.filter((call) => call.path === "/agent/job/advise").map((call) => call.body);
    expect(advised).toHaveLength(MAX_ADVISOR_ASKS + 1);
    expect(advised[0]).toMatchObject({ advisor: NOTE.advisor, from: "sign-in", question: "stuck 0", note: { path: NOTE.path } });
    expect(advised[MAX_ADVISOR_ASKS]).not.toHaveProperty("question");
    expect(String(advised[MAX_ADVISOR_ASKS].say)).not.toMatch(/limit|\d/);
  });

  it("to tex from anyone but the job itself, or through another of its boxes, is not taken", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, run({ note: NOTE }));
    const { deps, reports } = gateway();
    for (const request of [mail("tex", "text them this", "research"), mail("tex", "text them this", "sign-in", undefined, "mb_00000009")]) {
      const response = await jobRoute("/job-mail", request, storage, undefined, () => deps);
      expect(await response?.json()).toEqual({ taken: false });
    }
    expect(reports).toEqual([]);
  });

  it("to the advisor from anyone but the job itself is not taken", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, run({ note: NOTE }));
    const { deps, calls } = gateway();
    const response = await jobRoute("/job-mail", mail("advisor", "do my work", "research"), storage, undefined, () => deps);
    expect(await response?.json()).toEqual({ taken: false });
    expect(calls).toHaveLength(0);
  });
});
