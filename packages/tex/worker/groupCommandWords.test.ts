/**
 * Which group texts the Worker answers by code, and which go to the agent's
 * tools (Dev2, 2026-10-31; `docs/decisions/texting-assistant/command-tools.md`).
 *
 * An exact short command ("Tex, stop", "Tex start") is answered at once by
 * code, beside a running turn too (`groupBeside.ts`). How Tex talks is not a
 * command since the "Tex, settings" menu was retired (Dev2, 2026-11-11): any
 * wording about it reaches a turn, where the agent has the instructions tool
 * (`apps/mcp/src/agent/commandTools.js`).
 */

import { describe, expect, it } from "vitest";
import { commandTo, groupCommand } from "./groupWords";

describe("exact commands by code, every other wording to the agent", () => {
  it("the short forms are commands, with or without the comma", () => {
    for (const text of ["Tex, settings", "Tex settings", "tex settings?", "hey Tex, settings", "Tex, no emoji", "Tex, be quiet", "Tex, undo the change"]) expect(groupCommand(text), text).toBeNull();
    expect(groupCommand("Tex, stop")).toEqual({ kind: "stop" });
    expect(groupCommand("Tex start")).toEqual({ kind: "start" });
  });

  it("anything said about settings in other words goes to a turn, where the tools are", () => {
    for (const text of ["Tex why don't you listen to settings", "Tex, turn the humor up", "Tex can you be less wordy here", "Tex use fewer emoji"]) {
      expect(groupCommand(text), text).toBeNull();
    }
  });

  // 2026-11-01: "Tex settings" parsed as a command but was never addressed ("settings" read as a verb about Tex), so the chat never answered.
  // 2026-11-11: a command needs Tex's name first; nothing else in a group is read by words (the one judge's).
  it("a command after the name reaches the command path; without the name, or any other words, it does not", () => {
    for (const text of ["Tex start", "tex start", "Tex stop", "hey Tex stop", "@Tex stop", "“Tex stop”", "@\u2068Tex\u2069 stop"]) expect(commandTo(text), text).not.toBeNull();
    for (const text of ["settings", "stop", "Tex settings", "Tex sucks", "Tex keeps forgetting", "Texas stop"]) expect(commandTo(text), text).toBeNull();
  });
});
