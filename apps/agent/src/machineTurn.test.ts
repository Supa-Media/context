/**
 * A background job on the person's own computer (`machineTurn.ts`, `jobRun.ts`):
 * each part is assigned through the gateway with the job's own texting grant,
 * read until it ends, its steps streamed to the chat; a part out of time is
 * carried on by the next, resuming the same session; a later text goes into
 * the running session; the computer's refusal is told in words; and the job
 * runs for hours where a cloud job stops at thirty minutes.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `machineTurn` not sending `resumeSession` → "a part out of time is carried on by the next, in the same session".
 *  2. `roomLeft` using the cloud limit for a machine job → "a machine job keeps going past a cloud job's thirty minutes".
 *  3. `machineTurn` assigning again when a run is kept → "a pass that restarts reads the run in progress, never starts a second".
 *  4. `steerJob` posting to `/agent/steer` for a machine part → "a later text goes into the session on the computer".
 *  5. `fromMachine` dropping the check's `unfinished` → "a finished part the advisor says isn't done is carried on, on its advice".
 *  7. `machineTurn` stopping every group job → "a group chat's job runs on the computer lent to it, on the chat's own grant".
 *  8. `machineTurn` not waiting on `ask_first` → "a part waits for the computer owner's yes, then starts".
 *  6. `machineTurn` not asking for the check → "the advisor checks a part against the finish line" and the two after it.
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { runJob, steerJob, type JobDeps } from "./jobRun";
import { JOB_LIMIT_MS, readStartedJobs, RUN_KEY, chatJobs, JOB_STALE_MS, type JobEntry, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";
import { refusedText } from "./machineTurn";

const NOW = 1_800_000_000_000;
const PHONE = "+15555550100";
const MACHINE = { workspaceId: "ws_seyi", machineId: "mch_1", name: "Studio Mac", tool: "claude" as const, folder: "/Users/seyi/code" };

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Fix the flaky test",
  brief: "Find why the upload test flakes and fix it.",
  doneWhen: "The test passes ten times in a row.",
  origin: { kind: "phone", phone: PHONE, question: "fix the flaky upload test on my mac" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
  machine: MACHINE,
  ...overrides,
});

type RunRead = { state: string; steps?: { seq: number; tool: string; action?: string | null; target?: string | null }[]; result?: Record<string, unknown> | null; session?: string | null };

/** A gateway whose machine routes answer from scripts: `assign` answers, then each read of the run in turn. */
const GROUP = "11111111-2222-3333-4444-555555555555";
const ADA = "+15555550101";
let groupAnswer: Record<string, unknown> = { status: "ready", slug: "band", intro: false, timeZone: "UTC", handle: "ada", accessToken: "group_token" };

function world({ assign = [{ ok: true, runId: "run_000000000000000000000001", deadline: NOW + 15 * 60_000 }], reads = [] as RunRead[], checks = [] as Record<string, unknown>[], during, down = [] as number[] }: { assign?: Record<string, unknown>[]; reads?: RunRead[]; checks?: Record<string, unknown>[]; during?: (read: number) => Promise<void>; /** Statuses the gateway answers reads of the run with first, before `reads` (0 for an answer). */ down?: number[] } = {}) {
  const clock = { at: NOW };
  const calls: Array<{ path: string; token: string | null; body: Record<string, unknown> }> = [];
  const reports: JobUpdate[] = [];
  let read = 0;
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "job_token" });
      // A group chat's job: its members read again, then its grant minted again, as its own turn's is.
      if (path.startsWith("/api/v2/groups/")) return Response.json({ data: { group_id: GROUP, participants: [ADA, PHONE].map((number) => ({ number })) } });
      if (path === "/agent-texts/group") return Response.json(groupAnswer);
      const body = JSON.parse(String(init.body));
      calls.push({ path, token: new Headers(init.headers).get("authorization"), body });
      if (path === "/agent/machine/assign") return Response.json(assign.shift() ?? { ok: false, code: "busy" });
      if (path === "/agent/machine/run") {
        read += 1;
        await during?.(read);
        const status = down.shift();
        if (status !== undefined && status !== 0) return new Response(null, { status });
        const next = reads.shift() ?? { state: "running" };
        return Response.json({ ok: true, run: { steps: [], result: null, session: null, ...next }, online: true });
      }
      if (path === "/agent/machine/deliver" || path === "/agent/machine/cancel") return Response.json({ ok: true });
      // No check scripted: the advisor can't be reached, and the part's own outcome decides.
      if (path === "/agent/machine/check") return checks.length > 0 ? Response.json(checks.shift()) : new Response(null, { status: 503 });
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => clock.at,
    sleep: async (ms) => void (clock.at += ms),
    report: async (_inbox, update) => (reports.push(update), true),
    sendblue: { keyId: "id", secret: "key" },
  } as JobDeps;
  return { deps, calls, reports, clock };
}

