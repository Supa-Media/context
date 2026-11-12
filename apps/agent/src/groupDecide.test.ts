/**
 * A group's turns are decided (`groupTurn.ts`, `groupStyle.ts`; Dev2,
 * 2026-10-26), on an iMessage group (Sendblue) and a WhatsApp group (Whapi).
 *
 * Since 2026-11-11 (one judge): every message that is not code's reaches the
 * judge whatever the chat's style, which the judge is told; no word rule, no
 * follow-along count. Records 1 to 3 (`reachesDecide`, `followingAlong`)
 * tested code deleted that day.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  4. `chooseGroupTurn`'s fallback answering every waiting message → "judge
 *     down: only a waiting question is answered" fails.
 * 17. (2026-11-11) `acceptGroup` gating a message on the style again → "every
 *     style puts every message to the judge" fails.
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
 *  9. `ask` in `groupTurn.ts` cutting the transcript by `people` again → "decide is
 *     shown the chat's whole log…" fails.
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
import { ADA, answerAll, BO, CY, decidedWords, LINE, LINES, setup, silent, untaggedSilent, type Answer, type Decide, chatLog } from "./groupWorld.testing";

for (const { name, groupId } of LINES) {
  describe(`a group's decided turns, ${name}`, () => {
    /*
      Every message goes to the judge (Dev2, 2026-11-11), which is told
      follow-along whatever level a chat chose before the levels were retired
      that day. After Tex answered Ada with an ask, Ada and Bo each send an
      untagged text; the judge (a stand-in) leaves both silent.
    */
    for (const style of ["quiet", "attentive", "followAlong", "helpful"]) {
      it(`every message goes to the judge, told follow-along (a chat once set ${style})`, async () => {
        const storage = new MemoryStorage();
        const w = setup(groupId, {
          decide: untaggedSilent,
          control: { engagement: style, engagementChosen: true },
          agent: () => ({ answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."] }),
        });
        await acceptGroup(storage, w.message("Tex draft the email to the venue"), 0);
        await drainGroup(storage, w.deps);
        expect(w.asks).toHaveLength(1);
        await acceptGroup(storage, w.message("make it shorter"), 10);
        await acceptGroup(storage, w.message("lol nice", { from: BO }), 11);
        await drainGroup(storage, w.deps);
        expect(await decidedWords(storage, w, groupId)).toEqual(["make it shorter", "lol nice"]);
        expect(w.decided.at(-1)).toMatchObject({ style: "followAlong" });
        // The judge said silent: nothing more was answered, and they stay what the chat said.
        expect(w.asks).toHaveLength(1);
      });
    }

    // Dev2, 2026-11-02: iMessage sends a mention as the bare name. Since 2026-11-11 every message in a bound chat is the
    // judge's, Texas and Tex-Mex too; a muted chat reads nothing but a command said to Tex by name, not even by the judge.
    it("Tex's name mid-sentence, Texas and Tex-Mex all go to the judge in a quiet chat; muted, nothing is read", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: (body) => (w.decided.length === 1 ? answerAll(body) : silent()), control: { engagement: "quiet", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("can Tex tell us what 7 times 8 is?", { from: BO }), 10);
      await acceptGroup(storage, w.message("we drove through Texas", { from: BO }), 11);
      await acceptGroup(storage, w.message("Tex-Mex tonight?", { from: BO }), 12);
      await drainGroup(storage, w.deps);
      expect(await decidedWords(storage, w, groupId)).toEqual(["can Tex tell us what 7 times 8 is?", "we drove through Texas", "Tex-Mex tonight?"]);
      expect(w.asks).toHaveLength(1);

      const muted = new MemoryStorage();
      const off = setup(groupId, { decide: answerAll, control: { status: "muted" } });
      await acceptGroup(muted, off.message("Tex what's on tonight"), 0);
      await drainGroup(muted, off.deps);
      const looked = off.decided.length;
      expect(await acceptGroup(muted, off.message("can Tex tell us what 7 times 8 is?", { from: BO }), 10)).toBe("ignored");
      await drainGroup(muted, off.deps);
      expect(off.decided).toHaveLength(looked);
      expect((await chatLog(muted, off, groupId)).map((event) => event.text)).not.toContain("can Tex tell us what 7 times 8 is?");
      expect([...(await muted.list({ prefix: "gpending:" })).keys()]).toEqual([]);
    });

    it("every message reaches the judge, past twenty untagged texts too: no follow-along count", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: untaggedSilent });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      for (let i = 0; i < 23; i += 1) {
        await acceptGroup(storage, w.message(`chat ${i}`, { from: BO }), 10 + i);
        await drainGroup(storage, w.deps);
      }
      expect(await decidedWords(storage, w, groupId)).toHaveLength(23);
    });

    it("judge down: a waiting question or a message calling Tex is answered, one at a time; other chatter is not", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: false, reason: "capped" }), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("is it raining", { from: BO }), 10);
      await acceptGroup(storage, w.message("Tex and tomorrow?"), 11);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight", "Tex and tomorrow?"]);
    });

    it("decide down: an untagged question its style reads is answered, never dropped silently", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => ({ ok: false, reason: "unavailable" }), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex what is in index.md?"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("ok cool"), 10);
      await acceptGroup(storage, w.message("Where is it out of place?"), 11);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what is in index.md?", "Where is it out of place?"]);
    });

    // In a chat not set up yet, a line that does not call Tex is never read (fail closed, 2026-11-11): the link waits for a bound chat.
    it("a tag in a chat not set up yet is judged alone, logged once answered; the link after it is not read", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex check this link out"), 0);
      await acceptGroup(storage, w.message("https://reasonmachines.example/page"), 1_000);
      await drainGroup(storage, w.deps);
      // A chat not set up yet: the judge looks at both lines alone, with no ledger key; what it answers is logged then.
      const ids = (await chatLog(storage, w, groupId)).filter((event) => event.from.kind === "person").map((event) => event.id);
      expect(ids).toHaveLength(1);
      expect(w.decided).toEqual([expect.objectContaining({ running: false })]);
      expect(w.decided[0].ledger).toBeUndefined();
      expect(w.decided[0].candidates).toHaveLength(1);
      expect(w.asks).toHaveLength(1);
      expect(w.asks[0]).toMatchObject({ question: "Tex check this link out", covers: ids, chat: groupId });
      expect(typeof w.asks[0].turn).toBe("string");
      expect(w.events.every((post) => JSON.stringify(post.conversation) === JSON.stringify({ group: groupId }))).toBe(true);
      const posted = w.events.flatMap((post) => post.events);
      expect(posted.every((event) => event.chat === groupId)).toBe(true);
      const answer = posted.find((event) => event.from.kind === "tex" && event.text?.startsWith("answer to"))!;
      expect(answer).toMatchObject({ delivered: true, covers: ids, turn: w.asks[0].turn });
    });

    it("react puts a tapback on the newest untagged message and sends no answer; silent sends nothing", async () => {
      for (const act of ["react", "silent"] as const) {
        const storage = new MemoryStorage();
        // The untagged message after the tag is the one judged here: decide's react or silent leaves it unanswered.
        // The first look (no ledger key yet) is answered, so the chat is bound for the message judged here.
        const w = setup(groupId, {
          decide: (body) => (body.ledger === undefined ? answerAll(body) : { ok: true, act, covers: [], stale: [], movedOn: false, confidence: 0.9 }),
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
        decide: (body) => (body.running ? { ...answerAll(body), midTurn: "fold" } : untaggedSilent(body)),
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
      expect(await decidedWords(storage, w, groupId)).toEqual(["wtf", "you are disappointing us"]);
    });

    // Since 2026-11-11 no word rule starts a turn: somebody else's repeat waits for the judge after the turn, and its silent runs nothing.
    it("a repeat from someone else during a turn is judged again after it, and the judge's silent runs no turn for it", async () => {
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
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a graphic"]);
      expect(w.control.map((body) => body.sender)).toEqual([ADA]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex make a graphic"]);
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

    it("Ada's and Bo's tags in one burst: Ada's turn first, then Bo's, each resolved for its own sender, each judged first", async () => {
      const storage = new MemoryStorage();
      // The judge (a stand-in) covers the lines that name Tex; Bo's "lol" is chat.
      const named = (body: Decide): Answer => ({ ...(answerAll(body) as Extract<Answer, { ok: true }>), covers: body.candidates.filter((id) => /Tex/.test(body.transcript.split("\n").find((line) => line.startsWith(`<${id}>`)) ?? "")) });
      const w = setup(groupId, { decide: named, control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex check the setlist"), 10);
      await acceptGroup(storage, w.message("lol", { from: BO }), 11);
      await acceptGroup(storage, w.message("Tex and the weather?", { from: BO }), 12);
      await drainGroup(storage, w.deps);
      // One judging covered both senders' asks: Ada's turn runs first and reads Bo's lines up to his ask as the chat
      // around it (`ownTurn`, as for any judged burst since 2026-11-11), so his own turn has none left to read.
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex hi", "Tex check the setlist", "Tex and the weather?"]);
      expect((w.asks[1].group as { chat: unknown[] }).chat).toEqual([{ from: "bo", text: "lol" }, { from: "bo", text: "Tex and the weather?" }]);
      expect((w.asks[2].group as { chat: unknown[] }).chat).toEqual([]);
      // Every judging comes before a turn, never beside one.
      expect(w.decided.every((body) => !body.running)).toBe(true);
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

    it("the first addressed message in a chat nobody chose a style for is answered at once, with no style question (Dev2, 2026-11-11)", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagementChosen: false } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what's on tonight"]);
      expect(w.texts).toEqual(["answer to Tex what's on tonight"]);
      expect(w.texts.join("\n")).not.toMatch(/when should I speak up|Reply with 1, 2, 3 or 4/);
      expect(await storage.get("gengask")).toBeUndefined();
    });

    it("'Tex, settings' and 'Tex, no emoji' are no longer code's: no menu, nothing saved, the model answers (Dev2, 2026-11-11)", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex, settings"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts.join("\n")).not.toMatch(/My settings in this chat/);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex, settings"]);
      await acceptGroup(storage, w.message("Tex, no emoji", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex, settings", "Tex, no emoji"]);
      expect(w.engagement).toEqual([]);
    });

    it("an answer held for a newcomer is logged as never delivered", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { members: [[ADA, BO], [ADA, BO, CY]] });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      const outs = (await chatLog(storage, w, groupId)).filter((event) => event.from.kind !== "person");
      expect(outs.find((event) => event.text === "answer to Tex what's on tonight")).toMatchObject({ delivered: false, reason: "held_newcomer" });
      expect(w.texts).toEqual(["Someone joined while I was working on that, so I didn't send it. Ask me again."]);
    });

    it("decide is shown the chat's whole log, from before a newcomer joined too (the owner, 2026-11-02)", async () => {
      const storage = new MemoryStorage();
      // The judge answers a chat's first look (a tag before the chat is bound for these people), and is silent on the rest.
      const w = setup(groupId, { decide: (body) => (body.ledger === undefined ? answerAll(body) : silent()), control: { engagement: "helpful", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex the secret plan is Friday"), 5);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex hi all", { from: CY, participants: [ADA, BO, CY, LINE] }), 10);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("what did I miss?", { from: CY, participants: [ADA, BO, CY, LINE] }), 20);
      await drainGroup(storage, w.deps);
      const last = w.decided.at(-1)!;
      expect(last.transcript).toContain("hi all");
      expect(last.transcript).toContain("secret plan");
    });

    // Since 2026-11-11 the asker's bare yes is the judge's to answer, never a word rule's; a guest's yes is judged the same and,
    // left silent, runs nothing. Releasing a held send stays the gateway's, on the asker's own yes only (PR 2's backstop).
    it("a guest's yes and the asker's yes both go to the judge; only what it answers runs, as the asker's own turn", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        decide: (body) => ((body as Decide & { sender?: string }).sender === BO ? silent() : answerAll(body)),
        control: { engagement: "helpful", engagementChosen: true },
        agent: () => ({ answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."] }),
      });
      await acceptGroup(storage, w.message("Tex draft the email"), 0);
      await drainGroup(storage, w.deps);
      const before = w.decided.length;
      await acceptGroup(storage, w.message("yes", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.decided.length).toBe(before + 1);
      await acceptGroup(storage, w.message("yes"), 20);
      await drainGroup(storage, w.deps);
      expect(w.decided.length).toBe(before + 2);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex draft the email", "yes"]);
      expect(w.control.at(-1)).toMatchObject({ sender: ADA });
    });

    it("an ask event carries the ask line Tex showed (its verbatim part)", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { agent: () => ({ answer: "Here's the email I'd send. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."], askIds: ["rec_00000001"] }) });
      await acceptGroup(storage, w.message("Tex draft the email to the venue"), 0);
      await drainGroup(storage, w.deps);
      const ask = (await chatLog(storage, w, groupId)).find((event) => event.kind === "ask");
      expect(ask).toMatchObject({ ask: "rec_00000001", text: "Give it a 👍 and I'll send it." });
    });

    it("an untagged message during a turn in a chat that is not bound is never logged, as when idle", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running || body.transcript.includes("lol nice") ? silent() : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      // Bound for Ada and Bo; with Cy in the chat these people are not the ones it is bound for, and it does not call Tex.
      expect(await acceptGroup(storage, w.message("lol nice", { from: BO, participants: [ADA, BO, CY, LINE] }), 10)).toBe("ignored");
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect((await chatLog(storage, w, groupId)).map((event) => event.text)).not.toContain("lol nice");
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
      expect(await acceptGroup(storage, w.message("Tex and a poster"), 10)).toBe("kept");
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
      const outs = (await chatLog(storage, w, groupId)).filter((event) => event.kind === "picture");
      expect(outs).toEqual([expect.objectContaining({ delivered: false, reason: "upload_failed", from: { kind: "tex" } })]);
    });
  });
}
