/**
 * "TEX, SETTINGS" AND HOW TEX TALKS (`texStyle.ts`, `groupSettings.ts`, Dev2, 2026-11-01;
 * `docs/decisions/texting-assistant/custom-instructions.md`).
 *
 *  1. "Tex, settings" shows the switches and the full instructions; in a group
 *     it says personal instructions don't apply there.
 *  2. A number opens a list or acts; a pick goes by its id; plain words name a pick.
 *  3. Any member changes the group's instructions, Tex says who and how to
 *     undo, and the next turn carries the group's own instructions.
 *  4. One bubble is an instruction line, not a switch, and emoji no longer
 *     gates the quick tapback.
 *  5. "Tex, stop" is off, "Tex, be quiet" quiet.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `settingsMenu` leaving out the group line: "the menu shows the switches and the full text" and the group walk fail;
 *  - `groupCommand` reading "be quiet" as stop: "the commands" fails;
 *  - the tapback gated again on an emoji line: "no switch in code" fails;
 *  - `unquoted` keeping the bidi isolates: "a mention wrapped in bidi isolates" fails.
 */
import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup } from "./groupInbox";
import { addressesTex, groupCommand, namesTex } from "./groupWords";
import { BO, LINES, setup } from "./groupWorld.testing";
import { MemoryStorage } from "./memoryStorage.testing";
import { menuReply, PICKS, readSettings, settingsMenu, settingSaid, styleWords, textSettings, type Ask, type MenuState, type SettingStep } from "./texStyle";

describe("the words", () => {
  it("the menu's two levels", () => {
    const open: MenuState = { at: 0 };
    expect(menuReply("1", open, false)).toEqual({ kind: "menu", step: "updates" });
    expect(menuReply("Tex, 2", open, false)).toEqual({ kind: "menu", step: "picks" });
    expect(menuReply("3", open, false)).toEqual({ kind: "set", ask: { clear: true } });
    expect(menuReply("4", open, false)).toBeNull();
    expect(menuReply("1", open, true)).toEqual({ kind: "menu", step: "engagement" });
    expect(menuReply("4", open, true)).toEqual({ kind: "set", ask: { clear: true } });
    expect(menuReply("5", open, true)).toBeNull();
    expect(menuReply("2", { at: 0, step: "updates" }, true)).toEqual({ kind: "set", ask: { updates: "planOnly" } });
    expect(menuReply("off", { at: 0, step: "updates" }, true)).toEqual({ kind: "set", ask: { updates: "off" } });
    expect(menuReply("14", { at: 0, step: "picks" }, true)).toEqual({ kind: "set", ask: { pick: "emoji_none" } });
    expect(menuReply("One bubble", { at: 0, step: "picks" }, true)).toEqual({ kind: "set", ask: { pick: "one_bubble" } });
    expect(menuReply(String(PICKS.length + 1), { at: 0, step: "picks" }, true)).toBeNull();
  });

  it("plain words name a pick, the whole text only; a bare undo is the model's", () => {
    expect(styleWords("Tex, no emoji")).toEqual({ pick: "emoji_none" });
    expect(styleWords("Tex, less emoji")).toEqual({ pick: "emoji_less" });
    expect(styleWords("Tex, more warmth")).toEqual({ pick: "warmth_more" });
    expect(styleWords("Tex, tone efficient")).toEqual({ pick: "efficient" });
    expect(styleWords("Tex, one bubble")).toEqual({ pick: "one_bubble" });
    expect(styleWords("Tex, short answers")).toEqual({ pick: "short" });
    expect(styleWords("Tex, no jokes")).toEqual({ pick: "humor_none" });
    expect(styleWords("Tex, undo the change")).toEqual({ undo: true });
    expect(styleWords("Tex, clear instructions")).toEqual({ clear: true });
    for (const text of ["Tex, undo", "undo that", "Tex, no warmth", "less emoji in the invite please", "Tex what's the plan", "tone sarcastic", "Tex, humor 60%"]) expect(styleWords(text), text).toBeNull();
  });

  it("the commands: stop is off, be quiet is a level", () => {
    expect(groupCommand("Tex, stop")).toEqual({ kind: "stop" });
    expect(groupCommand("Tex, mute")).toEqual({ kind: "stop" });
    expect(groupCommand("Tex, be quiet")).toEqual({ kind: "speaks_up", level: "quiet" });
    expect(groupCommand("Tex, come back")).toEqual({ kind: "start" });
    expect(groupCommand("Tex, undo the change")).toEqual({ kind: "style", ask: { undo: true } });
    expect(groupCommand("Tex, no emoji")).toEqual({ kind: "style", ask: { pick: "emoji_none" } });
  });

  it("a mention wrapped in bidi isolates reads as the name", () => {
    expect(namesTex("hey @\u2068Tex\u2069 what's 7 times 8")).toBe(true);
    expect(addressesTex("@\u2068Tex\u2069 what's 7 times 8", false)).toBe(true);
    expect(namesTex("so in this case can Tex help")).toBe(true);
    expect(namesTex("Texas or Tex-Mex")).toBe(false);
  });

  it("the menu shows the switches and the full text", () => {
    const group = settingsMenu({ instructions: "Use no emoji.\nCall us the crew.", updates: "planOnly" }, "Helpful");
    expect(group).toBe(
      "My settings in this chat:\n\n1 When I speak up (Helpful)\n2 Progress updates (Plan only)\n3 Quick picks\n4 Clear instructions\n\n" +
        "How I talk here (anyone here can change it):\nUse no emoji.\nCall us the crew.\n\nPersonal instructions don't apply in groups.\n\nReply with a number.",
    );
    const own = settingsMenu({});
    expect(own).toMatch(/^My settings here:\n\n1 Progress updates \(Normal\)\n2 Quick picks\n3 Clear instructions\n\nHow I talk to you:\nNothing yet\./);
    expect(own).not.toContain("When I speak up");
    expect(settingSaid({ pick: "emoji_none" }, { instructions: "Be kind.\nUse no emoji." }, "dev2")).toBe('dev2 set: "Use no emoji.". Anyone here can text "Tex, undo the change" to put it back.');
    expect(settingSaid({ updates: "off" }, { updates: "off" })).toBe("Progress updates set to Off.");
  });

  it("settings from the control plane are kept only as they may be", () => {
    expect(readSettings({ instructions: "Be brief.", updates: "off", texStyle: { humor: 60 } })).toEqual({ instructions: "Be brief.", updates: "off" });
    expect(readSettings({ instructions: "x".repeat(1_501), updates: "loud" })).toEqual({});
  });
});

