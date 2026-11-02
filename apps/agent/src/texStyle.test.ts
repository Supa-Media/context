/**
 * "TEX, SETTINGS" AND HOW TEX TALKS (`texStyle.ts`, `groupSettings.ts`, Dev2, 2026-10-28).
 *
 *  1. The menu has two levels: a number opens a setting, a number or a name
 *     (a percent, for humor) sets it; plain words set the common ones.
 *  2. Any member sets the group's style, and Tex says who did.
 *  3. A group's turn carries the group's own style, as the control plane
 *     keeps it, and nothing else.
 *  4. Emoji: less leaves off the quick tapback; Bubbles: one sends one text.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `menuReply` taking any number for humor: "the menu's two levels" fails;
 *  - `textsFromAnswer` ignoring `maxTexts`: "one bubble per answer" fails.
 */
import { describe, expect, it } from "vitest";
import { textsWithExact } from "./format";
import { acceptGroup, drainGroup } from "./groupInbox";
import { BO, LINES, setup } from "./groupWorld.testing";
import { MemoryStorage } from "./memoryStorage.testing";
import { menuReply, readTexStyle, settingsMenu, styleSet, styleWords, textSettings, type MenuState, type SettingStep } from "./texStyle";

describe("the words", () => {
  it("the menu's two levels", () => {
    const open: MenuState = { at: 0 };
    expect(menuReply("8", open, false)).toEqual({ kind: "menu", step: "humor" });
    expect(menuReply("Tex, 2", open, true)).toEqual({ kind: "menu", step: "tone" });
    expect(menuReply("1", open, false)).toBeNull();
    expect(menuReply("1", open, true)).toEqual({ kind: "menu", step: "engagement" });
    expect(menuReply("9", open, true)).toBeNull();
    expect(menuReply("60%", { at: 0, step: "humor" }, true)).toEqual({ kind: "set", patch: { humor: 60 } });
    for (const off of ["65", "110", "lots"]) expect(menuReply(off, { at: 0, step: "humor" }, true)).toBeNull();
    expect(menuReply("6", { at: 0, step: "tone" }, true)).toEqual({ kind: "set", patch: { tone: "efficient" } });
    expect(menuReply("Cynical", { at: 0, step: "tone" }, true)).toEqual({ kind: "set", patch: { tone: "cynical" } });
    expect(menuReply("2", { at: 0, step: "bubbles" }, true)).toEqual({ kind: "set", patch: { bubbles: "one" } });
  });

  it("plain words for the common settings, the whole text only", () => {
    expect(styleWords("Tex, less emoji")).toEqual({ emoji: "less" });
    expect(styleWords("tex humor 60%")).toEqual({ humor: 60 });
    expect(styleWords("Tex, more warmth")).toEqual({ warmth: "more" });
    expect(styleWords("Tex, tone efficient")).toEqual({ tone: "efficient" });
    expect(styleWords("Tex, one bubble")).toEqual({ bubbles: "one" });
    expect(styleWords("Tex, short answers")).toEqual({ length: "short" });
    for (const text of ["Tex, humor 65%", "less emoji in the invite please", "Tex what's the plan", "tone sarcastic"]) expect(styleWords(text), text).toBeNull();
  });

  it("the menu and the confirmation", () => {
    const menu = settingsMenu({ humor: 60 }, "Helpful");
    expect(menu).toContain("1 When I speak up (Helpful)\n2 Tone (Default)");
    expect(menu).toContain("8 Humor (60%)");
    expect(settingsMenu({})).not.toContain("When I speak up");
    expect(styleSet({ humor: 60 }, "dev2")).toBe("Humor set to 60% (set by dev2).");
    expect(styleSet({ bubbles: "one" })).toBe("Bubbles set to One per answer.");
  });

  it("a style from the control plane is kept only when every part is on its set", () => {
    expect(readTexStyle({ tone: "nerdy", humor: 30 })).toEqual({ tone: "nerdy", humor: 30 });
    expect(readTexStyle({ tone: "nerdy", humor: 35 })).toBeUndefined();
    expect(readTexStyle({})).toBeUndefined();
  });

  it("one bubble per answer, links still on their own", () => {
    const answer = "First part.\n\nSecond part.\n\nThird part. https://example.test/page";
    expect(textsWithExact(answer, [])).toHaveLength(3);
    const one = textsWithExact("First part.\n\nSecond part.\n\nThird part.\n\nhttps://example.test/page", [], true);
    expect(one).toEqual(["First part.\n\nSecond part.\n\nThird part.", "https://example.test/page"]);
  });
});

describe("a 1:1 chat's settings", () => {
  it("menu, choice, saved; anything else goes to the model", async () => {
    let state: MenuState | undefined;
    const menu = { state: async () => state, open: async (step?: SettingStep) => void (state = { at: 0, ...(step ? { step } : {}) }), close: async () => void (state = undefined) };
    const saved: object[] = [];
    const save = async (patch: object) => (saved.push(patch), patch);
    expect(await textSettings("Tex, settings", {}, menu, save)).toMatch(/^My settings here:\n\n2 Tone/);
    expect(await textSettings("8", {}, menu, save)).toMatch(/^Humor is at 75%/);
    expect(await textSettings("40", {}, menu, save)).toBe("Humor set to 40%.");
    expect(saved).toEqual([{ humor: 40 }]);
    expect(await textSettings("40", {}, menu, save)).toBeNull();
    expect(await textSettings("what's on tomorrow?", {}, menu, save)).toBeNull();
    expect(await textSettings("less emoji", {}, menu, save)).toBe("Emoji set to Less.");
  });
});

for (const { name, groupId } of LINES) {
  describe(`a group's settings, ${name}`, () => {
    it("any member walks the menu, Tex says who set it, and the next turn carries the group's style", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex, settings"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts[0]).toMatch(/^My settings here:/);
      await acceptGroup(storage, w.message("8", { from: BO }), 5);
      await drainGroup(storage, w.deps);
      expect(w.texts[1]).toMatch(/^Humor is at 75%/);
      await acceptGroup(storage, w.message("60%", { from: BO }), 6);
      await drainGroup(storage, w.deps);
      expect(w.styles).toEqual([{ line: w.message("").line, groupId, style: { humor: 60 }, setBy: "bo" }]);
      expect(w.texts[2]).toBe("Humor set to 60% (set by bo).");
      expect(w.asks).toEqual([]);
      await acceptGroup(storage, w.message("Tex, less emoji"), 7);
      await drainGroup(storage, w.deps);
      expect(w.texts[3]).toBe("Emoji set to Less (set by ada).");
      await acceptGroup(storage, w.message("Tex what's on tonight"), 8);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.asks[0]!.texStyle).toEqual({ humor: 60, emoji: "less" });
    });

    it("Emoji: less leaves off the quick tapback; Bubbles: one sends one text", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { texStyle: { emoji: "less", bubbles: "one" } }, agent: () => ({ answer: "One.\n\nTwo.\n\nThree." }) });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toEqual([]);
      expect(w.texts).toEqual(["One.\n\nTwo.\n\nThree."]);
      // The same chat with every default: a tapback, and three texts.
      const plain = setup(groupId, { agent: () => ({ answer: "One.\n\nTwo.\n\nThree." }) });
      const fresh = new MemoryStorage();
      await acceptGroup(fresh, plain.message("Tex what's on tonight"), 0);
      await drainGroup(fresh, plain.deps);
      expect(plain.reactions).toHaveLength(1);
      expect(plain.texts).toEqual(["One.", "Two.", "Three."]);
    });
  });
}
