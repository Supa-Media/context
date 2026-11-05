/**
 * A job started from a voice message, and a job part the gateway turns down.
 *
 * 2026-11-05 02:23 UTC: Dev2 asked Tex by voice message alone to research a
 * wedding trip. Tex started a background job, whose question was the text's
 * typed words: none. The gateway refused every part ("Ask a question.", 400),
 * the Worker read each refusal as a passing break and ran the next part at
 * once, and all ten parts went in eight seconds with no reason kept, twice
 * (the restart asked the same nothing). Now the gateway hands back what it
 * heard (`clients.ts` `heard`), the job is asked it (`jobs.ts` `jobQuestion`),
 * and a part turned down before it ran ends the job and says why (`jobRun.ts`
 * `rejected`).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `onJobs` called without `answer.heard` (`reply.ts`) → "a job started from a voice message is asked what was said".
 *  2. `outcomeOf` mapping a refused `unavailable` to `broken` → "a part the gateway turns down ends the job at once, with the reason".
 *  3. `refusalOf` (`agentRefusal.ts`) returning null for a 4xx → "a refusal is told apart from a break".
 */

import { describe, expect, it } from "vitest";
import { agentAnswer, type Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { runJob, type JobDeps } from "./jobRun";
import { jobQuestion, RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const SAID = "Research the wedding in Morocco: the times, what to wear, and a packing list.";

describe("a job started from a voice message", () => {
  it("is asked the words typed and the words said aloud", () => {
    expect(jobQuestion("", SAID)).toBe(SAID);
    expect(jobQuestion("also this", SAID)).toBe(`also this\n\n${SAID}`);
    expect(jobQuestion("  typed only  ")).toBe("typed only");
    expect(jobQuestion("", "   ")).toBe("");
    expect(jobQuestion("x".repeat(9_000), SAID)).toHaveLength(8_000);
  });

  it("a job started from a voice message is asked what was said", async () => {
    const storage = new MemoryStorage();
    const message: Message = {
      kind: "message",
      eventId: "e1",
      chatId: "chat_1",
      from: PHONE,
      messageId: "m_e1",
      text: "",
      attachments: [{ url: "https://media.example/voice.caf", mimeType: "audio/x-caf", filename: "Audio_Message.caf", size: 1000 }],
    };
    await accept(storage, message, NOW);
    const spawned: JobRun[] = [];
    const deps: InboxDeps = {
      fetch: (async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
        if (path === "/agent") return Response.json({ answer: "On it.", jobs: [{ title: "Morocco trip", brief: "Find the wedding times." }], heard: SAID });
        return new Response("{}", { status: 200 });
      }) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "k",
      now: () => NOW,
      spawnJob: async (_id, job) => void spawned.push(job),
    };
    await drain(storage, deps);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].origin).toMatchObject({ kind: "phone", question: SAID });
  });
});

describe("a job part the gateway turns down", () => {
  it("a refusal is told apart from a break", () => {
    expect(agentAnswer(400, { error: "invalid_request", error_description: "Ask a question." })).toEqual({ kind: "unavailable", refused: "400 Ask a question." });
    expect(agentAnswer(403, { error: "invalid_request" })).toEqual({ kind: "unavailable", refused: "403 invalid_request" });
    // A fresh session or a quieter moment can pass: these stay breaks, tried again.
    expect(agentAnswer(401, { error: "invalid_token" })).toEqual({ kind: "unavailable" });
    expect(agentAnswer(408, {})).toEqual({ kind: "unavailable" });
    expect(agentAnswer(500, {})).toEqual({ kind: "unavailable" });
    expect(agentAnswer(502, { error: "model_unavailable" })).toEqual({ kind: "unavailable" });
    expect(agentAnswer(200, { answer: "Done.", heard: `  ${SAID}  ` })).toMatchObject({ kind: "answer", heard: SAID });
  });

  const job = (): JobRun => ({
    id: "job-1234-abcd",
    inbox: PHONE,
    title: "Morocco trip",
    brief: "Find the wedding times.",
    origin: { kind: "phone", phone: PHONE, question: "" },
    attempt: 1,
    tries: 0,
    startedAt: NOW,
  });

  function jobDeps(status: number, body: Record<string, unknown>) {
    const reports: JobUpdate[] = [];
    let asked = 0;
    const deps: JobDeps = {
      fetch: (async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "America/New_York" });
        if (path === "/agent") {
          asked += 1;
          return Response.json(body, { status });
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
    return { deps, reports, asked: () => asked };
  }

  it("a part the gateway turns down ends the job at once, with the reason", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, job());
    const { deps, reports, asked } = jobDeps(400, { error: "invalid_request", error_description: "Ask a question." });
    expect(await runJob(storage, deps)).toEqual({ kind: "done" });
    expect(asked()).toBe(1);
    const last = reports.at(-1)!;
    expect(last.state).toBe("failed");
    expect(last.status).toContain("Ask a question.");
    expect(last.texts?.[0]).toContain("Ask a question.");
  });

  it("a part that broke on the way still carries on in the next one", async () => {
    const storage = new MemoryStorage();
    await storage.put(RUN_KEY, job());
    const { deps } = jobDeps(500, {});
    expect(await runJob(storage, deps)).toEqual({ kind: "now" });
  });
});