const finished = (answer: string, session = "sess_1"): RunRead => ({ state: "ended", steps: [], result: { outcome: "finished", answer, session }, session });

describe("a job on the person's own computer", () => {
  it("is assigned with the job's own grant, its steps reach the chat, and its answer is the job's", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, calls, reports } = world({
      reads: [
        { state: "running", steps: [{ seq: 1, tool: "Bash", action: "run", target: "pnpm test" }] },
        { ...finished("Fixed: the test raced the upload's flush."), steps: [{ seq: 1, tool: "Bash", action: "run", target: "pnpm test" }, { seq: 2, tool: "Edit", target: "upload.ts" }] },
      ],
    });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const assign = calls.find((call) => call.path === "/agent/machine/assign")!;
    expect(assign.token).toBe("Bearer job_token");
    expect(assign.body).toMatchObject({ workspaceId: "ws_seyi", machineId: "mch_1", jobId: "job-1234-abcd", part: 1, tool: "claude", folder: "/Users/seyi/code", permission: "full", brief: run().brief, doneWhen: run().doneWhen });
    expect(assign.body.resumeSession).toBeUndefined();
    // Each step once, in order, though the second read repeats the first.
    expect(reports.filter((update) => update.step).map((update) => update.step)).toEqual(["Bash run pnpm test", "Edit upload.ts", "Done on Studio Mac · checking the work"]);
    const last = reports[reports.length - 1];
    expect(last.state).toBe("done");
    expect(last.texts).toEqual(["Fixed: the test raced the upload's flush."]);
  });

  it("a part out of time is carried on by the next, in the same session", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, calls } = world({
      assign: [
        { ok: true, runId: "run_000000000000000000000001", deadline: NOW + 15 * 60_000 },
        { ok: true, runId: "run_000000000000000000000002", deadline: NOW + 30 * 60_000 },
      ],
      reads: [{ state: "ended", result: { outcome: "limit", answer: "", session: "sess_1" }, session: "sess_1" }, finished("Done.")],
    });
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
    expect((await storage.get<JobRun>(RUN_KEY))?.machineSession).toBe("sess_1");
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const assigns = calls.filter((call) => call.path === "/agent/machine/assign");
    expect(assigns.map((call) => call.body.part)).toEqual([1, 2]);
    expect(assigns[1].body.resumeSession).toBe("sess_1");
  });

  it("a pass that restarts reads the run in progress, never starts a second", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run({ machineRun: { runId: "run_000000000000000000000009", part: 1, deadline: NOW + 15 * 60_000 } }), sent: 0 });
    const { deps, calls } = world({ reads: [finished("Done.")] });
    await runJob(storage, deps);
    expect(calls.some((call) => call.path === "/agent/machine/assign")).toBe(false);
    expect(calls.find((call) => call.path === "/agent/machine/run")?.body.runId).toBe("run_000000000000000000000009");
  });

  it("a machine job keeps going past a cloud job's thirty minutes", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run({ attempt: 12, startedAt: NOW - 3 * 60 * 60 * 1000 }), sent: 0 });
    const { deps } = world({ reads: [{ state: "ended", result: { outcome: "limit", answer: "" }, session: null }] });
    expect(JOB_LIMIT_MS).toBeLessThan(3 * 60 * 60 * 1000);
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
    expect((await storage.get<JobRun>(RUN_KEY))?.attempt).toBe(13);
  });

  it("past four hours it stops and says where it got to", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run({ attempt: 17, startedAt: NOW - 4 * 60 * 60 * 1000 - 1 }), sent: 0 });
    const { deps, reports } = world({ reads: [{ state: "ended", result: { outcome: "limit", answer: "Half the tests pass now." }, session: "sess_1" }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(reports[reports.length - 1].state).not.toBe("running");
  });

  it("a later text goes into the session on the computer, and a stop cancels it there", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, calls } = world({
      reads: [{ state: "running" }, finished("Done, in yellow.")],
      during: async (read) => {
        if (read === 1) await steerJob(storage, { id: "e2.text", text: "make the badge yellow" });
      },
    });
    await runJob(storage, deps);
    const delivered = calls.find((call) => call.path === "/agent/machine/deliver");
    expect(delivered?.body).toMatchObject({ workspaceId: "ws_seyi", runId: "run_000000000000000000000001", messageId: "e2_text", text: "make the badge yellow" });
    expect(delivered?.body.mail).toBeUndefined();
    expect(calls.some((call) => call.path === "/agent/steer")).toBe(false);

    // Note mail goes in as its sender's, never as the person's (2026-11-06).
    const mailed = new MemoryStorage();
    await mailed.put(RUN_KEY, { ...run(), sent: 0 });
    const third = world({ reads: [{ state: "running" }, finished("Ran them.")], during: async (read) => void (read === 1 && (await steerJob(mailed, { id: "mail:1:cloud", text: "run the tests", mail: { from: "cloud", kind: "ask", path: "projects/split/overview.md" } }))) });
    await runJob(mailed, third.deps);
    expect(third.calls.find((call) => call.path === "/agent/machine/deliver")?.body).toMatchObject({ text: "run the tests", mail: { from: "cloud", kind: "ask", path: "projects/split/overview.md" } });

    const stopping = new MemoryStorage();
    await stopping.put(RUN_KEY, { ...run(), sent: 0 });
    const second = world({ reads: [{ state: "running" }, { state: "ended", result: { outcome: "cancelled" } }], during: async (read) => void (read === 1 && (await steerJob(stopping, { id: "e3", text: "stop", stop: true }))) });
    await runJob(stopping, second.deps);
    expect(second.calls.find((call) => call.path === "/agent/machine/cancel")?.body).toMatchObject({ runId: "run_000000000000000000000001", reason: "stopped" });
  });

  it("a computer that won't take the part is told in words, and the job can be picked back up", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, reports } = world({ assign: [{ ok: false, code: "offline" }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(reports[reports.length - 1].texts).toEqual([refusedText("Fix the flaky test", "Studio Mac", "offline")]);
    expect(await storage.get("jobended")).toBeDefined();
  });

  it("a part the computer itself refuses ends the job once, saying why, and is never tried again", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, calls, reports } = world({ reads: [{ state: "ended", result: { outcome: "failed", error: "refused: folder", refused: "folder", wallMs: 0 } }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(calls.filter((call) => call.path === "/agent/machine/assign")).toHaveLength(1);
    expect(reports[reports.length - 1].texts).toEqual([refusedText("Fix the flaky test", "Studio Mac", "folder")]);
  });

  it("a part that fails before its first step ends the job with the computer's own reason", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, calls, reports } = world({ reads: [{ state: "ended", result: { outcome: "failed", error: "repo not found in the folder", wallMs: 0 } }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(calls.filter((call) => call.path === "/agent/machine/assign")).toHaveLength(1);
    expect((reports[reports.length - 1]?.texts ?? []).join(" ")).toContain('it said "repo not found in the folder"');
  });

  it("a part that fails partway is still carried on by the next", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps } = world({ reads: [{ state: "ended", steps: [{ seq: 1, tool: "Bash", action: "ran", target: "pnpm test" }], result: { outcome: "failed", error: "claude exited 1", session: "sess_1" }, session: "sess_1" }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
  });

  it("the computer a job runs on is read strictly from the gateway's answer", () => {
    const [job] = readStartedJobs([{ title: "Fix it", brief: "Fix the test.", machine: { ...MACHINE, repo: "Supa-Media/context" } }]);
    expect(job.machine).toEqual({ ...MACHINE, repo: "Supa-Media/context" });
    expect(readStartedJobs([{ title: "Fix it", brief: "Fix the test.", machine: { ...MACHINE, repo: "../../etc" } }])[0].machine?.repo).toBeUndefined();
    for (const machine of [{ ...MACHINE, tool: "bash" }, { ...MACHINE, machineId: "../x" }, { ...MACHINE, folder: "" }]) {
      expect(readStartedJobs([{ title: "Fix it", brief: "Fix the test.", machine }])[0].machine).toBeUndefined();
    }
  });

  it("a running machine job is not called stopped at a cloud job's limit", async () => {
    const storage = new MemoryStorage();
    await storage.put<JobEntry>("job:a", { id: "a", title: "On the Mac", state: "running", startedAt: NOW - JOB_STALE_MS - 1, machine: true });
    await storage.put<JobEntry>("job:b", { id: "b", title: "In the cloud", state: "running", startedAt: NOW - JOB_STALE_MS - 1 });
    const jobs = await chatJobs(storage, NOW);
    expect(jobs.find((job) => job.id === "a")?.state).toBe("running");
    expect(jobs.find((job) => job.id === "b")?.state).toBe("failed");
  });

  it("the advisor checks a part against the finish line, with the job as the Worker knows it", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run({ followUps: ["also the retry test"] } as Partial<JobRun>), sent: 0 });
    const { deps, calls, reports } = world({ reads: [finished("Fixed.")], checks: [{ ok: true, verdict: "done", advice: "The test passes ten times." }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const check = calls.find((call) => call.path === "/agent/machine/check")!;
    expect(check.token).toBe("Bearer job_token");
    expect(check.body).toMatchObject({ workspaceId: "ws_seyi", runId: "run_000000000000000000000001", job: { title: "Fix the flaky test", brief: run().brief, doneWhen: run().doneWhen, attempt: 1 } });
    expect(reports[reports.length - 1]).toMatchObject({ state: "done", verdict: "done" });
  });

  it("a finished part the advisor says isn't done is carried on, on its advice, in the same session", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, calls } = world({
      assign: [
        { ok: true, runId: "run_000000000000000000000001", deadline: NOW + 15 * 60_000 },
        { ok: true, runId: "run_000000000000000000000002", deadline: NOW + 30 * 60_000 },
      ],
      reads: [finished("I'll run it ten times next."), finished("Passes ten times.")],
      checks: [{ ok: true, verdict: "keep_going", advice: "Run the test ten times and show it passing.", unfinished: true }, { ok: true, verdict: "done" }],
    });
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const second = calls.filter((call) => call.path === "/agent/machine/assign")[1];
    expect(second.body.resumeSession).toBe("sess_1");
    expect(String(second.body.advice)).toContain("Run the test ten times and show it passing.");
  });

  it("a part that needs the person ends the job waiting, saying what is needed", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, reports } = world({ reads: [finished("It needs your GitHub code.")], checks: [{ ok: true, verdict: "waiting", advice: "Their GitHub one-time code." }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(reports[reports.length - 1]).toMatchObject({ state: "waiting", verdict: "waiting", advice: "Their GitHub one-time code." });
  });

  it("a group chat's job runs on the computer lent to it, on the chat's own grant", async () => {
    const storage = new MemoryStorage();
    const message = { kind: "group-message", eventId: "sendblue:h_job", groupId: GROUP, line: "+15555550199", from: ADA, participants: [ADA, PHONE, "+15555550199"], messageId: "h_ask", text: "Tex, fix the flaky test on Seyi's Mac" };
    await storage.put(RUN_KEY, { ...run({ inbox: `sendblue-group:${GROUP}`, origin: { kind: "group", message, at: NOW } as JobRun["origin"] }), sent: 0 });
    const { deps, calls } = world({ reads: [finished("Fixed.")] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const assign = calls.find((call) => call.path === "/agent/machine/assign")!;
    expect(assign.token).toBe("Bearer group_token");
    expect(calls.some((call) => call.token === "Bearer job_token")).toBe(false);
  });

  it("a group chat that stopped Tex runs nothing on the computer", async () => {
    const storage = new MemoryStorage();
    const message = { kind: "group-message", eventId: "sendblue:h_job", groupId: GROUP, line: "+15555550199", from: ADA, participants: [ADA, PHONE, "+15555550199"], messageId: "h_ask", text: "Tex, fix it" };
    await storage.put(RUN_KEY, { ...run({ inbox: `sendblue-group:${GROUP}`, origin: { kind: "group", message, at: NOW } as JobRun["origin"] }), sent: 0 });
    groupAnswer = { status: "stopped" };
    try {
      const { deps, calls } = world({ reads: [finished("Fixed.")] });
      await runJob(storage, deps);
      expect(calls.some((call) => call.path === "/agent/machine/assign")).toBe(false);
    } finally {
      groupAnswer = { status: "ready", slug: "band", intro: false, timeZone: "UTC", handle: "ada", accessToken: "group_token" };
    }
  });

  it("a part waits for the computer owner's yes, then starts", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const waiting = { ok: false, code: "ask_first", askId: "ask_000000000000000000000001" };
    const { deps, calls, reports } = world({ assign: [waiting, waiting, { ok: true, runId: "run_000000000000000000000001", deadline: NOW + 15 * 60_000 }], reads: [finished("Fixed.")] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(calls.filter((call) => call.path === "/agent/machine/assign")).toHaveLength(3);
    expect(reports.some((update) => update.step === "Waiting for the owner of Studio Mac to say yes")).toBe(true);
    expect(reports[reports.length - 1].texts).toEqual(["Fixed."]);
  });

  it("a group's ask goes to the chat's Tex once, as the gateway wrote it, for the owner's 👍", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const line = `@seyi: Give this a 👍 and I'll start "Fix the flaky test" on @seyi's computer "Studio Mac". Only @seyi can OK it; a 👎 says no.`;
    const waiting = { ok: false, code: "ask_first", askId: "ask_000000000000000000000001" };
    const { deps, reports } = world({ assign: [{ ...waiting, askLine: line }, waiting, { ok: true, runId: "run_000000000000000000000001", deadline: NOW + 15 * 60_000 }], reads: [finished("Fixed.")] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    const asked = reports.filter((update) => update.ask !== undefined);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ state: "running", ask: line, texts: [line] });
  });

  it("a computer whose Claude Code signed out names the page to sign it back in", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const page = "https://context.example/tex/@seyi/machine?machine=mch_1";
    const { deps, reports } = world({ assign: [{ ok: false, code: "not_ready", why: "signed_out", fixAt: page }] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(reports[reports.length - 1].texts).toEqual([`Claude Code is signed out on Studio Mac, so I couldn't start "Fix the flaky test". Sign it back in at ${page} and text me to pick it back up.`]);
    // Without the page (a group, or an older gateway) it says what it said before.
    expect(refusedText("Fix", "Studio Mac", "not_ready", { why: "signed_out", fixAt: "javascript:alert(1)" })).toBe(refusedText("Fix", "Studio Mac", "not_ready"));
  });

  it("an owner who doesn't answer, or says no, ends the job saying so", async () => {
    for (const [code, text] of [["ask_first", refusedText("Fix the flaky test", "Studio Mac", "ask_first")], ["declined", refusedText("Fix the flaky test", "Studio Mac", "declined")]]) {
      const storage = new MemoryStorage();
      await storage.put(RUN_KEY, { ...run(), sent: 0 });
      const { deps, calls, reports, clock } = world({ assign: Array.from({ length: 30 }, () => ({ ok: false, code })) });
      expect(await runJob(storage, deps)).toEqual({ kind: "done" });
      expect(reports[reports.length - 1].texts).toEqual([text]);
      // Never past the part's own fifteen minutes.
      expect(clock.at - NOW).toBeLessThanOrEqual(15 * 60_000);
      expect(calls.filter((call) => call.path === "/agent/machine/assign").length).toBe(code === "declined" ? 1 : 11);
    }
  });
});

describe("a part on a computer while Context is briefly unreachable (2026-11-06)", () => {
  it("is read again past a busy gateway, and its answer is the job's", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, reports } = world({ down: [503, 503, 429, 503], reads: [finished("Fixed it.")] });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Fixed it."] });
  });

  it("a refusal (4xx) is never read past", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps } = world({ down: [403], reads: [finished("Fixed it.")] });
    // Nothing ran this pass: it is tried again later, as before.
    expect(await runJob(storage, deps)).toEqual({ kind: "after", ms: 20_000 });
  });

  it("past its deadline and grace with no answer, the pass is tried again, and out of tries the job says why", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, { ...run(), sent: 0 });
    const { deps, reports } = world({ down: Array.from({ length: 1_000 }, () => 503) });
    for (let pass = 0; pass < 3; pass += 1) {
      const next = await runJob(storage, deps);
      if (pass < 2) expect(next.kind).toBe("after");
      else expect(next).toEqual({ kind: "done" });
    }
    const last = reports.at(-1)!;
    expect(last.state).toBe("failed");
    expect(last.status).toBe("Stopped: Context didn't answer 3 times in a row (error 503)");
    expect(last.texts).toEqual([`I couldn't finish "Fix the flaky test": Context didn't answer 3 times in a row (error 503). Text me if you want me to try again.`]);
  });
});
