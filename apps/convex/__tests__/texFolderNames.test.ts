import { describe, expect, test } from "vitest";
import { PERSONAL_RENAMES, homeRenames, planRenames } from "../functions/texFolderNames";

/**
 * A PERSON'S TEX FOLDER AND A CHAT'S HOME TAKE THE SAME NAMES (the owner, 2026-11-01; `functions/texFolderNames.ts`).
 * The names must be the gateway's (`apps/mcp/src/agent/homeNames.js`, `aboutMe.js`), and a name already taken is
 * never moved onto.
 */
describe("the Tex folder rename", () => {
  test("a person's note and a home's three notes, by the names the gateway gave them", () => {
    expect(PERSONAL_RENAMES).toEqual([{ from: "tex/about-me.md", to: "tex/about.md" }]);
    expect(homeRenames("tex/groups/orbit-lamp-river", "0123456789abcdef")).toEqual([
      { from: "tex/groups/orbit-lamp-river/about-us.md", to: "tex/groups/orbit-lamp-river/about.md" },
      { from: "tex/groups/orbit-lamp-river/voice-0123456789ab.md", to: "tex/groups/orbit-lamp-river/voice.md" },
      { from: "tex/groups/orbit-lamp-river/chat-0123456789ab.md", to: "tex/groups/orbit-lamp-river/history.md" },
    ]);
  });

  test("only an old name with its new one free is moved; both there is counted and left", () => {
    const renames = homeRenames("h", "0123456789abcdef");
    const live = new Set(["h/about-us.md", "h/chat-0123456789ab.md", "h/history.md"]);
    expect(planRenames(renames, live)).toEqual({ moves: [{ from: "h/about-us.md", to: "h/about.md" }], both: 1 });
    expect(planRenames(renames, new Set(["h/about.md", "h/voice.md", "h/history.md"]))).toEqual({ moves: [], both: 0 });
  });
});
