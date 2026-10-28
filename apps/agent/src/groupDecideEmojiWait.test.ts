/**
 * Decide's emoji and wait in a group (Dev2, 2026-10-27): a react goes out at
 * once with decide's emoji when it is one of the 64 (`reactEmoji.ts`), else
 * the words' (`ackEmoji.ts`); wait holds untagged messages until 20 seconds
 * after the newest (`WAIT_MS`), at most `MAX_WAITS` times, and never delays a
 * message addressed to Tex.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `reactionFor` returning decide's emoji unchecked: "an emoji outside the 64" fails;
 *  - `MAX_WAITS` check removed (wait forever): "answers after three waits" fails.
 */
import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { AlarmStorage, MemoryStorage } from "./memoryStorage.testing";
import { ackEmoji } from "./ackEmoji";
import { MAX_WAITS, WAIT_MS } from "./groupTurn";
import { answerAll, LINES, setup, type Answer, type Decide } from "./groupWorld.testing";

const react = (emoji?: string): Answer => ({ ok: true, act: "react", covers: [], stale: [], movedOn: false, confidence: 0.9, ...(emoji ? { emoji } : {}) });
const wait = (): Answer => ({ ok: true, act: "wait", covers: [], stale: [], movedOn: false, confidence: 0.9 });
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

    it("wait holds the burst until 20 seconds after its newest message, then decides again", async () => {
      // The alarm fires (it is cleared, as a Durable Object's is while its handler runs), then the drain runs.
      const storage = new AlarmStorage();
      const fired = () => (storage.fire(), drainGroup(storage, w.deps));
      let next: (body: Decide) => Answer = wait;
      const w = setup(groupId, { decide: (body) => next(body), control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      w.deps.now = () => 5_000;
      await fired();
      expect(w.decided).toHaveLength(1);
      expect(storage.alarm).toBe(100 + WAIT_MS);
      // Woken early (another text's alarm): still waiting, decide is not asked again, and the wait's alarm stays.
      await fired();
      expect(w.decided).toHaveLength(1);
      expect(storage.alarm).toBe(100 + WAIT_MS);
      next = answerAll;
      w.deps.now = () => 100 + WAIT_MS;
      await fired();
      expect(w.decided).toHaveLength(2);
      expect(w.asks.map((ask) => ask.question)).toEqual(["so about friday"]);
    });

    it("answers after three waits in a row", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: wait, control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      for (let i = 0; i <= MAX_WAITS; i += 1) {
        w.deps.now = () => 100 + (i + 1) * WAIT_MS;
        await drainGroup(storage, w.deps);
      }
      expect(w.decided).toHaveLength(MAX_WAITS + 1);
      expect(w.asks.map((ask) => ask.question)).toEqual(["so about friday"]);
    });

    it("never delays a message addressed to Tex", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { decide: wait, control: STYLE });
      await bound(storage, w);
      await acceptGroup(storage, w.message("so about friday"), 100);
      await acceptGroup(storage, w.message("Tex what time is dinner?"), 101);
      await drainGroup(storage, w.deps);
      expect(w.asks.map((ask) => ask.question)).toEqual(["Tex what time is dinner?"]);
    });
  });
}
