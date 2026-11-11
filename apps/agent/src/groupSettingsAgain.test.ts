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
 *
 * The second cause was fixed on main on 2026-11-01 (`addressesTex` reads a
 * command after the name as addressed); the no-comma cases stay here to keep
 * both halves of the report covered.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";

// The group menu since 2026-11-01 (`texStyle.ts` `settingsMenu`).
const MENU = /^My settings in this chat:/;

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
      // "3" opens Quick picks and "13" is Less emoji (`texStyle.ts` `PICKS`): the same words twice, as the dial picks were.
      const steps: [string, number][] = [["Tex, settings", 0], ["3", 10], ["13", 20], ["Tex, settings", 30], ["3", 40], ["13", 50]];
      for (const [text, at] of steps) {
        await acceptGroup(storage, w.message(text), at);
        await drainGroup(storage, { ...w.deps, now: () => at + 1 });
      }
      expect(w.styles.map((set) => set.pick)).toEqual(["emoji_less", "emoji_less"]);
      expect(w.texts.at(-1)).toBe('ada set: "emoji_less line.". Anyone here can text "Tex, undo the change" to put it back.');
    });

    for (const text of ["Tex settings", "Tex Settings!", "@Tex settings", "Tex less emoji"]) {
      it(`said without a comma, ${JSON.stringify(text)} is answered by code`, async () => {
        const storage = new MemoryStorage();
        const w = setup(groupId, { control: { engagement: "followAlong", engagementChosen: true } });
        expect(await acceptGroup(storage, w.message(text), 0)).toBe("queued");
        await drainGroup(storage, w.deps);
        expect(w.texts).toHaveLength(1);
        expect(w.texts[0]).toMatch(text.includes("emoji") ? /^ada set: "emoji_less line\."/ : MENU);
        expect(w.asks).toEqual([]);
      });
    }

    it("a model's ask sent twice is still answered once", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { engagement: "followAlong", engagementChosen: true } });
      await acceptGroup(storage, w.message("Tex, file a bug: the menu is slow"), 0);
      await drainGroup(storage, w.deps);
      // Dev2, 2026-11-11: the repeat reaches the judge like any message, and is dropped after it (`notAskedAgain`).
      await acceptGroup(storage, w.message("Tex, file a bug: the menu is slow"), 60_000);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
    });
  });
}
