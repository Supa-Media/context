/**
 * A group's turns are decided (`groupTurn.ts`, `groupStyle.ts`; Dev2,
 * 2026-10-26), on an iMessage group (Sendblue) and a WhatsApp group (Whapi).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `reachesDecide` returning true for every style → "which untagged
 *     messages reach decide (quiet)" and "(attentive)" fail.
 *  2. `reachesDecide` ignoring `asker` → "(attentive)" fails.
 *  3. `followingAlong` never stopping → "followAlong stops after 20…" fails.
 *  4. `chooseGroupTurn`'s fallback answering soft messages → "decide down:
 *     only what addressesTex accepts is answered" fails.
 *  5. `whileRunning` not steering on fold → "Ada's own follow-up…" fails.
 * 11. `whileRunning` without its asker check (`steerInto`/`restartTurn`
 *     refusing anyone else too, both dropped) → "three people's repeats…"
 *     and "somebody else's queue or restart…" fail.
 * 13. `expiredQuestion` never closing → "a style question nobody answers…"
 *     fails.
 * 12. `ownTurn` merging every sender into the asker's turn → "covers holding
 *     Ada's and Bo's messages…" and "somebody the control plane does not
 *     know…" fail.
 *  6. the first-ask branch in `answerGroup` removed → "the first addressed
 *     message asks the style question first…" fails.
 *  7. `chooseStyle` not re-queueing the held message → same test fails.
 *  8. the newcomer hold not logging `held_newcomer` → "an answer held for a
 *     newcomer…" fails.
 *  9. `ask` in `groupTurn.ts` rendering without `people` → "decide never
 *     shows a newcomer…" fails.
 * 10. `isAsker` true for anyone → "a guest's yes never releases…" fails.
 * 14. `acceptGroup` without the unbound check before logging mid-turn (W20)
 *     → "an untagged message during a turn in a chat that is not bound…"
 *     fails.
 * 15. `acceptGroup` without its catch around `whileRunning` (W21) → "a
 *     message seen mid-turn is never lost…" fails.
 * 16. `askLine` returning "" (W19) → "an ask event carries the ask line…"
 *     fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { keptEvents } from "./events";
import { ENGAGEMENT_QUESTION, FOLLOW_TEXTS } from "./groupStyle";
import { ADA, answerAll, BO, CY, decidedWords, LINE, LINES, setup, silent, type Answer } from "./groupWorld.testing";

for (const { name, groupId } of LINES) {
  describe(`a group's decided turns, ${name}`, () => {
    /*
      Which messages reach decide, per style. After Tex answered Ada with an
      ask (so her ask is open, and Tex has just spoken), Ada (the asker)
      and Bo each send an untagged text.
    */
    const table: [string, string[]][] = [
      ["quiet", []],
      ["attentive", ["make it shorter"]],
      ["followAlong", ["make it shorter", "lol nice"]],
      ["helpful", ["make it shorter", "lol nice"]],
    ];
    for (const [style, reach] of table) {
      it(`which untagged messages reach decide (${style})`, async () => {
        const storage = new MemoryStorage();
        const w = setup(groupId, {
          decide: (body) => (body.candidates.length === 1 && w.decided.length === 1 ? answerAll(body) : silent()),
          control: { engagement: style, engagementChosen: true },
          agent: () => ({ answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."] }),
        });
        await acceptGroup(storage, w.message("Tex draft the email to the venue"), 0);
        await drainGroup(storage, w.deps);
        expect(w.asks).toHaveLength(1);
        await acceptGroup(storage, w.message("make it shorter"), 10);
        await acceptGroup(storage, w.message("lol nice", { from: BO }), 11);
        await drainGroup(storage, w.deps);
        expect((await decidedWords(storage, w, groupId)).slice(1)).toEqual(reach);
        // Decide said silent: nothing more was answered, and they stay what the chat said.
        expect(w.asks).toHaveLength(1);
      });
    }

    it("followAlong is the default when the group has no style, and stops after 20 untagged texts", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: (body) => (w.decided.length === 1 ? answerAll(body) : silent()) });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      for (let i = 0; i < FOLLOW_TEXTS + 3; i += 1) {
        await acceptGroup(storage, w.message(`chat ${i}`, { from: BO }), 10 + i);
        await drainGroup(storage, w.deps);
      }
      expect((await decidedWords(storage, w, groupId)).slice(1)).toHaveLength(FOLLOW_TEXTS);
    });

    it("decide saying the chat moved on stops followAlong at once", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: (body) => (w.decided.length === 1 ? answerAll(body) : { ...silent(), movedOn: true } as Answer) });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("anyway, dinner?", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("pizza", { from: BO }), 20);
      await drainGroup(storage, w.deps);
      expect((await decidedWords(storage, w, groupId)).slice(1)).toEqual(["anyway, dinner?"]);
    });

    it("decide down: only what addressesTex accepts is answered, one at a time", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: false, reason: "capped" }), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("is it raining", { from: BO }), 10);
      await acceptGroup(storage, w.message("Tex and tomorrow?"), 11);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight", "Tex and tomorrow?"]);
    });

    it("answer is one turn covering what decide named, logged to the group's own log", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex check this link out"), 0);
      await acceptGroup(storage, w.message("https://reasonmachines.example/page"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.decided[0]).toMatchObject({ style: "followAlong", running: false, line: LINE });
      expect(w.asks).toHaveLength(1);
      expect(w.asks[0]).toMatchObject({ question: "Tex check this link out\nhttps://reasonmachines.example/page", covers: w.decided[0].candidates, chat: groupId });
      expect(typeof w.asks[0].turn).toBe("string");
      expect(w.events.every((post) => JSON.stringify(post.conversation) === JSON.stringify({ group: groupId }))).toBe(true);
      const posted = w.events.flatMap((post) => post.events);
      expect(posted.every((event) => event.chat === groupId)).toBe(true);
      const answer = posted.find((event) => event.from.kind === "tex" && event.text?.startsWith("answer to"))!;
      expect(answer).toMatchObject({ delivered: true, covers: w.decided[0].candidates, turn: w.asks[0].turn });
    });

    it("react puts a tapback on the newest untagged message and sends no answer; silent sends nothing", async () => {
      for (const act of ["react", "silent"] as const) {
        const storage = new MemoryStorage();
        // Untagged: an addressed message is always answered (code's floor), so only an untagged one can be left.
        const w = setup(groupId, {
          decide: (body) => (w.decided.length === 1 ? answerAll(body) : { ok: true, act, covers: [], stale: [], movedOn: false, confidence: 0.9 }),
          control: { engagement: "helpful", engagementChosen: true },
        });
        await acceptGroup(storage, w.message("Tex hi"), 0);
        await drainGroup(storage, w.deps);
        w.asks.length = 0;
        w.texts.length = 0;
        w.reactions.length = 0;
        await acceptGroup(storage, w.message("thanks that worked"), 10);
        await drainGroup(storage, w.deps);
        expect(w.asks).toEqual([]);
        expect(w.texts).toEqual([]);
        expect(w.reactions).toHaveLength(act === "react" ? 1 : 0);
      }
    });

    it("three people's repeats during Ada's turn: nobody else's is folded into it; theirs are decided again after, and silent leaves them unanswered", async () => {
      const storage = new MemoryStorage();
      const everyone = { participants: [ADA, BO, CY, LINE] };
      const w = setup(groupId, {
        hold: true,
        members: [[ADA, BO, CY]],
        control: { engagement: "helpful", engagementChosen: true },
        decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : w.decided.filter((d) => !d.running).length === 1 ? answerAll(body) : silent()),
      });
      await acceptGroup(storage, w.message("Tex make a graphic", everyone), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      // Bound now (the turn started), so their untagged lines are the chat's and reach decide (helpful).
      expect(await acceptGroup(storage, w.message("wtf", { from: BO, ...everyone }), 10)).toBe("queued");
      expect(await acceptGroup(storage, w.message("you are disappointing us", { from: CY, ...everyone }), 11)).toBe("queued");
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.steers).toEqual([]);
      expect(w.asks).toHaveLength(1);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toHaveLength(1);
      expect(await decidedWords(storage, w, groupId)).toEqual(["Tex make a graphic", "wtf", "you are disappointing us"]);
    });

    it("an addressed repeat from someone else is answered as their own turn whatever decide says (code's floor)", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        hold: true,
        decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : w.decided.filter((d) => !d.running).length === 1 ? answerAll(body) : silent()),
      });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex where is it", { from: BO }), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.steers).toEqual([]);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a graphic", "Tex where is it"]);
      expect(w.control.map((body) => body.sender)).toEqual([ADA, BO]);
    });

    it("Ada's own follow-up during her turn folds into it: one answer", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      expect(await acceptGroup(storage, w.message("make it blue"), 10)).toBe("queued");
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.steers).toEqual([expect.objectContaining({ turn: w.asks[0].turn, text: "make it blue" })]);
      expect(w.asks).toHaveLength(1);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toHaveLength(1);
    });

    it("somebody else's queue or restart during Ada's turn is never a restart: it runs as their own turn, resolved for them", async () => {
      for (const midTurn of ["queue", "restart"]) {
        const storage = new MemoryStorage();
        const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn } : answerAll(body)) });
        await acceptGroup(storage, w.message("Tex make a graphic"), 0);
        const draining = drainGroup(storage, w.deps);
        await w.running;
        await acceptGroup(storage, w.message("Tex what's the weather", { from: BO }), 10);
        w.release();
        await draining;
        await drainGroup(storage, w.deps);
        expect(w.cancels).toEqual([]);
        expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a graphic", "Tex what's the weather"]);
        expect(w.control.map((body) => body.sender)).toEqual([ADA, BO]);
      }
    });

    it("Ada's own restart cancels her turn, and one turn covers both", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "restart" } : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex no, a poster"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.cancels).toEqual([{ turn: w.asks[0].turn }]);
      expect(w.asks[1].question).toBe("Tex make a graphic\nTex no, a poster");
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex make a graphic\nTex no, a poster"]);
    });

    it("covers holding Ada's and Bo's messages: Ada's turn has Bo's line as chat, and Bo's are decided again for him, a turn of his own", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex check the setlist"), 10);
      await acceptGroup(storage, w.message("lol", { from: BO }), 11);
      await acceptGroup(storage, w.message("Tex and the weather?", { from: BO }), 12);
      await drainGroup(storage, w.deps);
      // Decide, asked again for Bo's newest, covered his "lol" with his request.
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex hi", "Tex check the setlist", "lol\nTex and the weather?"]);
      expect((w.asks[1].group as { chat: unknown[] }).chat).toEqual([{ from: "bo", text: "lol" }]);
      expect(w.control.map((body) => body.sender)).toEqual([ADA, ADA, BO]);
    });

    it("somebody the control plane does not know never gets anything run, even inside a decided burst", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { controlFor: (body) => (body.sender === BO ? { status: "unknown_sender" } : undefined) });
      await acceptGroup(storage, w.message("Tex check the setlist"), 0);
      await acceptGroup(storage, w.message("Tex and read me Ada's email", { from: BO }), 1);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex check the setlist"]);
      expect(w.control.map((body) => body.sender)).toEqual([ADA, BO]);
    });

    it("the first addressed message asks the style question first; any member's 3 sets followAlong, then the message is answered", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagementChosen: false } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([ENGAGEMENT_QUESTION]);
      expect(ENGAGEMENT_QUESTION).toBe(
        'Before I answer: when should I speak up here?\n\n1 Quiet: only when someone says "Tex"\n2 Attentive: also when I\'ve asked you to OK something, like an email, and you answer or change it without saying "Tex"\n3 Follow-along: also when you ask a follow-up about my last answer without saying "Tex"\n4 Helpful: also when I spot a question your notes, calendar or email can answer\n\nReply with 1, 2, 3 or 4.',
      );
      expect(w.asks).toEqual([]);
      // Bo, not the asker, answers with a bare "3".
      expect(await acceptGroup(storage, w.message("3", { from: BO }), 10)).toBe("queued");
      await drainGroup(storage, w.deps);
      expect(w.engagement).toEqual([{ line: LINE, groupId, style: "followAlong", setBy: "bo" }]);
      expect(w.texts[1]).toBe('Got it, Follow-along (set by bo). To change it later, text "Tex, settings".');
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight"]);
      expect(w.texts[2]).toBe("answer to Tex what's on tonight");
    });

    it("a style question nobody answers in half an hour closes, and the message it held is answered anyway", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagementChosen: false } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([ENGAGEMENT_QUESTION]);
      await drainGroup(storage, { ...w.deps, now: () => 1_000 + 31 * 60_000 });
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight"]);
      expect(w.texts).toHaveLength(2);
      expect(await storage.get("gengask")).toBeUndefined();
    });

    it("a style's name sets it too, any case; \"Tex, settings\" asks again", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex, settings"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([ENGAGEMENT_QUESTION]);
      await acceptGroup(storage, w.message("QUIET", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      expect(w.engagement).toEqual([{ line: LINE, groupId, style: "quiet", setBy: "bo" }]);
      expect(w.texts[1]).toBe('Got it, Quiet (set by bo). To change it later, text "Tex, settings".');
      expect(w.asks).toEqual([]);
    });

    it("an answer held for a newcomer is logged as never delivered", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { members: [[ADA, BO], [ADA, BO, CY]] });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      const outs = (await keptEvents(storage, groupId)).filter((event) => event.from.kind !== "person");
      expect(outs.find((event) => event.text === "answer to Tex what's on tonight")).toMatchObject({ delivered: false, reason: "held_newcomer" });
      expect(w.texts).toEqual(["Someone joined while I was working on that, so I didn't send it. Ask me again."]);
    });

    it("decide never shows a newcomer what was said before they joined", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: silent });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex the secret plan is Friday"), 5);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex hi all", { from: CY, participants: [ADA, BO, CY, LINE] }), 10);
      await drainGroup(storage, w.deps);
      const last = w.decided.at(-1)!;
      expect(last.transcript).toContain("hi all");
      expect(last.transcript).not.toContain("secret plan");
    });

    it("a guest's yes never releases the asker's ask, decided or not; the asker's yes is code's, never decide's", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        decide: (body) => (w.decided.length === 1 ? answerAll(body) : silent()),
        control: { engagement: "helpful", engagementChosen: true },
        agent: () => ({ answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."] }),
      });
      await acceptGroup(storage, w.message("Tex draft the email"), 0);
      await drainGroup(storage, w.deps);
      const before = w.decided.length;
      // Bo is not the asker: his "yes" is chat, put to decide like any text, and decide said silent.
      await acceptGroup(storage, w.message("yes", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.decided.length).toBe(before + 1);
      // Ada's "yes" goes straight to a turn: never to decide.
      await acceptGroup(storage, w.message("yes"), 20);
      await drainGroup(storage, w.deps);
      expect(w.decided.length).toBe(before + 1);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex draft the email", "yes"]);
      expect(w.control.at(-1)).toMatchObject({ sender: ADA });
    });

    it("an ask event carries the ask line Tex showed (its verbatim part)", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { agent: () => ({ answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."], askIds: ["rec_00000001"] }) });
      await acceptGroup(storage, w.message("Tex draft the email to the venue"), 0);
      await drainGroup(storage, w.deps);
      const ask = (await keptEvents(storage, groupId)).find((event) => event.kind === "ask");
      expect(ask).toMatchObject({ ask: "rec_00000001", text: "Give it a 👍 and I'll send it." });
    });

    it("an untagged message during a turn in a chat that is not bound is never logged, as when idle", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? silent() : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      // Bound for Ada and Bo; with Cy in the chat these people are not the ones it is bound for.
      expect(await acceptGroup(storage, w.message("lol nice", { from: BO, participants: [ADA, BO, CY, LINE] }), 10)).toBe("ignored");
      w.release();
      await draining;
      expect((await keptEvents(storage, groupId)).map((event) => event.text)).not.toContain("lol nice");
      expect(w.decided.filter((body) => body.running)).toEqual([]);
    });

    it("a message seen mid-turn is never lost when deciding it throws: it is queued and answered after", async () => {
      // Throws on the read of the waiting asks, which mid-turn decide makes first, once armed.
      class Failing extends MemoryStorage {
        armed = false;
        override async get<T>(key: string) {
          if (this.armed && key === "ev-asks") {
            this.armed = false;
            throw new Error("storage down");
          }
          return super.get<T>(key);
        }
      }
      const storage = new Failing();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      storage.armed = true;
      expect(await acceptGroup(storage, w.message("Tex and a poster"), 10)).toBe("queued");
      expect(storage.armed).toBe(false);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a graphic", "Tex and a poster"]);
    });

    it("a picture that could not be hosted is an event that never went", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { agent: () => ({ answer: "Here it is.", pictures: [{ name: "p.png", mediaType: "image/png", data: btoa("png") }] }) });
      await acceptGroup(storage, w.message("Tex draw it"), 0);
      await drainGroup(storage, { ...w.deps, hostPicture: async () => Promise.reject(new Error("no host")) });
      const outs = (await keptEvents(storage, groupId)).filter((event) => event.kind === "picture");
      expect(outs).toEqual([expect.objectContaining({ delivered: false, reason: "upload_failed", from: { kind: "tex" } })]);
    });
  });
}
