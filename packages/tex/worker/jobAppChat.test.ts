/**
 * A background job started from the in-app chat runs as the app's user
 * (`personSession.ts`). On 2026-11-21 "Daniel 6 study notes" started from the
 * app, and its first pass asked the control plane for the session of the
 * "phone" `app:<userId>`, found nobody, and ended silently: no part ran, so
 * nothing was logged, written or said.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `phoneTurn` back on `openSession(..., run.origin.phone)` → "runs an app chat's job as its user, and its part reaches the gateway".
 *  2. `jobsFor` without the app-chat placement check → "starts jobs only in the object the gateway placed for the app chat".
 *  3. `phoneTurn` stopping without `log("no_session")` → "logs a job that could not open a session, never ending it unseen".
 *  4. `readJobUpdate` taking only a phone as `asked.from` → "queues an app chat's job report in its chat, never dropped as unaddressed".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { acceptJob, jobToken, runJob, type JobDeps } from "./jobRun";
import { readJobUpdate, type JobEntry, type JobRun, type JobUpdate } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";

const NOW = 1_000_000;
const USER = "k57a8b9c0d1e2f3g4h5j6m7n8p9q0r1s";
const APP = `app:${USER}`;

const run = (asker: string): JobRun => ({
  id: "job-1234-abcd",
  inbox: asker,
  title: "Daniel 6 study notes",
  brief: "Write daniel-6.md in the same format as daniel-5.md.",
  origin: { kind: "phone", phone: asker, question: "Prepare daniel 6 notes for me" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
});

function jobDeps() {
  const sessions: Array<{ path: string; body: Record<string, unknown> }> = [];
  const asked: Array<Record<string, unknown>> = [];
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (path === "/agent-texts/app-session") {
        sessions.push({ path, body });
        return Response.json(body.userId === USER ? { status: "linked", accessToken: "app-token", timeZone: "America/New_York" } : { status: "unlinked" });
      }
      if (path === "/agent-texts/session") {
        sessions.push({ path, body });
        // The control plane knows no phone `app:<userId>`: what the job was asking until 2026-11-21.
        return Response.json(String(body.phone).startsWith("+") ? { status: "linked", accessToken: "phone-token", timeZone: "America/New_York" } : { status: "unlinked" });
      }
      if (path === "/agent") {
        asked.push({ ...body, token: new Headers(init.headers).get("authorization") });
        return Response.json({ answer: "Saved areas/spirit/bible-study/daniel/daniel-6.md." });
      }
      return new Response("{}", { status: 200 });
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
  return { deps, sessions, asked, reports };
}

afterEach(() => vi.restoreAllMocks());

describe("a job started from the in-app chat", () => {
  it("runs an app chat's job as its user, and its part reaches the gateway", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run(APP), NOW);
    const { deps, sessions, asked, reports } = jobDeps();
    await runJob(storage, deps);
    expect(sessions.map((call) => call.path)).not.toContain("/agent-texts/session");
    expect(sessions.some((call) => call.path === "/agent-texts/app-session" && call.body.userId === USER)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ question: "Prepare daniel 6 notes for me", job: { id: "job-1234-abcd", title: "Daniel 6 study notes" } });
    expect(String(asked[0].token)).toContain("app-token");
    expect(reports.at(-1)).toMatchObject({ state: "done" });
    expect(await jobToken(run(APP), deps)).toBe("app-token");
  });

  it("still runs a phone's job by its number", async () => {
    const storage = new MemoryStorage();
    await acceptJob(storage, run("+15555550100"), NOW);
    const { deps, sessions, asked } = jobDeps();
    await runJob(storage, deps);
    expect(sessions.every((call) => call.path === "/agent-texts/session")).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("logs a job that could not open a session, never ending it unseen", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
    const storage = new MemoryStorage();
    // An `app:` id that names no user has no session at all: nothing runs, and the control plane is never asked by phone.
    await acceptJob(storage, run("app:NOT-A-USER"), NOW);
    const { deps, sessions, asked, reports } = jobDeps();
    await runJob(storage, deps);
    expect(asked).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ state: "failed", status: expect.stringContaining("no session") });
    expect(reports.at(-1)?.texts).toBeUndefined();
    expect(sessions).toHaveLength(0);
    expect(logs.some((line) => line.includes('"outcome":"no_session"'))).toBe(true);
  });
});

describe("the app chat's object starting jobs", () => {
  async function turn(chatId: string, from: string, appChat?: string) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    const message: Message = { kind: "message", eventId: "e1", chatId, from, messageId: "m_e1", text: "Prepare daniel 6 notes for me" };
    await accept(storage, message, NOW);
    const spawned: JobRun[] = [];
    const deps: InboxDeps = {
      fetch: (async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/app-session") return Response.json({ status: "linked", accessToken: "app-token" });
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
        if (path === "/agent") return Response.json({ answer: "On it.", jobs: [{ title: "Daniel 6 study notes", brief: "Write it." }] });
        return new Response("{}", { status: 200 });
      }) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "k",
      now: () => NOW,
      ...(appChat ? { appChat } : {}),
      spawnJob: async (_id, job) => void spawned.push(job),
    };
    await drain(storage, deps);
    return spawned;
  }

  it("starts jobs only in the object the gateway placed for the app chat", async () => {
    const placed = await turn(APP, APP, APP);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ inbox: APP, origin: { kind: "phone", phone: APP } });
    // A text from `app:<userId>` reaching any other chat object starts nothing as that user.
    expect(await turn("sendblue:+15555550199:+15555550100", APP, APP)).toHaveLength(0);
  });
});

describe("an app chat's job report", () => {
  it("queues an app chat's job report in its chat, never dropped as unaddressed", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
    const storage = new MemoryStorage();
    await storage.put<JobEntry>("job:job-1234-abcd", { id: "job-1234-abcd", title: "Daniel 6 study notes", state: "running", startedAt: NOW, chatId: APP, messageId: "m_e1" });
    const update = readJobUpdate({ id: "job-1234-abcd", state: "done", texts: ["Saved daniel-6.md."], pass: "0b7c2f4e-1111-4222-8333-944455556666", asked: { from: APP, text: "Prepare daniel 6 notes for me" } });
    expect(update?.asked).toEqual({ from: APP, text: "Prepare daniel 6 notes for me" });
    expect(await jobUpdate(storage, { now: () => NOW } as Parameters<typeof jobUpdate>[1], update!)).toBe(true);
    expect(logs.some((line) => line.includes("report_unaddressed"))).toBe(false);
    expect(logs.some((line) => line.includes('"outcome":"reported"'))).toBe(true);
    // Nobody else's id gets through: an `app:` id that names no user is still dropped.
    expect(readJobUpdate({ id: "job-1234-abcd", state: "done", asked: { from: "app:NOT-A-USER", text: "x" } })?.asked).toBeUndefined();
  });
});
