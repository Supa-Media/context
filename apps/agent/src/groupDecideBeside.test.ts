/**
 * The one judge before every group message (Dev2, 2026-11-11, replacing
 * 2026-11-01's decide beside an addressed turn): no word rule starts a turn at
 * once. A message naming Tex, @-tagging it or replying to it is judged first,
 * like any other, and only the judge's answer starts a turn; its silent runs
 * no turn at all, so nothing is cancelled. In a chat Tex is not set up in, the
 * judge looks at the message alone (`firstLook`, no ledger key); in a bound
 * chat it reads the chat's log and its verdict is kept in the ledger
 * (`ledger` key). A turn the gateway answers with nothing (a group's SKIP)
 * sends nothing and leaves the chat as if Tex never spoke.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  4. `groupTurn` sending a quiet answer as any other → "a quiet answer on a
 *     tagged turn sends nothing…" fails.
 *  8. (2026-11-11) `chooseGroupTurn` answering a burst without asking the
 *     judge → "the judge's silent runs no turn" fails.
 *  9. (2026-11-11) `ask` sending no `ledger` key in a bound chat → "a reply to
 *     Tex is judged with the chat's ledger key" fails.
 * Records 1, 2, 3, 5, 6 and 7 tested `addressesTex` and `decideBeside`, both
 * deleted on 2026-11-11.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { answerAll, fakeJudge, LINES, setup, silent } from "./groupWorld.testing";
import { SENT_KEY } from "./groupSay";

const answers = (texts: string[]) => texts.filter((text) => text.startsWith("answer to"));
const logged = (logs: ReturnType<typeof vi.spyOn>) => logs.mock.calls.flat().join("\n");

afterEach(() => vi.restoreAllMocks());

for (const { name, groupId } of LINES) {
  describe(`the judge before an addressed message, ${name}`, () => {
    it("a message for another assistant that names Tex is the judge's, and its silent answers nothing", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: (body) => (body.transcript.includes("Instinct") ? silent() : answerAll(body)), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      const said = w.texts.length;
      expect(await acceptGroup(storage, w.message("Instinct, can you do a speed test with Tex just like last time? can you test it?"), 10)).toBe("kept");
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)).toMatchObject({ running: false });
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex hi"]);
      expect(w.texts.length).toBe(said);
    });

    it("a named question is judged first, in a chat not set up yet alone and with no ledger key; its answer is sent once", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: answerAll });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(w.decided).toEqual([expect.objectContaining({ running: false })]);
      expect(w.decided[0].ledger).toBeUndefined();
      expect(w.decided[0].transcript).toContain("15% of 80");
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex, what's 15% of 80?"]);
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
      expect(w.cancels).toEqual([]);
    });

    it("the judge's silent runs no turn: nothing to cancel, and Tex never spoke", async () => {
      const storage = new MemoryStorage();
      const logs = vi.spyOn(console, "log");
      const w = setup(groupId, { decide: silent });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(w.asks).toEqual([]);
      expect(w.cancels).toEqual([]);
      expect(answers(w.texts)).toEqual([]);
      expect(logged(logs)).toContain('"outcome":"silent"');
      expect(logged(logs)).not.toContain('"outcome":"answered"');
    });

    it("a wait from the judge on one message is an answer: sent, never held", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: true, act: "wait", covers: [], stale: [], movedOn: false, confidence: 0.9, waitSeconds: 3 }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
    });

    // The judge down falls back to a waiting question only (`decideDownAnswer`): a tag with no question mark is a known gap.
    it("judge down: a waiting question is answered; a tag with no question mark is not", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: false, reason: "unavailable" }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      await drainGroup(storage, w.deps);
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
      await acceptGroup(storage, w.message("Tex turn this guy into a cat"), 10);
      await drainGroup(storage, w.deps);
      expect(answers(w.texts)).toHaveLength(1);
    });

    it("no turn starts before a slow judge answers, and it goes once the judge says answer", async () => {
      const storage = new MemoryStorage();
      let open = () => {};
      const gate = new Promise<void>((resolve) => (open = resolve));
      let asked = false;
      const w = setup(groupId, { decideWait: () => gate, agent: (body) => ((asked = true), { answer: `answer to ${body.question}` }) });
      await acceptGroup(storage, w.message("Tex, what's 15% of 80?"), 0);
      const draining = drainGroup(storage, w.deps);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(asked).toBe(false);
      open();
      await draining;
      expect(answers(w.texts)).toEqual(["answer to Tex, what's 15% of 80?"]);
    });

    it("a reply to Tex is judged with the chat's ledger key and shown as a reply to Tex; the judge's silent keeps it unanswered", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: (body) => (w.decided.length === 1 ? answerAll(body) : silent()), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      const [handle] = (await storage.get<string[]>(SENT_KEY)) ?? [];
      expect(handle).toBeTruthy();
      expect(await acceptGroup(storage, w.message("and saturday?", { replyTo: handle }), 10)).toBe("kept");
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)).toMatchObject({ running: false, ledger: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(w.decided.at(-1)!.transcript).toContain("(replying to You) and saturday?");
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex hi"]);
    });

    it("an @-tag of Tex mid-message and a bare Tex mid-message both go to the judge first", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: fakeJudge, control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("can @Tex check this for us?"), 0);
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(1);
      expect(answers(w.texts)).toEqual(["answer to can @Tex check this for us?"]);
      expect(await acceptGroup(storage, w.message("can Tex check this for us?"), 10)).toBe("kept");
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(2);
      expect(w.decided[1].transcript).toContain("can Tex check this for us?");
    });

    it("a reaction answering Tex's question goes to the judge as its line, and is answered when the judge says so", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: fakeJudge, agent: (body) => ({ answer: String(body.question).startsWith("Tex") ? "Want it in blue? 👍 or 👎?" : `answer to ${body.question}` }) });
      await acceptGroup(storage, w.message("Tex make a poster"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("", { reaction: { how: "Liked", words: "Want it in blue? 👍 or 👎?", onTex: true } }), 10);
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)!.transcript).toContain("on Tex's message");
      expect(w.asks).toHaveLength(2);
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

    it("a quiet answer with the classifier's react sends that tapback and no text (respond.js)", async () => {
      const storage = new MemoryStorage();
      const logs = vi.spyOn(console, "log");
      const w = setup(groupId, { agent: () => ({ answer: "", quiet: true, react: "🎉" }) });
      await acceptGroup(storage, w.message("Tex, we shipped it!"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([]);
      expect(w.reactions.at(-1)).toBe("🎉");
      expect(logged(logs)).toContain('"outcome":"reacted"');
    });

    it("an answer the classifier placed plain goes straight into the chat; any other goes under the message", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { agent: (body) => ({ answer: `answer to ${body.question}`, ...(String(body.question).includes("plain") ? { place: "plain" } : {}) }) });
      await acceptGroup(storage, w.message("Tex, plain please"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex, and under"), 10);
      await drainGroup(storage, w.deps);
      expect(answers(w.texts)).toHaveLength(2);
      expect(w.under[0]).toBeUndefined();
      expect(w.under[1]).toBeTruthy();
    });
  });
}
