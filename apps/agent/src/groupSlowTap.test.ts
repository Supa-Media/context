/**
 * A SLOW GROUP ANSWER GETS A TAPBACK FROM CODE, AND THE INTRO RIDES ON THE ANSWER (`groupSlowTap.ts`,
 * `groupModelTurn.ts` `withIntro`; Dev2, 2026-11-12, Nov Babies issue 6: a new group's first text got a fixed intro
 * bubble and no tapback, then 70 s of nothing).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. no disarm in `groupSay.ts` `sayNow` → "taps a message naming Tex when nothing of Tex's has gone out" fails.
 *  2. no bound check in `slowTap` → "never taps a chat Tex is not set up in" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";
import { SLOW_TAP_MS, slowTap, slowTapArmed } from "./groupSlowTap";
import { withIntro } from "./groupModelTurn";

for (const { name, groupId } of LINES) {
  describe(`a slow answer's tapback, ${name}`, () => {
    it("taps a message naming Tex when nothing of Tex's has gone out by the time it is due, once", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex, hi"), 0);
      await drainGroup(storage, w.deps); // binds the chat and answers: a text went out, so nothing to tap
      expect(await slowTap(storage, w.deps, "in_1", SLOW_TAP_MS)).toBe(false);
      const next = w.message("Tex, and the load in?"); // its answer is still being written
      await acceptGroup(storage, next, 1_000);
      expect(await slowTapArmed(storage, next.messageId)).toBe(true);
      expect(await slowTap(storage, w.deps, next.messageId, 1_000 + SLOW_TAP_MS - 1)).toBe(false); // not yet
      expect(await slowTap(storage, w.deps, next.messageId, 1_000 + SLOW_TAP_MS)).toBe(true);
      expect(w.reactions).toHaveLength(1);
      expect(await slowTap(storage, w.deps, next.messageId, 1_000 + 2 * SLOW_TAP_MS)).toBe(false); // once
    });

    it("never taps a chat Tex is not set up in, or a message nobody named Tex in", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      const first = w.message("Tex, hi");
      await acceptGroup(storage, first, 0); // a first look: not bound yet
      expect(await slowTap(storage, w.deps, first.messageId, SLOW_TAP_MS)).toBe(false);
      expect(w.reactions).toHaveLength(0);
      await drainGroup(storage, w.deps);
      const chat = w.message("dinner at 8?");
      await acceptGroup(storage, chat, 1_000);
      expect(await slowTapArmed(storage, chat.messageId)).toBe(false);
    });
  });
}

describe("the intro on the first answer", () => {
  it("is the last text's last line; a bare link and an exact text stay as they are, with the intro after them", () => {
    expect(withIntro(["Here it is"], "I'm Tex.")).toEqual(["Here it is\n\nI'm Tex."]);
    expect(withIntro(["Here it is", "https://context.lc/p/x"], "I'm Tex.")).toEqual(["Here it is", "https://context.lc/p/x", "I'm Tex."]);
    expect(withIntro(["Draft below", "Send this?"], "I'm Tex.", ["Send this?"])).toEqual(["Draft below", "Send this?", "I'm Tex."]);
    expect(withIntro([], "I'm Tex.")).toEqual([]);
    expect(withIntro(["Hi"], null)).toEqual(["Hi"]);
  });
});
