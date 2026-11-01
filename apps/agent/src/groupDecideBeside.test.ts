/**
 * Decide judges every group message (Dev2, 2026-11-01, after "Instinct, can
 * you do a speed test with Tex just like last time? ... can you test it?" was
 * taken as Tex's and answered "Sorry, my answer to that one got lost"). A
 * message whose words still look addressed (Tex's name opening or closing
 * it) starts its turn at once, and decide is asked beside it
 * (`groupTurn.ts` `decideBeside`): its silent drops the answer unsent, its
 * answer or wait sends it, and decide down or slow sends it. Its name inside
 * a question is decide's first, as any untagged text. A turn the gateway
 * answers with nothing (a group's SKIP, `apps/mcp/src/agent/route.js`) sends
 * nothing and leaves the chat as if Tex never spoke.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `addressesTex` keeping its name-in-a-question rule → "a message for
 *     another assistant that names Tex in a question goes to decide first"
 *     fails.
 *  2. `answerGroup` passing no `silenced` → "decide's silent drops the
 *     answer unsent…" and "the answer waits for a decide slower than the
 *     turn" fail.
 *  3. `groupTurn` not awaiting the verdict before sending → "the answer
 *     waits for a decide slower than the turn" fails.
 *  4. `groupTurn` sending a quiet answer as any other → "a quiet answer on a
 *     tagged turn sends nothing…" fails.
 *  5. `decideBeside` without its `addressesTex` check → "a reaction
 *     answering Tex's question is answered with no decide beside it" fails.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { answerAll, LINES, setup, silent, untaggedSilent } from "./groupWorld.testing";
import { SENT_KEY } from "./groupSay";

const answers = (texts: string[]) => texts.filter((text) => text.startsWith("answer to"));
const logged = (logs: ReturnType<typeof vi.spyOn>) => logs.mock.calls.flat().join("\n");

afterEach(() => vi.restoreAllMocks());

for (const { name, groupId } of LINES) {
  describe(`decide beside an addressed turn, ${name}`, () => {
    it("a message for another assistant that names Tex in a question goes to decide first, and its silent answers nothing", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: untaggedSilent, control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      const said = w.texts.length;
      expect(await acceptGroup(storage, w.message("Instinct, can you do a speed test with Tex just like last time? can you test it?"), 10)).toBe("kept");
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)).toMatchObject({ running: false });
      expect(w.decided.at(-1)!.addressed).toBeUndefined();
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex hi"]);
      expect(w.texts.length).toBe(said);
    });

    it("a named question starts its turn at once and decide runs beside it; its answer is sent once", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: answerAll });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(w.decided).toEqual([expect.objectContaining({ addressed: true, running: false })]);
      expect(w.decided[0].transcript).toContain("15% of 80");
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex, what's 15% of 80?"]);
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
      expect(w.cancels).toEqual([]);
    });

    it("decide's silent drops the answer unsent, cancels the running turn, and Tex never spoke", async () => {
      const storage = new MemoryStorage();
      const logs = vi.spyOn(console, "log");
      const w = setup(groupId, { hold: true, decide: silent, agent: (body) => ({ answer: `answer to ${body.question}`, askIds: ["aaaaaaaa-0000-4000-8000-000000000003"] }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      // Decide answered first: the turn still running is cancelled, so the gateway keeps nothing of it.
      while (w.cancels.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(w.cancels).toEqual([{ turn: w.asks[0].turn }]);
      w.release();
      await draining;
      expect(answers(w.texts)).toEqual([]);
      expect(w.stale).toEqual([{ asks: ["aaaaaaaa-0000-4000-8000-000000000003"] }]);
      expect(await storage.get("gfollow")).toBeUndefined();
      expect(logged(logs)).toContain('"outcome":"decide_vetoed"');
      expect(logged(logs)).not.toContain('"outcome":"answered"');
    });

    it("a wait from decide is an answer for an addressed message: sent, never held", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: true, act: "wait", covers: [], stale: [], movedOn: false, confidence: 0.9, waitSeconds: 3 }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
    });

    it("decide down: the addressed answer is sent, as before decide", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: false, reason: "unavailable" }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
    });

    it("the answer waits for a decide slower than the turn, and goes once decide says answer", async () => {
      const storage = new MemoryStorage();
      let open = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      let answered = false;
      const w = setup(groupId, { decideWait: () => gate, agent: (body) => ((answered = true), { answer: `answer to ${body.question}` }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      const draining = drainGroup(storage, w.deps);
      while (!answered) await new Promise((resolve) => setTimeout(resolve, 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answers(w.texts)).toEqual([]);
      open();
      await draining;
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
    });

    it("a reply to Tex is decided first, as any untagged text, never a turn of its own before decide", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: untaggedSilent, control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      const [handle] = (await storage.get<string[]>(SENT_KEY)) ?? [];
      expect(handle).toBeTruthy();
      expect(await acceptGroup(storage, w.message("and saturday?", { replyTo: handle }), 10)).toBe("kept");
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)!.addressed).toBeUndefined();
      expect(w.asks).toHaveLength(1);
    });

    it("a reaction answering Tex's question is answered with no decide beside it: it is never left silent", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: untaggedSilent, agent: (body) => ({ answer: String(body.question).startsWith("Tex") ? "Want it in blue? 👍 or 👎?" : `answer to ${body.question}` }) });
      await acceptGroup(storage, w.message("Tex make a poster"), 0);
      await drainGroup(storage, w.deps);
      expect(await acceptGroup(storage, w.message("", { reaction: { how: "Liked", words: "Want it in blue? 👍 or 👎?", onTex: true } }), 10)).toBe("queued");
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(2);
      expect(w.decided.filter((body) => body.addressed)).toHaveLength(1);
      expect(answers(w.texts)).toHaveLength(1);
    });

    it("a quiet answer on a tagged turn sends nothing, leaves follow-along as it was, and is logged silent", async () => {
      const storage = new MemoryStorage();
      const logs = vi.spyOn(console, "log");
      const w = setup(groupId, { agent: () => ({ answer: "", quiet: true }) });
      await acceptGroup(storage, w.message("Tex, are you there?"), 0);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.texts).toEqual([]);
      expect(await storage.get("gfollow")).toBeUndefined();
      expect(logged(logs)).toContain('"outcome":"silent"');
      expect(logged(logs)).not.toContain('"outcome":"answered"');
    });
  });
}
