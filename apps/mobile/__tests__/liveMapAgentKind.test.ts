/**
 * WHICH AI A MAP ACTOR IS, AND ITS COLOUR.
 *
 * Every AI tool has a colour; people keep their faces (owner, 2026-10-09). An
 * agent is always a robot (PR #1097), so the colour is what tells Claude from
 * Codex on the map. The classification is `agentKind.ts`, read by the React
 * faces and by the canvas engine alike, so the feed and the map cannot disagree.
 *
 * ## Sabotage record
 *
 *   agentKindOf reads the owner's name (not the tool's)        "owner name never decides" fails
 *   agentKindOf classifies a person as an agent                 "a person is never an agent" fails
 *   the texting client matched loosely (/texts/)                "an unknown tool" row fails
 *   agentTint uses a non-deterministic spare pick               "stable spare colour" fails
 *   a dark glyph on the light tints                             "glyph reads on its tint" fails
 */
import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { darkColors, darkMapColors, lightColors, lightMapColors, type MapColors } from "../features/design/tokens/colors";
import {
  CONSOLE_CLIENT_NAME,
  TEXTS_CLIENT_NAME,
  agentKindOf,
  agentPaintOf,
  agentTint,
  ownerNameOf,
  spareIndexOf,
  toolNameOf,
} from "../features/console/map/live/agentKind";

const AI_KINDS = ["claude", "codex", "chatgpt", "context"] as const;
const agent = (name: string) => ({ kind: "agent" as const, name });
const person = (name: string) => ({ kind: "person" as const, name });

describe("which AI an agent is, by its tool's name", () => {
  test.each([
    ["Claude", "claude"],
    ["@maya's Claude", "claude"],
    ["Seyi's Claude", "claude"],
    ["Claude Code", "claude"],
    ["@maya's Claude Code", "claude"],
    ["Codex", "codex"],
    ["@jon's Codex", "codex"],
    ["ChatGPT", "chatgpt"],
    ["@ruth's ChatGPT", "chatgpt"],
    ["OpenAI", "chatgpt"],
    ["Texts (iMessage)", "context"],
    ["@seyi's Texts (iMessage)", "context"],
    ["Inbox sorter", "other"],
    ["Cursor", "other"],
    ["@maya's Cursor", "other"],
  ])("%s is %s", (name, kind) => {
    expect(agentKindOf(agent(name))).toBe(kind);
  });

  test("the owner's name never decides which tool it is", () => {
    expect(agentKindOf(agent("@claude's Codex"))).toBe("codex");
    expect(agentKindOf(agent("@codex's Claude"))).toBe("claude");
    expect(agentKindOf(agent("@claude's Texts (iMessage)"))).toBe("context");
    expect(agentKindOf(agent("@chatgpt's Cursor"))).toBe("other");
  });

  test("the texting assistant is its client name exactly, not a loose match", () => {
    expect(TEXTS_CLIENT_NAME).toBe("Texts (iMessage)");
    expect(agentKindOf(agent("@seyi's Texts"))).toBe("other");
    expect(agentKindOf(agent("Texts"))).toBe("other");
  });

  test("the name helpers split an owner from a tool", () => {
    expect(toolNameOf("@maya's Claude Code")).toBe("Claude Code");
    expect(toolNameOf("Cursor")).toBe("Cursor");
    expect(ownerNameOf("@maya's Claude")).toBe("@maya");
    expect(ownerNameOf("Cursor")).toBeNull();
  });
});

describe("a person is never an agent, and the app's own console is not one either", () => {
  test("a person is never classified as an AI", () => {
    expect(agentKindOf(person("Maya"))).toBeNull();
    expect(agentKindOf(person("Claude"))).toBeNull();
    expect(agentKindOf(person("Codex"))).toBeNull();
    expect(agentKindOf(person("@seyi's Texts (iMessage)"))).toBeNull();
  });

  test("the console's own client is a person's hand, not a tool", () => {
    expect(CONSOLE_CLIENT_NAME).toBe("Context (this app)");
    expect(agentKindOf(agent("@dev2's Context (this app)"))).toBeNull();
    expect(agentKindOf(agent(CONSOLE_CLIENT_NAME))).toBeNull();
  });

  test("the client names match the control plane's own constants", () => {
    // Cross-package: the names are written in the control plane and read here.
    const root = join(__dirname, "../../convex/functions");
    expect(readFileSync(join(root, "textLinks.ts"), "utf8")).toContain(`const TEXTS_CLIENT_NAME = "${TEXTS_CLIENT_NAME}";`);
    expect(readFileSync(join(root, "agentGrant.ts"), "utf8")).toContain(`const CONSOLE_CLIENT_NAME = "${CONSOLE_CLIENT_NAME}";`);
  });
});

