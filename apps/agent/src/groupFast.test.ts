/**
 * How fast a group is answered, and that the answer still fits (the group
 * review of 2026-10-30, "Speed up Tex replies in groups"): a named message
 * never waits on decide, a fixed line such as "Tex, settings" never waits
 * behind another turn, and a reply drafted for an older ask is looked at
 * again before it sends.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `chooseGroupTurn` without `addressedTurn` (decide asked first, as
 *     before) → "a named message never waits on decide" fails.
 *  2. `drainOnce` returning on a handed turn without `answerBesideTurn` →
 *     "Tex, settings is answered while another turn runs" fails.
 *  3. `answeredByCode` true for anything `byCode` → "a yes, a 👍, a
 *     routine's run…" fails.
 *  4. `once` in `groupSay.ts` scoping every part to the handed turn, as
 *     before → "a turn's parts are only the ones under its own messages"
 *     fails.
 *  5. `groupTurn` sending without `recheckDraft` → "a draft for an older ask
 *     is held…" fails.
 *  6. `recheckDraft` never marking `rechecked` → "an ask held once is
 *     never held again…" fails.
 *  7. `recheckDraft` counting somebody else's words → "only the asker's own
 *     newer words…" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { answerAll, BO, LINES, setup, silent, type Answer, type Decide } from "./groupWorld.testing";
import { answerHanded, failHanded, TURN_KEY } from "./groupTurnRun";
import { runGroupTurn, type InboxCall } from "./groupTurnWorkflow";
import { answeredByCode } from "./groupBeside";
import { recheckDraft } from "./groupRecheck";
import { say, sendingFor } from "./groupSay";
import type { GroupPending } from "./groupTurn";

const queue = (body: Decide): Answer => (body.running ? ({ ...answerAll(body), midTurn: "queue" } as Answer) : answerAll(body));
const ASK_ID = "aaaaaaaa-0000-4000-8000-000000000002";

/** A chat whose turns go to a workflow, run by hand (`groupTurnWorkflow.test.ts` has the full stand-in). */
function handed(groupId: string, opts: Parameters<typeof setup>[1] = {}) {
  const storage = new MemoryStorage();
  const w = setup(groupId, opts);
  const started: string[] = [];
  const deps = { ...w.deps, startTurn: async (turn: string) => void started.push(turn) };
  const inbox: InboxCall = async (path, turn) => Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(storage, deps, turn) });
  const step = { do: async <T>(_name: string, ...rest: unknown[]) => await (rest.at(-1) as () => Promise<T>)() } as Parameters<typeof runGroupTurn>[1];
  const run = (turn = started.at(-1)!) => runGroupTurn({ inbox: "inbox", turn }, step, inbox);
  return { storage, w, deps, started, run };
}

