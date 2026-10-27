import { describe, expect, it } from "vitest";
import { acceptGroupRoutine, drainGroup, type GroupDeps } from "./groupInbox";
import { CHAT_LOOK_PATH, chatRoutineMessage, chatRoutineRunOf, chatWhereOf, saysSkip, type ChatRoutineRun } from "./groupRoutines";
import { runDueRoutines } from "./routines";
import { fetchDueRoutines, type DueRoutine, type Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";

/*
 * A chat routine (the owner, 2026-10-27; docs/decisions/texting-assistant/chat-routines.md).
 *
 * Sabotage record (2026-10-27), each fails a test here:
 *  - dropping the "writer still in the chat" check in `answerGroup`: "runs only while its writer is in the chat";
 *  - dropping the `status !== "ready"` check for a routine: "a chat that can't run it now hears nothing".
 */

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const RUN: ChatRoutineRun = { runId: "run_abc123", path: "tex/routines/daily/shifts.md", phone: ADA, line: LINE, groupId: GROUP };

type World = { sends: Record<string, unknown>[]; control: Record<string, unknown>[]; asks: Record<string, unknown>[]; results: Record<string, unknown>[]; reactions: number; members: string[] | null };

function deps(world: World, answers: { control?: unknown; answer?: string } = {}): GroupDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) {
      if (world.members === null) return new Response("{}", { status: 404 });
      return Response.json({ data: { group_id: GROUP, participants: world.members.map((number) => ({ number })) } });
    }
    const body = JSON.parse(String(init.body));
    if (path === "/api/send-group-message") {
      world.sends.push(body);
      return Response.json({ message_handle: `h_out_${world.sends.length}` });
    }
    if (path === "/api/send-reaction") {
      world.reactions++;
      return Response.json({});
    }
    if (path === "/agent-texts/group") {
      world.control.push(body);
      return Response.json(answers.control ?? { status: "ready", slug: "crystal-care", intro: false, bound: true, timeZone: "UTC", handle: "ada", minted: true, accessToken: "cat_group" });
    }
    if (path === "/agent-texts/routines/result") {
      world.results.push(body);
      return Response.json({ status: "recorded" });
    }
    if (path === "/agent") {
      world.asks.push(body);
      return Response.json({ answer: answers.answer ?? "On shift today: Bo." });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example.test",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example.test",
    sendblue: { keyId: "id", secret: "key" },
    now: () => 1_000,
  };
}

const world = (members: string[] | null = [ADA, BO]): World => ({ sends: [], control: [], asks: [], results: [], reactions: 0, members });

async function run(w: World, answers: { control?: unknown; answer?: string } = {}) {
  const storage = new MemoryStorage();
  expect(await acceptGroupRoutine(storage, RUN, 1_000)).toBe("queued");
  await drainGroup(storage, deps(w, answers));
}

describe("a chat routine's run", () => {
  it("is its writer's tag: checked like one, answered into the chat, reported", async () => {
    const w = world();
    await run(w);
    expect(w.control[0]).toMatchObject({ sender: ADA, mint: true, participants: [ADA, BO], routine: true });
    expect(String(w.asks[0]!.question)).toContain("tex/routines/daily/shifts.md");
    expect(w.sends.map((send) => send.content)).toEqual(["On shift today: Bo."]);
    expect(w.sends[0]!.reply_to).toBeUndefined();
    expect(w.reactions).toBe(0);
    expect(w.results).toEqual([{ runId: "run_abc123", outcome: "answered", texted: 1 }]);
  });

  it("says nothing when it has nothing to say", async () => {
    const w = world();
    await run(w, { answer: "SKIP" });
    expect(w.sends).toEqual([]);
    expect(w.results[0]).toMatchObject({ outcome: "skipped" });
  });

  it("runs only while its writer is in the chat", async () => {
    const w = world([BO]);
    await run(w);
    expect(w.control).toEqual([]);
    expect(w.sends).toEqual([]);
    expect(w.results[0]).toMatchObject({ outcome: "no_chat" });
    const unread = world(null);
    await run(unread);
    expect(unread.control).toEqual([]);
    expect(unread.results[0]).toMatchObject({ outcome: "no_chat" });
  });

  it("a chat that can't run it now hears nothing", async () => {
    for (const control of [{ status: "unknown_sender", tell: true }, { status: "not_allowed", slug: "crystal-care" }, { status: "no_shared" }]) {
      const w = world();
      await run(w, { control });
      expect(w.sends).toEqual([]);
      expect(w.asks).toEqual([]);
      expect(w.results[0]).toMatchObject({ outcome: "no_chat" });
    }
  });
});