describe("the tint each AI is drawn in", () => {
  const themes: Array<[string, MapColors, typeof lightColors]> = [
    ["light", lightMapColors, lightColors],
    ["dark", darkMapColors, darkColors],
  ];

  test.each(themes)("%s theme: the named AIs take their named tints", (_, map) => {
    expect(agentTint("claude", "Claude", map)).toBe(map.agentClaude);
    expect(agentTint("codex", "Codex", map)).toBe(map.agentCodex);
    expect(agentTint("chatgpt", "ChatGPT", map)).toBe(map.agentChatgpt);
    expect(agentTint("context", TEXTS_CLIENT_NAME, map)).toBe(map.agentContext);
  });

  test.each(themes)("%s theme: the texting assistant is the app's accent", (_, map, colors) => {
    expect(map.agentContext).toBe(colors.accent);
  });

  test("the light tints are a shade deeper than the dark ones, as specified", () => {
    expect(lightMapColors.agentClaude).toBe("#d9712e");
    expect(lightMapColors.agentCodex).toBe("#7d5fd6");
    expect(lightMapColors.agentChatgpt).toBe("#5f9e3c");
    expect(darkMapColors.agentClaude).toBe("#e8894a");
    expect(darkMapColors.agentCodex).toBe("#a58be8");
    expect(darkMapColors.agentChatgpt).toBe("#8fc46a");
  });

  test.each(themes)("%s theme: every AI's tint is distinct from every other's", (_, map) => {
    const tints = [...AI_KINDS.map((k) => agentTint(k, "x", map)), map.agentBlue, map.agentPink, map.agentAmber];
    expect(new Set(tints).size).toBe(tints.length);
  });

  test.each(themes)("%s theme: the glyph reads on every tint (3:1 or better)", (_, map) => {
    const glyph = map.agentGlyph;
    const tints = [map.agentClaude, map.agentCodex, map.agentChatgpt, map.agentContext, map.agentBlue, map.agentPink, map.agentAmber];
    for (const tint of tints) expect(contrast(glyph, tint)).toBeGreaterThanOrEqual(3);
  });

  test("an unknown tool takes a stable colour from the spare set, never an AI's", () => {
    const spare = [lightMapColors.agentBlue, lightMapColors.agentPink, lightMapColors.agentAmber];
    const names = ["Cursor", "Windsurf", "Zed", "Aider", "Goose", "Continue", "Cline", "Replit", "Gemini CLI", "Copilot"];
    const seen = new Set<string>();
    for (const name of names) {
      const first = agentTint("other", `@maya's ${name}`, lightMapColors);
      expect(spare).toContain(first);
      // Stable: the same tool is the same colour, whoever's it is and however often asked.
      expect(agentTint("other", `@jon's ${name}`, lightMapColors)).toBe(first);
      expect(agentTint("other", `@maya's ${name}`, lightMapColors)).toBe(first);
      seen.add(first);
    }
    // And not all one colour: the spare set is used.
    expect(seen.size).toBeGreaterThan(1);
  });

  test("the spare pick is a fixed function of the tool's name, in every theme", () => {
    for (const name of ["Cursor", "Zed", "Aider"]) {
      const index = spareIndexOf(name, 3);
      expect(index).toBe(spareIndexOf(name, 3));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(3);
    }
    expect(agentTint("other", "@x's Zed", darkMapColors)).toBe(
      [darkMapColors.agentBlue, darkMapColors.agentPink, darkMapColors.agentAmber][spareIndexOf("zed", 3)],
    );
  });
});

describe("how an agent is painted", () => {
  test("the texting assistant is a round teal badge with a bubble; every other AI is a robot tile", () => {
    expect(agentPaintOf(agent(`@seyi's ${TEXTS_CLIENT_NAME}`), lightMapColors)).toMatchObject({
      kind: "context",
      shape: "bubble",
      tint: lightMapColors.agentContext,
      glyph: lightMapColors.agentGlyph,
    });
    for (const name of ["Seyi's Claude", "Codex", "ChatGPT", "Cursor"]) {
      expect(agentPaintOf(agent(name), darkMapColors)).toMatchObject({ shape: "robot", glyph: darkMapColors.agentGlyph });
    }
  });

  test("a person has no paint here: their face is theirs", () => {
    expect(agentPaintOf(person("Maya"), lightMapColors)).toBeNull();
  });
});

/** WCAG relative-luminance contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const L = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
