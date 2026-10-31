/**
 * Every background job reports to the chat's own turn, never to the chat
 * (`jobTexts.ts`; Dev2, 2026-10-30: "it should always report to the
 * coordinator, no exceptions, the coordinator should have complete authority
 * over the background processes, provide steering etc").
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `jobUpdate` not handing the words to the chat's turn → "a job's result is a turn of the chat, which says it in its own words".
 *  2. `reply.ts` dropping the SKIP check → "a report with nothing new texts nothing".
 *  3. `steerJobs` passing the report turn's text instead of its note → "the coordinator steers a running job with its own note, and only that".
 *  4. `jobUpdate` texting an update with no ask directly → "a report from before reports carried their ask is never texted straight in".
 *  5. `agentAnswer` ignoring `quiet` (2026-10-31) → "the gateway's quiet flag texts nothing, and a job it starts still runs".
 *  6. `reply.ts` and `inbox.ts` both without their control-word guard (either alone holds) → "a bare control word is never texted, on any path".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { drain, type InboxDeps } from "./inbox";
import { startJobs, type JobEntry, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 3_000_000;
const PHONE = "+15555550100";
const ASK = "compare cheap models for agent work";

type World = { bodies: Array<Record<string, unknown>>; sent: string[]; spawned: Array<[string, JobRun]>; steered: Array<[string, JobSteer]> };

function inboxDeps(world: World, answer: Record<string, unknown>): InboxDeps {
  return {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
      if (path === "/agent") {
        world.bodies.push(JSON.parse(String(init.body)));
        return Response.json(answer);
      }
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const text = body?.message?.parts?.[0]?.value;
      if (typeof text === "string") world.sent.push(text);
      return new Response("{}", { status: 200 });
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => NOW,
    spawnJob: async (id, job) => void world.spawned.push([id, job]),
    steerJob: async (id, steer) => (world.steered.push([id, steer]), true),
  };
}

async function oneJob(storage: MemoryStorage): Promise<string> {
  await startJobs(storage, [{ title: "Agentic benchmarks", brief: "b" }], {
    now: NOW,
    inbox: PHONE,
    origin: { kind: "phone", phone: PHONE, question: ASK },
    place: { chatId: "chat_1", messageId: "m_ask" },
    spawn: async () => {},
  });
  return [...(await storage.list<JobEntry>({ prefix: "job:" })).values()][0].id;
}

const done = (id: string, texts: string[], extra: Partial<JobUpdate> = {}): JobUpdate => ({
  id,
  pass: "pass-aaaaaaaa",
  state: "done",
  status: texts[0],
  texts,
  first: 0,
  asked: { from: PHONE, text: ASK },
  ...extra,
});

describe("a job reports to the chat's own turn", () => {
  it("a job's result is a turn of the chat, which says it in its own words", async () => {
    const storage = new MemoryStorage();
    const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
    const id = await oneJob(storage);
    const deps = inboxDeps(world, { answer: "None of the three beat Haiku, notes here: https://context.lc/n/models" });
    expect(await jobUpdate(storage, deps, done(id, ["I couldn't save the page update.", "https://context.lc/n/models"]))).toBe(true);
    expect(world.sent).toEqual([]);
    await drain(storage, deps);
    expect(world.bodies).toHaveLength(1);
    expect(world.bodies[0]).toMatchObject({
      question: ASK,
      event: "job_report",
      jobReport: { title: "Agentic benchmarks", state: "done", texts: ["I couldn't save the page update.", "https://context.lc/n/models"] },
    });
    expect(world.sent.join(" ")).toContain("None of the three beat Haiku");
    expect(world.sent.join(" ")).not.toContain("couldn't save");
  });

  it("a report with nothing new texts nothing", async () => {
    const storage = new MemoryStorage();
    const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
    const id = await oneJob(storage);
    const deps = inboxDeps(world, { answer: "SKIP" });
    await jobUpdate(storage, deps, done(id, ["Same as before."]));
    await drain(storage, deps);
    expect(world.bodies).toHaveLength(1);
    expect(world.sent).toEqual([]);
  });

  it("the gateway's quiet flag texts nothing, and a job it starts still runs", async () => {
    const storage = new MemoryStorage();
    const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
    const id = await oneJob(storage);
    const deps = inboxDeps(world, { answer: "", quiet: true, jobs: [{ title: "Agentic benchmarks, check", brief: "Read the page back." }] });
    await jobUpdate(storage, deps, done(id, ["Still saving."]));
    await drain(storage, deps);
    expect(world.sent).toEqual([]);
    expect(world.spawned.map(([, job]) => job.title)).toEqual(["Agentic benchmarks, check"]);
  });

  it("a bare control word is never texted, on any path (self-reviews fa3f7a, a0365e)", async () => {
    for (const answer of ["SKIP", "[SKIP]", "NOOP", "NO_REPLY"]) {
      const storage = new MemoryStorage();
      const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
      const id = await oneJob(storage);
      const deps = inboxDeps(world, { answer });
      await jobUpdate(storage, deps, done(id, ["Done."]));
      await drain(storage, deps);
      expect(world.sent).toEqual([]);
    }
  });

  it("the coordinator can start the job again, on the person's own words", async () => {
    const storage = new MemoryStorage();
    const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
    const id = await oneJob(storage);
    const deps = inboxDeps(world, { answer: "That came back short, running it again.", jobs: [{ title: "Agentic benchmarks, again", brief: "Read the page back first." }] });
    await jobUpdate(storage, deps, done(id, ["Ran out of steps."]));
    await drain(storage, deps);
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0][1]).toMatchObject({ title: "Agentic benchmarks, again", origin: { kind: "phone", phone: PHONE, question: ASK } });
  });

  it("the coordinator steers a running job with its own note, and only that", async () => {
    const storage = new MemoryStorage();
    const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
    const id = await oneJob(storage);
    await startJobs(storage, [{ title: "Trip plan", brief: "b" }], {
      now: NOW,
      inbox: PHONE,
      origin: { kind: "phone", phone: PHONE, question: "plan the trip" },
      place: { chatId: "chat_1", messageId: "m_trip" },
      spawn: async () => {},
    });
    const trip = [...(await storage.list<JobEntry>({ prefix: "job:" })).values()].find((entry) => entry.title === "Trip plan")!.id;
    const deps = inboxDeps(world, { answer: "SKIP", steers: [{ id: trip, note: "Read the note back before you say it saved." }, { id: trip }] });
    await jobUpdate(storage, deps, done(id, ["Saved the page."]));
    await drain(storage, deps);
    expect(world.steered).toEqual([[trip, expect.objectContaining({ text: "(From your coordinator, the chat's own turn, not their words: Read the note back before you say it saved.)" })]]);
    expect(JSON.stringify(world.steered)).not.toContain(ASK);
  });

  it("a report from before reports carried their ask is never texted straight in", async () => {
    const storage = new MemoryStorage();
    const world: World = { bodies: [], sent: [], spawned: [], steered: [] };
    const id = await oneJob(storage);
    const deps = inboxDeps(world, { answer: "x" });
    expect(await jobUpdate(storage, deps, done(id, ["Old words."], { asked: undefined }))).toBe(true);
    await drain(storage, deps);
    expect(world.sent).toEqual([]);
    expect(world.bodies).toEqual([]);
  });
});