describe("handing a chat routine out", () => {
  it("reads a chat run without a token, and a phone run only with one", async () => {
    const runs = [
      { runId: "run_a", path: "tex/routines/daily/a.md", timeZone: "UTC", send: "text", phones: [ADA], chat: "a".repeat(64) },
      { runId: "run_b", path: "tex/routines/daily/b.md", timeZone: "UTC", send: "text", phones: [ADA] },
      { runId: "run_c", path: "tex/routines/daily/c.md", timeZone: "UTC", send: "text", phones: [ADA], chat: "not-a-key" },
    ];
    const fetcher = (async () => Response.json({ runs })) as unknown as Fetch;
    const due = await fetchDueRoutines(fetcher, "https://control.example.test", "secret");
    expect(due.map((entry) => [entry.runId, entry.chat, entry.accessToken])).toEqual([["run_a", "a".repeat(64), ""]]);
  });

  it("goes to the chat, never the gateway's runner, and a chat it can't find is no_chat", async () => {
    const posted: string[] = [];
    const results: unknown[] = [];
    const due: DueRoutine[] = [{ runId: "run_a", accessToken: "", path: "tex/routines/daily/a.md", timeZone: "UTC", send: "text", phones: [ADA], chat: "a".repeat(64) }];
    const fetcher = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      posted.push(path);
      if (path === "/agent-texts/routines/due") return Response.json({ runs: due });
      if (path === "/agent-texts/routines/result") {
        results.push(JSON.parse(String(init.body)));
        return Response.json({ status: "recorded" });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch;
    const handed: DueRoutine[] = [];
    const base = { fetch: fetcher, controlPlaneOrigin: "https://c.test", workerSecret: "s", gatewayOrigin: "https://g.test", textPhone: async () => "texted" as const, log: () => {} };
    await runDueRoutines({ ...base, runInChat: async (entry) => (handed.push(entry), "queued") });
    expect(handed.map((entry) => entry.runId)).toEqual(["run_a"]);
    expect(posted).not.toContain("/agent");
    expect(results).toEqual([]);
    await runDueRoutines({ ...base, runInChat: async () => "no_chat" });
    expect(results).toEqual([{ runId: "run_a", outcome: "no_chat", texted: 0 }]);
  });

  it("reads only a well-formed run and place", () => {
    expect(chatRoutineRunOf(RUN)).toEqual(RUN);
    expect(chatRoutineRunOf({ ...RUN, phone: "ada" })).toBeNull();
    expect(chatRoutineRunOf({ ...RUN, runId: "x" })).toBeNull();
    expect(chatWhereOf({ line: LINE, groupId: GROUP })).toEqual({ line: LINE, groupId: GROUP });
    expect(chatWhereOf(true)).toBeNull();
    expect(chatRoutineRunOf({ ...RUN, timeZone: "America/New_York", since: 1_700_000_000_000 })).toEqual({ ...RUN, timeZone: "America/New_York", since: 1_700_000_000_000 });
    expect(chatRoutineRunOf({ ...RUN, timeZone: "x\ny", since: -1 })).toEqual(RUN);
    expect(saysSkip("SKIP.")).toBe(true);
  });

  it("tells the turn when it last ran, in the routine's own time zone", () => {
    const text = chatRoutineMessage({ ...RUN, timeZone: "America/New_York", since: Date.UTC(2026, 9, 27, 13, 5) }).text;
    expect(text).toContain("It last ran Oct 27, 9:05 AM EDT");
    expect(chatRoutineMessage(RUN).text).not.toContain("last ran");
  });

  it("a chat's own check-in looks at the workspace's activity and shared mail, never a note, and leaves personal mail to its owner", () => {
    const text = chatRoutineMessage({ ...RUN, path: CHAT_LOOK_PATH, timeZone: "UTC", since: 1_700_000_000_000 }).text;
    expect(text).toContain("after:1700000000");
    expect(text).toContain("fetch activity:");
    expect(text).toContain("concerns only the mailbox's owner personally");
    expect(text).toContain("SKIP");
    expect(text).not.toContain("routine");
    expect(saysSkip("Skip the meeting today")).toBe(false);
  });
});
