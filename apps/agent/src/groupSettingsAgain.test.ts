/**
 * "Tex, settings" in a group, said again and said without a comma (Dev2,
 * 2026-10-29: it did nothing in the Tex Devs chat, several times).
 *
 * Two causes. The same person tagging Tex with the same words within ten
 * minutes was dropped as a repeat (`askedJustNow`, meant for a bug report
 * sent twice), so asking for the menu a second time, or picking "2" in it
 * again, got nothing. And "Tex settings" or "Tex less emoji" was never
 * addressed at all: `addressesTex` reads a word ending in "s" after the name
 * as talking about Tex ("Tex gets it").
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `askedJustNow` asked for code's messages again (`!byCode &&` dropped)
 *     → "asked for again…" and "a menu pick…" fail.
 *  2. `namesCommand` left out of `addressed` → "said without a comma…" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";

const MENU = /^My settings here:/;

for (const { name, groupId } of LINES) {
  describe(`"Tex, settings" in a group, ${name}`, () => {
    it("asked for again a minute later, it shows the menu again", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagement: "followAlong", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex, Settings"), 0);
      await drainGroup(storage, w.deps);
      expect(await acceptGroup(storage, w.message("Tex, Settings"), 60_000)).toBe("queued");
      await drainGroup(storage, { ...w.deps, now: () => 60_001 });
      expect(w.texts).toEqual([expect.stringMatching(MENU), expect.stringMatching(MENU)]);
      expect(w.asks).toEqual([]);
    });

    it("a menu pick the same person made a minute ago still opens that setting", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagement: "followAlong", engagementChosen: true } });
      const steps: [string, number][] = [["Tex, settings", 0], ["8", 10], ["60", 20], ["Tex, settings", 30], ["8", 40], ["40", 50]];
      for (const [text, at] of steps) {
        await acceptGroup(storage, w.message(text), at);
        await drainGroup(storage, { ...w.deps, now: () => at + 1 });
      }
      expect(w.styles.map((set) => set.style)).toEqual([{ humor: 60 }, { humor: 40 }]);
      expect(w.texts.at(-1)).toBe("Humor set to 40% (set by ada).");
    });

    for (const text of ["Tex settings", "Tex Settings!", "@Tex settings", "Tex less emoji"]) {
      it(`said without a comma, ${JSON.stringify(text)} is answered by code`, async () => {
        const storage = new MemoryStorage();
        const w = setup(groupId, { control: { engagement: "followAlong", engagementChosen: true } });
        expect(await acceptGroup(storage, w.message(text), 0)).toBe("queued");
        await drainGroup(storage, w.deps);
        expect(w.texts).toHaveLength(1);
        expect(w.texts[0]).toMatch(text.includes("emoji") ? /^Emoji set to Less/ : MENU);
        expect(w.asks).toEqual([]);
      });
    }

    it("a model's ask sent twice is still answered once", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagement: "followAlong", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex, file a bug: the menu is slow"), 0);
      await drainGroup(storage, w.deps);
      expect(await acceptGroup(storage, w.message("Tex, file a bug: the menu is slow"), 60_000)).toBe("duplicate");
    });
  });
}