for (const { name, groupId } of LINES) {
  describe(`a group answered fast, ${name}`, () => {
    it("a named message never waits on decide: it is answered with decide never answering", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decideWait: () => new Promise<void>(() => {}), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.decided).toEqual([]);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight"]);
    });

    it("Tex, settings is answered while another turn runs, and that turn still answers after", async () => {
      const { storage, w, deps, run } = handed(groupId, { hold: true, decide: silent });
      await acceptGroup(storage, w.message("Tex make a poster"), 0);
      await drainGroup(storage, deps);
      const turn = run();
      await w.running;
      expect(await acceptGroup(storage, w.message("tex, settings", { from: BO }), 10)).toBe("queued");
      await drainGroup(storage, deps);
      // The menu went while the poster turn is still held, and only the poster went to the model.
      expect(w.texts.some((text) => text.includes("1"))).toBe(true);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual([]);
      expect(w.control.at(-1)).toMatchObject({ sender: BO });
      expect(w.control.at(-1)!.mint).toBeUndefined();
      w.release();
      expect(await turn).toBe("done");
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a poster"]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex make a poster"]);
      expect([...(await storage.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    });

    it("the menu sent beside a turn is never taken for that turn's part: a retry of the turn still sends its answer", async () => {
      let fail = true;
      const { storage, w, deps, run } = handed(groupId, {
        hold: true,
        decide: silent,
        agent: (body) => {
          if (fail) throw new Error("the gateway fell over");
          return { answer: `answer to ${body.question}` };
        },
      });
      await acceptGroup(storage, w.message("Tex make a poster"), 0);
      await drainGroup(storage, deps);
      const turn = run();
      await w.running;
      await acceptGroup(storage, w.message("tex, settings"), 10);
      await drainGroup(storage, deps);
      const menu = w.texts.length;
      expect(menu).toBeGreaterThan(0);
      fail = false;
      w.release();
      await turn;
      expect(await storage.get(TURN_KEY)).toBeUndefined();
      expect(w.texts.slice(menu).filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex make a poster"]);
    });

    it("a yes, a 👍, a routine's run and a job's report still wait for the running turn: each is a model turn", () => {
      const w = setup(groupId);
      const item = (text: string, extra: Record<string, unknown> = {}) => ({ message: w.message(text), attempts: 0, byCode: true as const, ...extra });
      expect(answeredByCode(item("yes"), [])).toBe(false);
      expect(answeredByCode({ ...item("Loved it"), message: { ...w.message("Loved it"), reaction: { how: "like", words: "x" } } } as never, [])).toBe(false);
      expect(answeredByCode({ ...item("Tex settings"), message: { ...w.message("Tex settings"), routine: { runId: "r", path: "p" } } } as never, [])).toBe(false);
      expect(answeredByCode({ message: w.message("Tex what's on"), attempts: 0 }, [])).toBe(false);
      // Answered by code alone: the commands, a menu reply, a style choice, an SMS group's line.
      expect(answeredByCode(item("tex, settings"), [])).toBe(true);
      expect(answeredByCode(item("Tex stop"), [])).toBe(true);
      expect(answeredByCode(item("2", { setting: { kind: "menu" } }), [])).toBe(true);
      expect(answeredByCode(item("3", { engagement: "helpful" }), [])).toBe(true);
      expect(answeredByCode(item("Tex hi", { message: w.message("Tex hi", { sms: true }) }), [])).toBe(true);
    });

    it("a draft for an older ask is held once, then one turn answers both; its asks are withdrawn", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        hold: true,
        decide: queue,
        recheck: () => ({ ok: true, fits: false }),
        agent: (body) => ({ answer: `answer to ${body.question}`, askIds: [ASK_ID] }),
      });
      await acceptGroup(storage, w.message("Tex save the playbook"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      expect(await acceptGroup(storage, w.message("Tex actually why is the build red?"), 10)).toBe("queued");
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.rechecks).toHaveLength(1);
      expect(w.rechecks[0]).toMatchObject({ draft: "answer to Tex save the playbook", style: "followAlong" });
      expect((w.rechecks[0].candidates as string[]).at(-1)).toBe(w.rechecks[0].newest);
      expect(w.rechecks[0].draftFor).not.toBe(w.rechecks[0].newest);
      expect(w.stale).toEqual([{ asks: [ASK_ID] }]);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex save the playbook", "Tex save the playbook\nTex actually why is the build red?"]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex save the playbook\nTex actually why is the build red?"]);
    });

    it("a draft that still fits is sent, and the newer ask is answered after it", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: queue });
      await acceptGroup(storage, w.message("Tex save the playbook"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex and what's the weather?"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.rechecks).toHaveLength(1);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex save the playbook", "answer to Tex and what's the weather?"]);
    });

    it("recheck unreachable: sent as before", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: queue, recheck: () => ({ ok: false, reason: "unavailable", cause: "model_failed" }) });
      await acceptGroup(storage, w.message("Tex save the playbook"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex and what's the weather?"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex save the playbook", "answer to Tex and what's the weather?"]);
    });

    it("only the asker's own newer words are rechecked: somebody else's tag is their own turn", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: queue, recheck: () => ({ ok: true, fits: false }) });
      await acceptGroup(storage, w.message("Tex save the playbook"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex what's the weather?", { from: BO }), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.rechecks).toEqual([]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex save the playbook", "answer to Tex what's the weather?"]);
    });

    it("a folded follow-up needs no recheck: the turn already read it", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("make it blue"), 10);
      w.release();
      await draining;
      expect(w.rechecks).toEqual([]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toHaveLength(1);
    });
  });

  describe(`a group's last look and its parts, ${name}`, () => {
    it("a turn's parts are only the ones under its own messages: a fixed line beside it is never one", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      const mine = w.message("Tex make a poster");
      const other = w.message("tex, settings", { from: BO });
      sendingFor(storage, "turn-1", [mine.messageId]);
      await say(storage, w.deps, mine, "Here's the poster.");
      await say(storage, w.deps, other, "Settings menu");
      sendingFor(storage, null);
      expect([...(await storage.list({ prefix: "gpart:turn-1:" })).keys()]).toHaveLength(1);
      expect(w.texts).toEqual(["Here's the poster.", "Settings menu"]);
    });

    it("an ask held once is never held again, whatever the asker types next", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { recheck: () => ({ ok: true, fits: false }) });
      const put = (seq: number, item: GroupPending) => storage.put(`gpending:${String(seq).padStart(12, "0")}`, item);
      const old = w.message("Tex save the playbook");
      await put(1, { message: old, attempts: 0, at: 0, ev: "0000000000001-000001" });
      await put(2, { message: w.message("Tex why is the build red?"), attempts: 0, at: 10, ev: "0000000000010-000002" });
      const ask = { message: old, covers: ["0000000000001-000001"], upTo: 0, text: "Saved." };
      expect(await recheckDraft(storage, w.deps, ask)).toBe("held");
      await put(3, { message: w.message("Tex and the logs?"), attempts: 0, at: 20, ev: "0000000000020-000003" });
      expect(await recheckDraft(storage, w.deps, { ...ask, covers: ["0000000000001-000001", "0000000000010-000002"], upTo: 10 })).toBe("send");
      expect(w.rechecks).toHaveLength(1);
    });
  });
}
