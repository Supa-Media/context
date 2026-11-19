import { describe, expect, it } from "vitest";
import { acceptGroupRoutine, drainGroup, type GroupDeps } from "./groupInbox";
import { CHAT_LOOK_PATH, chatRoutineMessage, chatRoutineRunOf, chatWhereOf, saysSkip, type ChatRoutineRun } from "./groupRoutines";
import { runDueRoutines } from "./routines";
import type { Fetch } from "./clients";
import { fetchDueRoutines, type DueRoutine } from "./routineClients";
import { MemoryStorage } from "./memoryStorage.testing";
import { isBound, setChatBound } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";

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

function deps(world: World, answers: { control?: unknown; answer?: string; quiet?: true } = {}): GroupDeps {
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
      return Response.json({ answer: answers.answer ?? "On shift today: Bo.", ...(answers.quiet ? { quiet: true } : {}) });
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
  it("a check-in posts one bubble and no card, however long the model's answer", async () => {
    const w = world();
    const storage = new MemoryStorage();
    expect(await acceptGroupRoutine(storage, { ...RUN, path: CHAT_LOOK_PATH, timeZone: "UTC" }, 1_000)).toBe("queued");
    await drainGroup(storage, deps(w, { answer: "First part about the mail.\n\nSecond part.\n\nThird part." }));
    expect(w.sends).toHaveLength(1);
  });

  it("leaves the chat bound to its people, so untagged texts after it are still read", async () => {
    const w = world();
    const storage = new MemoryStorage();
    const said: GroupMessage = { kind: "group-message", eventId: "e1", groupId: GROUP, line: LINE, from: BO, participants: [LINE, ADA, BO], messageId: "m1", text: "which parts are out of date?" };
    await setChatBound(storage, said);
    expect(await acceptGroupRoutine(storage, RUN, 1_000)).toBe("queued");
    await drainGroup(storage, deps(w));
    expect(w.results[0]).toMatchObject({ outcome: "answered" });
    expect(await isBound(storage, said)).toBe(true);
  });

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

  /*
   * 2026-11-17 23:00 UTC, a WhatsApp group: the chat's check-in found no new mail and posted its reasoning with
   * "SKIP" at the end. Invented words in that shape. Sabotage record (2026-11-17), each fails the test below:
   *  - `groupModelTurn.ts` without `skipped` (only a bare SKIP read as one): the run reports "answered";
   *  - `groupLine.ts` `groupLineFor` without `guardedLine`, with the check above also off: the words are sent.
   */
  it("a scheduled check with nothing new posts nothing, however the skip was worded", async () => {
    const leaks = [
      "Nothing new in the shared folder since 5:52 PM, and nobody here is waiting on an answer. Nothing needs the group now. SKIP",
      "No new mail, and no follow-up is owed.\n\nSKIP",
      "SKIP. Nothing new since the last look.",
    ];
    for (const path of [CHAT_LOOK_PATH, RUN.path]) {
      for (const answer of leaks) {
        const w = world();
        const storage = new MemoryStorage();
        expect(await acceptGroupRoutine(storage, { ...RUN, path, timeZone: "UTC" }, 1_000)).toBe("queued");
        await drainGroup(storage, deps(w, { answer }));
        expect(w.sends, answer).toEqual([]);
        expect(w.results, answer).toEqual([{ runId: "run_abc123", outcome: "skipped", texted: 0 }]);
      }
    }
  });

  it("a scheduled check the gateway decided to keep quiet posts nothing: the flag, with no words", async () => {
    const w = world();
    const storage = new MemoryStorage();
    expect(await acceptGroupRoutine(storage, { ...RUN, path: CHAT_LOOK_PATH, timeZone: "UTC" }, 1_000)).toBe("queued");
    await drainGroup(storage, deps(w, { answer: "", quiet: true }));
    expect(w.sends).toEqual([]);
    expect(w.results[0]).toMatchObject({ outcome: "skipped" });
  });

  it("a scheduled check with news still posts it, the word skip in a sentence included", async () => {
    const w = world();
    const storage = new MemoryStorage();
    const said = "The plumber moved Thursday's visit to Friday at 9. Bo, can you be home, or should we skip this week?";
    expect(await acceptGroupRoutine(storage, { ...RUN, path: CHAT_LOOK_PATH, timeZone: "UTC" }, 1_000)).toBe("queued");
    await drainGroup(storage, deps(w, { answer: said }));
    expect(w.sends.map((send) => send.content)).toEqual([said]);
    expect(w.results[0]).toMatchObject({ outcome: "answered" });
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

  // Dev2, 2026-10-28: a check-in posted a long App Store status from the workspace's activity nobody in the chat asked about.
  it("a chat's own check-in looks only at shared mail and its own follow-ups, never the workspace's activity, and leaves personal mail to its owner", () => {
    const text = chatRoutineMessage({ ...RUN, path: CHAT_LOOK_PATH, timeZone: "UTC", since: 1_700_000_000_000 }).text;
    expect(text).toContain("after:1700000000");
    expect(text).not.toContain("fetch activity:");
    expect(text).toContain("other agents' work");
    expect(text).toContain("concerns only the mailbox's owner personally");
    // Silence is the say_nothing call, never a word to type (2026-11-17: "exactly SKIP" came back with its reasoning, and both were posted).
    expect(text).toContain("call send with action say_nothing");
    expect(text).not.toContain("SKIP");
    expect(text).not.toContain("routine");
    expect(saysSkip("Skip the meeting today")).toBe(false);
  });
});

describe("a routine kept in its chat's home", () => {
  // The owner, 2026-11-02: a chat's routines live in its home in @context-lc, so its turn is told where to read it.
  it("is read from @context-lc, and any other routine where it was", async () => {
    const { chatRoutineQuestion } = await import("./groupRoutines");
    expect(chatRoutineQuestion("tex/groups/orbit-lamp-river/routines/daily/shifts.md")).toContain(
      'tex/groups/orbit-lamp-river/routines/daily/shifts.md (context: "@context-lc")',
    );
    expect(chatRoutineQuestion("tex/routines/daily/shifts.md")).not.toContain("@context-lc");
    expect(chatRoutineQuestion("tex/groups/orbit-lamp-river/notes.md")).not.toContain("@context-lc");
  });
});

describe("the words a chat's routine and check-in turns are asked (kept in packages/shared)", () => {
  const where = { line: "+15555550100", groupId: "g1", runId: "run_1", phone: "+15555550101" };
  it("asks a chat routine in the same words", () => {
    expect(chatRoutineMessage({ ...where, path: "tex/groups/orbit-lamp-river/routines/rent.md" }).text).toBe(
      '(It\'s time for this chat\'s routine, tex/groups/orbit-lamp-river/routines/rent.md (context: "@context-lc"). Read that note and do what it says now, for everyone here, as if it had just been asked. If it only wants a word when there is something to say and there isn\'t, call send with action say_nothing: nothing is posted, and never write why you are quiet as your answer, since an answer is posted to everyone here.)',
    );
  });
  it("asks a chat's own check-in in the same words", () => {
    expect(chatRoutineMessage({ ...where, path: CHAT_LOOK_PATH, since: 1_790_000_000_000, timeZone: "UTC" }).text).toBe(
      "(Time for this chat's check-in: look on your own at what is new since Sep 21, 2:13 PM UTC, in four places only: mail shared with this chat (search it with after:1790000000), mail sent to this chat's own address (the notes in its folder's email/ that arrived since), calendars shared with this chat (read_calendar from today for the next 7 days, one account at a time; none shared, skip it), and what was asked of you in this chat that you said you would follow up on. Never post about the workspace's other activity, notes or other agents' work: nobody here asked. Post here only what someone in this chat needs to act on or know now, in one short line: what happened and who should handle it. Check what you find against what this chat already said: when a day, a time, a price or a plan doesn't match what someone here said, that mismatch is the news: name it and ask the one person it's about which is right, never guess. Leave out mail that concerns only the mailbox's owner personally: their own check-ins text them about it. Never post just to say hello or to summarize; newsletters, receipts and automated notices are not worth a message, and neither is anything you already posted here. If nothing needs the chat, call send with action say_nothing: nothing is posted, and never write why you are quiet as your answer, since an answer is posted to everyone here.)",
    );
  });
});
