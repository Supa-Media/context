/**
 * A group's decided turns after Dev2's review of the event-log branch
 * (2026-10-27), on an iMessage group (Sendblue) and a WhatsApp group (Whapi):
 * code's floor for addressed messages, the fallback when decide is down,
 * duplicates while decide is slow, restarts the gateway refuses, asks per
 * asker, SMS, one people hash, and the style question's alarm.
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `chooseGroupTurn` without the floor on a decided silent/react → "a
 *     message addressed to Tex starts its turn, with the link after it…"
 *     fails (Dev2, 2026-11-01: the floor is now the turn starting at once;
 *     decide's silent, asked beside it, keeps its answer unsent).
 *  2. `withJoins` returning the head alone → the same test and "decide down:
 *     a picture after the tag…" fail.
 *  3. the fallback answering the tag alone (`[burst[first]]`) → "decide
 *     down: a picture after the tag…" and "decide down: the link after…" fail.
 *  4. the `seen` key written after `whileRunning`, as before → "a webhook
 *     redelivered while decide is slow…" fails.
 *  5. `restartTurn` marking the turn cancelled whatever the gateway said →
 *     "a restart the gateway refuses…" fails.
 *  6. `groupTurn` not posting `/agent/stale` for a cancelled turn's askIds →
 *     "an answer that comes back for a turn cancelled here…" fails.
 *  7. `waitingAsks` ignoring `who` → "Bo's 'nah forget it' never stales
 *     Ada's ask" fails.
 *  8. `engagementChoice` read on an SMS → "an SMS never sets the style…" fails;
 *     `followsOwnTag` without its SMS check → "…nor joins a waiting tag" fails.
 *  9. `ownTurn` taking every sender's covered entries into the asker's turn →
 *     "the two-person burst…" fails.
 * 10. `logGroupInbound` filing under `peopleKey` instead of `eventPeople` →
 *     "inbound events, Tex's events and the members…" fails.
 * 11. `keepQuestionAlarm` not called after the drain → "the style question's
 *     half-hour alarm…" fails.
 * 12. `whileRunning` leaving an addressed message as chat on a silent decide
 *     (the asker's tail, or another sender's) → "addressed while a turn
 *     runs…" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { AlarmStorage, MemoryStorage } from "./memoryStorage.testing";
import { keptEvents } from "./events";
import { ENGAGEMENT_QUESTION, QUESTION_OPEN_MS } from "./groupStyle";
import { ADA, answerAll, BO, CY, decidedWords, LINES, setup, silent, untaggedSilent, type Answer } from "./groupWorld.testing";

const PICTURE = { attachments: [{ url: "https://cdn.example.test/shot.png", filename: "shot.png", mimeType: "image/png", size: null }] };
const ASK_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const down = (): Answer => ({ ok: false, reason: "unavailable" });

for (const { name, groupId } of LINES) {
  describe(`a group's turns after review, ${name}`, () => {
    it("a message addressed to Tex starts its turn, with the link after it, and decide's silent keeps the answer unsent", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: silent });
      await acceptGroup(storage, w.message("Tex check this link"), 0);
      expect(await acceptGroup(storage, w.message("https://reasonmachines.example/page"), 1_000)).toBe("queued");
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex check this link\nhttps://reasonmachines.example/page"]);
      expect(w.asks[0].covers).toHaveLength(2);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual([]);
    });

    it("addressed while a turn runs, Ada's and Bo's are answered after it even when decide says silent", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, decide: (body) => (body.running ? silent() : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      expect(await acceptGroup(storage, w.message("Tex make it blue"), 10)).toBe("queued");
      expect(await acceptGroup(storage, w.message("Tex where is it", { from: BO }), 11)).toBe("queued");
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a graphic", "Tex make it blue", "Tex where is it"]);
      expect(w.control.map((body) => body.sender)).toEqual([ADA, ADA, BO]);
    });

    it("decide down: the link after the tag is read with it, as before decide", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: down });
      await acceptGroup(storage, w.message("Tex check this link"), 0);
      await acceptGroup(storage, w.message("https://reasonmachines.example/page"), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex check this link\nhttps://reasonmachines.example/page"]);
    });

    it("decide down: a picture after the tag joins the tagger's waiting tag: one turn", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: down });
      await acceptGroup(storage, w.message("Tex file this screenshot as a bug"), 0);
      await acceptGroup(storage, w.message("", PICTURE), 1_000);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.asks[0].question).toBe("Tex file this screenshot as a bug");
      expect(w.asks[0].covers).toHaveLength(2);
    });

    it("a webhook redelivered while decide is slow is a duplicate, never decided twice", async () => {
      const storage = new MemoryStorage();
      let open = () => {};
      let gate: Promise<void> | undefined;
      const w = setup(groupId, { hold: true, decideWait: () => gate ?? Promise.resolve(), decide: (body) => (body.running ? { ...answerAll(body), midTurn: "queue" } : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      gate = new Promise<void>((resolve) => (open = resolve));
      const late = w.message("Tex and a poster", { from: BO });
      const first = acceptGroup(storage, late, 10);
      while (!w.decided.some((body) => body.running)) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(await acceptGroup(storage, late, 11)).toBe("duplicate");
      open();
      expect(await first).toBe("queued");
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.decided.filter((body) => body.running)).toHaveLength(1);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex make a graphic", "Tex and a poster"]);
    });

    it("a restart the gateway refuses (cancelled: false) is a queue: both are answered, in order", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { hold: true, cancelled: false, decide: (body) => (body.running ? { ...answerAll(body), midTurn: "restart" } : answerAll(body)) });
      await acceptGroup(storage, w.message("Tex make a graphic"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex no, a poster"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.cancels).toHaveLength(1);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex make a graphic", "answer to Tex no, a poster"]);
    });

    it("an answer that comes back for a turn cancelled here has its asks disarmed", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        hold: true,
        decide: (body) => (body.running ? { ...answerAll(body), midTurn: "restart" } : answerAll(body)),
        agent: (body) => ({ answer: `answer to ${body.question}`, ...(String(body.question) === "Tex email the venue" ? { askIds: [ASK_ID], verbatim: ["OK to send?"] } : {}) }),
      });
      await acceptGroup(storage, w.message("Tex email the venue"), 0);
      const draining = drainGroup(storage, w.deps);
      await w.running;
      await acceptGroup(storage, w.message("Tex no, the caterer"), 10);
      w.release();
      await draining;
      await drainGroup(storage, w.deps);
      expect(w.stale).toEqual([{ asks: [ASK_ID] }]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex email the venue\nTex no, the caterer"]);
    });

    it("Bo's 'nah forget it' never stales Ada's ask: decide is shown only the sender's own asks", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, {
        control: { engagement: "helpful", engagementChosen: true },
        decide: (body) => (body.addressed ? answerAll(body) : ({ ...silent(), stale: body.waitingAsks } as Answer)),
        agent: (body) =>
          String(body.question).startsWith("Tex draft")
            ? { answer: "Here's the email. Give it a 👍 and I'll send it.", verbatim: ["Give it a 👍 and I'll send it."], askIds: [ASK_ID] }
            : { answer: `answer to ${body.question}` },
      });
      await acceptGroup(storage, w.message("Tex draft the email"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("nah forget it", { from: BO }), 10);
      await drainGroup(storage, w.deps);
      // The untagged texts' decides (each tag's is asked beside its turn).
      const judged = () => w.decided.filter((body) => !body.addressed);
      expect(judged()[0].waitingAsks).toEqual([]);
      // Ada's own words are shown her ask.
      await acceptGroup(storage, w.message("actually wait"), 20);
      await drainGroup(storage, w.deps);
      expect(judged()[1].waitingAsks).toHaveLength(1);
      // Owed now, and disarmed only with Ada's own session, the next time she tags Tex.
      await acceptGroup(storage, w.message("Tex what's on tonight", { from: BO }), 30);
      await drainGroup(storage, w.deps);
      expect(w.stale).toEqual([]);
      await acceptGroup(storage, w.message("Tex and tomorrow?"), 40);
      await drainGroup(storage, w.deps);
      expect(w.stale).toEqual([{ asks: [ASK_ID] }]);
    });

    it("an SMS never sets the style, nor joins a waiting tag", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagementChosen: false } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts).toEqual([ENGAGEMENT_QUESTION]);
      expect(await acceptGroup(storage, w.message("3", { from: BO, sms: true }), 10)).toBe("ignored");
      await drainGroup(storage, w.deps);
      expect(w.engagement).toEqual([]);

      const other = new MemoryStorage();
      const v = setup(groupId, { decide: down });
      await acceptGroup(other, v.message("Tex check this link"), 0);
      expect(await acceptGroup(other, v.message("https://phish.example/x", { sms: true }), 1_000)).toBe("ignored");
      await drainGroup(other, v.deps);
      expect(v.asks.map((ask) => ask.question)).toEqual(["Tex check this link"]);
    });

    it("the two-person burst: Bo's untagged complaint after Ada's ask gets its own decide, and silent means one answer", async () => {
      const storage = new MemoryStorage();
      // Tags never wait on decide: Ada's turn starts at once (decide, beside it, answers), and Bo's complaint, after it, is decided on its own.
      const w = setup(groupId, { control: { engagement: "helpful", engagementChosen: true }, decide: untaggedSilent });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex make the poster"), 10);
      await acceptGroup(storage, w.message("this never works", { from: BO }), 11);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex hi", "Tex make the poster"]);
      expect((await decidedWords(storage, w, groupId)).slice(-1)).toEqual(["this never works"]);
      expect(w.control.map((body) => body.sender)).toEqual([ADA, ADA]);
      expect(w.texts.filter((text) => text.startsWith("answer to"))).toEqual(["answer to Tex hi", "answer to Tex make the poster"]);
    });

    it("inbound events, Tex's events and the members named to the gateway carry one people hash", async () => {
      const storage = new MemoryStorage();
      // The app lists Cy too, the webhook does not: the turn names the gateway all three.
      const w = setup(groupId, { members: [[ADA, BO, CY]] });
      await acceptGroup(storage, w.message("Tex hi"), 0);
      await drainGroup(storage, w.deps);
      await acceptGroup(storage, w.message("Tex and now?"), 10);
      await drainGroup(storage, w.deps);
      const members = (w.asks[1].group as { members: string }).members;
      expect((w.asks[0].group as { members: string }).members).toBe(members);
      const events = await keptEvents(storage, groupId);
      const second = events.find((event) => event.text === "Tex and now?")!;
      const answer = events.find((event) => event.text === "answer to Tex hi")!;
      expect(second.people).toBe(members);
      expect(answer.people).toBe(members);
      // A tag is never put to decide: an untagged line after it is, and decide reads Tex's answer in the transcript.
      await acceptGroup(storage, w.message("nice"), 20);
      await drainGroup(storage, w.deps);
      expect(w.decided.at(-1)!.transcript).toContain("answer to Tex hi");
    });

    it("the style question's half-hour alarm survives a message that set a 4-second one", async () => {
      const storage = new AlarmStorage();
      const w = setup(groupId, { control: { engagementChosen: false } });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      storage.fire();
      await drainGroup(storage, w.deps);
      expect(storage.alarm).toBe(1_000 + QUESTION_OPEN_MS);
      // Another tag: its wait replaces the one alarm.
      await acceptGroup(storage, w.message("Tex hello?", { from: BO }), 2_000);
      expect(storage.alarm).toBeLessThan(1_000 + QUESTION_OPEN_MS);
      storage.fire();
      await drainGroup(storage, { ...w.deps, now: () => 6_000 });
      // Never later than the question needs (an earlier one, the review's, may come first).
      expect(storage.alarm).toBeLessThanOrEqual(1_000 + QUESTION_OPEN_MS);
      storage.fire();
      await drainGroup(storage, { ...w.deps, now: () => 1_300_000 });
      expect(storage.alarm).toBe(1_000 + QUESTION_OPEN_MS);
    });
  });
}
