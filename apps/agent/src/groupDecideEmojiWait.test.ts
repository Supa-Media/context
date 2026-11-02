/**
 * Decide's reaction and wait in a group (Dev2, 2026-11-01; `chatState.ts`).
 * Reacting is its own decision: decide's emoji goes at once with silence, an
 * answer or a wait, once per message, and then the turn adds no ack tapback.
 * A wait holds an untagged burst for the seconds decide chose, decided again
 * when it ends or at once when a new message lands, at most `MAX_CHAT_WAITS`
 * times and never past `BURST_DEADLINE_MS` after the burst's first message;
 * only a real burst (`burstStillTyped`) is held, and never an addressed message.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `reactionFor` returning decide's emoji unchecked: "an emoji outside the 64" fails;
 *  - `canWait` ignoring `MAX_CHAT_WAITS`: "answers after MAX_CHAT_WAITS waits" fails;
 *  - `step` "wait" ignoring the deadline: "the burst is answered by its deadline" fails;
 *  - the `!item.reacted` check dropped from the ack: "an answer with decide's emoji" fails.
 */
import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { AlarmStorage, MemoryStorage } from "./memoryStorage.testing";
import { ackEmoji } from "./ackEmoji";
import { looksUnfinished } from "./groupTurn";
import { BURST_DEADLINE_MS, MAX_CHAT_WAITS } from "./chatState";
import { answerAll, LINES, setup, type Answer, type Decide } from "./groupWorld.testing";

const react = (emoji?: string): Answer => ({ ok: true, act: "react", covers: [], stale: [], movedOn: false, confidence: 0.9, ...(emoji ? { emoji } : {}) });
const wait = (seconds = 3): Answer => ({ ok: true, act: "wait", covers: [], stale: [], movedOn: false, confidence: 0.9, waitSeconds: seconds });
const STYLE = { engagement: "helpful", engagementChosen: true };

/** A tagged message first binds the chat to its people, as a real chat's first tag does; untagged ones follow. */
async function bound(storage: MemoryStorage, w: ReturnType<typeof setup>) {
  await acceptGroup(storage, w.message("Tex hi"), 0);
  await drainGroup(storage, w.deps);
  w.decided.length = 0;
  w.reactions.length = 0;
  w.asks.length = 0;
}

for (const { name, groupId } of LINES) {
  describe(`decide's emoji and wait, ${name}`, () => {
    it("a react uses decide's emoji", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => react("🎉"), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("we got the venue"), 10);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual(["🎉"]);
      expect(w.asks).toHaveLength(0);
    });

    it("an emoji outside the 64 is never sent: the words pick it", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => react("🦄"), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("we got the venue"), 10);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual([ackEmoji("we got the venue")]);
    });

    it("an answer with decide's emoji reacts at once and answers, with no second tapback", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: (body) => ({ ...(answerAll(body) as object), emoji: "🎉" }) as Answer, control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("we got the venue, what now?"), 10);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual(["🎉"]);
      expect(w.asks.map((ask) => ask.question)).toEqual(["we got the venue, what now?"]);
    });

    it("a wait holds the burst the seconds decide chose, then decides again", async () => {
      const storage = new AlarmStorage();
      let next: (body: Decide) => Answer = () => wait(3);
      const w = setup(groupId, { decide: (body) => next(body), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      w.deps.now = () => 200;
      storage.fire();
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(1);
      expect(storage.alarm).toBe(3_200);
      // Woken early (another alarm), nothing new: still held, decide not asked again.
      w.deps.now = () => 1_000;
      storage.fire();
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(1);
      next = answerAll;
      w.deps.now = () => 3_200;
      storage.fire();
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(2);
      expect(w.asks.map((ask) => ask.question)).toEqual(["so about friday"]);
    });

    it("a new message during a wait is decided at once, with the burst", async () => {
      const storage = new AlarmStorage();
      let next: (body: Decide) => Answer = () => wait(6);
      const w = setup(groupId, { decide: (body) => next(body), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      w.deps.now = () => 200;
      storage.fire();
      await drainGroup(storage, w.deps);
      next = answerAll;
      await acceptGroup(storage, w.message("and saturday"), 1_000);
      w.deps.now = () => 1_000;
      storage.fire();
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(2);
      expect(w.asks.map((ask) => ask.question)).toEqual(["so about friday\nand saturday"]);
    });

    it("answers after MAX_CHAT_WAITS waits, however often decide says wait", async () => {
      const storage = new AlarmStorage();
      const w = setup(groupId, { decide: () => wait(1), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      for (let i = 0; i <= MAX_CHAT_WAITS; i += 1) {
        w.deps.now = () => 100 + (i + 1) * 1_000;
        storage.fire();
        await drainGroup(storage, w.deps);
      }
      expect(w.decided).toHaveLength(MAX_CHAT_WAITS + 1);
      expect(w.asks.map((ask) => ask.question)).toEqual(["so about friday"]);
    });

    it("the burst is answered by its deadline, however long decide asks to wait", async () => {
      const storage = new AlarmStorage();
      const w = setup(groupId, { decide: () => wait(8), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      w.deps.now = () => 6_100;
      storage.fire();
      await drainGroup(storage, w.deps);
      // Held only to the deadline, 8 s after the first message: never the full 8 s from now.
      expect(storage.alarm).toBe(100 + BURST_DEADLINE_MS);
      w.deps.now = () => 100 + BURST_DEADLINE_MS;
      storage.fire();
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["so about friday"]);
    });

    it("a single complete message is never held, whatever decide says", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => wait(), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("Which parts of about.md are out of date?"), 100);
      await drainGroup(storage, w.deps);
      expect(w.decided).toHaveLength(1);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Which parts of about.md are out of date?"]);
    });

    it("never delays a message addressed to Tex", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: () => wait(), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      await acceptGroup(storage, w.message("Tex what time is dinner?"), 101);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what time is dinner?"]);
    });
  });
}

describe("what counts as a burst still being typed", () => {
  it("reads unfinished words", () => {
    for (const text of ["so about friday", "we could go,", "I was thinking and", "maybe...", "ok but"]) expect(looksUnfinished(text), text).toBe(true);
    for (const text of ["Which parts of about.md are out of date?", "We got a deal!", "Dinner is at 7 tonight.", "lol 😂", ""]) {
      expect(looksUnfinished(text), text).toBe(false);
    }
  });
});
