/**
 * Background jobs in a group chat (`jobs.ts`, `jobRun.ts`): started from a
 * tagged message, run with a grant the control plane issues again when the job
 * runs, and held, like any group answer, when somebody joined meanwhile.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `groupTurn` not reading the members again → "holds the result when somebody joined while it ran".
 *  2. `answerGroup` not starting `answer.jobs` → "a tagged message can start a job beside the chat".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptGroup, drainGroup, GROUP_LINES, type GroupDeps } from "./groupInbox";
import { acceptJob, runJob } from "./jobRun";
import { chatJobs, type JobRun, type JobUpdate } from "./jobs";
import { jobUpdate } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";
import type { GroupMessage } from "./sendblueGroups";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const CY = "+15555550103";
const GROUP = "11111111-2222-3333-4444-555555555555";
const NOW = 5_000_000;

const tagged: GroupMessage = {
  kind: "group-message",
  eventId: "sendblue:h_job",
  groupId: GROUP,
  line: LINE,
  from: ADA,
  participants: [ADA, BO, LINE],
  messageId: "h_ask",
  text: "Tex, research our competitors and write it up",
};

type World = { sends: { content: string; reply_to?: unknown }[]; asks: Record<string, unknown>[]; members: string[][] };

function deps(world: World, agent: unknown): GroupDeps & { spawned: Array<[string, JobRun]> } {
  let read = 0;
  const spawned: Array<[string, JobRun]> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) {
      const list = world.members[Math.min(read++, world.members.length - 1)];
      return Response.json({ data: { group_id: GROUP, participants: list.map((number) => ({ number })) } });
    }
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/api/send-group-message") {
      world.sends.push(body);
      return Response.json({ message_handle: `h_out_${world.sends.length}` });
    }
    if (path === "/api/send-reaction") return Response.json({});
    if (path === "/agent-texts/group") {
      return Response.json({ status: "ready", slug: "band", intro: false, timeZone: "UTC", handle: "ada", accessToken: "cat_group" });
    }
    if (path === "/agent") {
      world.asks.push(body);
      return Response.json(agent);
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example.test",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example.test",
    sendblue: { keyId: "id", secret: "key" },
    now: () => NOW,
    spawnJob: async (id, run) => void spawned.push([id, run]),
    spawned,
  };
}

const groupRun = (): JobRun => ({
  id: "job-group-1234",
  inbox: `sendblue-group:${GROUP}`,
  title: "Competitor research",
  brief: "Five competitors, into @band.",
  origin: { kind: "group", message: tagged, at: NOW },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
});

describe("background jobs in a group chat", () => {
  it("a tagged message can start a job beside the chat", async () => {
    const storage = new MemoryStorage();
    const world: World = { sends: [], asks: [], members: [[ADA, BO]] };
    const d = deps(world, { answer: "On it, I'll post it here when it's done.", jobs: [{ title: "Competitor research", brief: "Five.", tainted: true }] });
    expect(await acceptGroup(storage, tagged, NOW)).toBe("queued");
    await drainGroup(storage, d);
    expect(world.asks[0].running).toEqual([]);
    expect(world.sends.map((send) => send.content)).toEqual(["On it, I'll post it here when it's done."]);
    expect(d.spawned).toHaveLength(1);
    expect(d.spawned[0][1]).toMatchObject({ inbox: `sendblue-group:${GROUP}`, tainted: true, origin: { kind: "group", message: { messageId: "h_ask" } } });
    expect((await chatJobs(storage, NOW))[0]).toMatchObject({ title: "Competitor research", state: "running" });
  });

  it("runs the job with a grant issued again, and posts the result under the ask", async () => {
    const storage = new MemoryStorage();
    const world: World = { sends: [], asks: [], members: [[ADA, BO]] };
    const d = deps(world, { answer: "Wrote @band 1-projects/competitors.md." });
    const reports: JobUpdate[] = [];
    await acceptJob(storage, groupRun(), NOW);
    await runJob(storage, { ...d, report: async (_inbox, update) => (reports.push(update), true) });
    expect(world.asks[0]).toMatchObject({ question: tagged.text, job: { title: "Competitor research", attempt: 1 }, group: { from: "ada", chat: [] } });
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Wrote @band 1-projects/competitors.md."] });

    // The chat's own inbox posts it, threaded under the ask.
    const inbox = new MemoryStorage();
    const local = deps(world, {});
    await acceptGroup(inbox, tagged, NOW);
    await drainGroup(inbox, { ...local, fetch: deps(world, { answer: "On it.", jobs: [{ title: "Competitor research", brief: "b" }] }).fetch });
    const [entry] = await chatJobs(inbox, NOW);
    expect(await jobUpdate(inbox, { ...local, linqApiKey: "" }, { ...reports.at(-1)!, id: entry.id })).toBe(true);
    expect(world.sends.at(-1)).toMatchObject({ content: "Wrote @band 1-projects/competitors.md.", reply_to: { message_handle: "h_ask" } });
  });

  it("holds the result when somebody joined while it ran", async () => {
    const storage = new MemoryStorage();
    const world: World = { sends: [], asks: [], members: [[ADA, BO], [ADA, BO, CY]] };
    const d = deps(world, { answer: "Here are the competitors." });
    const reports: JobUpdate[] = [];
    await acceptJob(storage, groupRun(), NOW);
    await runJob(storage, { ...d, report: async (_inbox, update) => (reports.push(update), true) });
    expect(reports.at(-1)).toMatchObject({ state: "failed", texts: [GROUP_LINES.joined] });
  });
});