describe("a 1:1 chat's settings", () => {
  it("menu, list, pick saved by id; anything else goes to the model", async () => {
    let state: MenuState | undefined;
    const menu = { state: async () => state, open: async (step?: SettingStep) => void (state = { at: 0, ...(step ? { step } : {}) }), close: async () => void (state = undefined) };
    const saved: Ask[] = [];
    const save = async (ask: Ask) => (saved.push(ask), ask.undo ? ("nothing_to_undo" as const) : { instructions: ask.pick ? `${ask.pick} line.` : undefined });
    expect(await textSettings("Tex, settings", {}, menu, save)).toMatch(/^My settings here:\n\n1 Progress updates/);
    expect(await textSettings("2", {}, menu, save)).toMatch(/^Quick picks, each adds a line/);
    expect(await textSettings("5", {}, menu, save)).toBe('Saved: "efficient line.". Text "Tex, undo the change" to put it back.');
    expect(saved).toEqual([{ pick: "efficient" }]);
    expect(await textSettings("5", {}, menu, save)).toBeNull();
    expect(await textSettings("what's on tomorrow?", {}, menu, save)).toBeNull();
    expect(await textSettings("undo the change", {}, menu, save)).toBe("There's nothing to undo.");
  });
});

for (const { name, groupId } of LINES) {
  describe(`a group's settings, ${name}`, () => {
    it("any member walks the menu, Tex says who set it, and the next turn carries the group's own instructions", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId);
      await acceptGroup(storage, w.message("Tex, settings"), 0);
      await drainGroup(storage, w.deps);
      expect(w.texts[0]).toMatch(/^My settings in this chat:/);
      expect(w.texts[0]).toContain("Personal instructions don't apply in groups.");
      await acceptGroup(storage, w.message("3", { from: BO }), 5);
      await drainGroup(storage, w.deps);
      expect(w.texts[1]).toMatch(/^Quick picks/);
      await acceptGroup(storage, w.message("13", { from: BO }), 6);
      await drainGroup(storage, w.deps);
      expect(w.styles).toEqual([{ line: w.message("").line, groupId, pick: "emoji_less", setBy: "bo" }]);
      expect(w.texts[2]).toBe('bo set: "emoji_less line.". Anyone here can text "Tex, undo the change" to put it back.');
      expect(w.asks).toEqual([]);
      await acceptGroup(storage, w.message("Tex, short answers"), 7);
      await drainGroup(storage, w.deps);
      expect(w.texts[3]).toBe('ada set: "short line.". Anyone here can text "Tex, undo the change" to put it back.');
      await acceptGroup(storage, w.message("Tex, undo the change", { from: BO }), 8);
      await drainGroup(storage, w.deps);
      expect(w.texts[4]).toBe("bo put it back. How I talk here now:\nemoji_less line.");
      await acceptGroup(storage, w.message("Tex what's on tonight"), 9);
      await drainGroup(storage, w.deps);
      expect(w.asks).toHaveLength(1);
      expect(w.asks[0]!.instructions).toBe("emoji_less line.");
      expect(w.asks[0]).not.toHaveProperty("texStyle");
    });

    // iMessage answers a command from the webhook's names with the groups API down (#2659); WhatsApp's webhook names only the sender.
    it("\"Tex, be quiet\" sets quiet with the group's turn", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { ...(name.startsWith("iMessage") ? { members: [null] } : {}), controlFor: (body) => ((body.command as { kind?: string } | undefined)?.kind === "speaks_up" ? { status: "speaks_up", level: "quiet", by: "bo" } : undefined) });
      await acceptGroup(storage, w.message("Tex, be quiet", { from: BO }), 0);
      await drainGroup(storage, w.deps);
      expect(w.control.at(-1)!.command).toEqual({ kind: "speaks_up", level: "quiet" });
      expect(w.texts).toEqual(['Got it, Quiet (set by bo). To change it later, text "Tex, settings".']);
    });

    it("no switch in code: a one-bubble line sends what the model wrote, with no tapback beside it", async () => {
      const storage = new MemoryStorage();
      const w = setup(groupId, { control: { instructions: "Use no emoji.\nSend each answer as one text, with no blank lines." }, agent: () => ({ answer: "One.\n\nTwo.\n\nThree." }) });
      await acceptGroup(storage, w.message("Tex what's on tonight"), 0);
      await drainGroup(storage, w.deps);
      expect(w.reactions).toHaveLength(0);
      expect(w.texts).toEqual(["One.", "Two.", "Three."]);
    });
  });
}
