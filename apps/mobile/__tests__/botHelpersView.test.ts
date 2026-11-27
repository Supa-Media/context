/**
 * @jest-environment jsdom
 */

/**
 * A BOT'S HELPERS SHOW AS ITS SUB-AGENTS, NEVER AS A BARE CLAUDE.
 *
 * Dev, 2026-11-27: the Claude Code session a bot starts for deep work should be visible, recording its progress, and
 * "it doesn't register directly as Claude, but it registers as Claude by way of grok"
 * (`docs/decisions/app-and-console/bot-helpers.md`). Each helper is a note in `bots/<bot>/helpers/`; the bot's panel
 * lists the live ones with their progress and folds the ended ones, the Bots page says how many are working, and
 * Agent Mail names its lines "Claude via Grok Bot". All values here are fake.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({
  useQuery: () => [],
  useAction: () => async () => ({ ok: true, status: 200 }),
  useMutation: () => async () => null,
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => {
    throw new Error("No fixture gateway session");
  },
}));

import type { ListNote } from "../features/console/files/listBlock/model";
import type { FolderListing } from "../features/console/files/types";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { resetRefreshes } from "../features/console/files/folderPage/areas/refreshBot";
import { endedLine, helpersOf, liveLine, statusWords } from "../features/console/files/folderPage/areas/botHelpers";
import { helperOfBot, helperParts, helperWords } from "../features/console/faces/helperName";
import { nameOf } from "../features/console/mailPage/model";
import { all, entry, host, mount, one, press, strip, unmountAll, windowOf } from "./projectPage/fixtures";

const NOW = Date.parse("2026-11-27T19:20:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const later = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const CARD: ListNote = { path: "bots/grok-bot/about.md", properties: { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi" } };
// As the gateway writes a helper's note (`@context/shared/src/botHelpers.cjs` `helperNote`), then as it goes.
const helper = (slug: string, properties: Record<string, string>): ListNote => ({
  path: `bots/grok-bot/helpers/2026-11-27-${slug}.md`,
  properties: { kind: "helper", helper: "Claude", via: "Grok Bot", bot: "grok-bot", helper_id: "hlp_0123456789abcdef", started: ago(14), ends: later(8), status: "working", progress: "Starting", ...properties },
});
const NOTES: ListNote[] = [
  { path: "areas/about.md", properties: { agents: ["Grok Bot", "Architect"] } },
  CARD,
  { path: "bots/architect/about.md", properties: { holder: "Architect", kind: "agent", bot: "grok", belongs_to: "@seyi" } },
  helper("fix-search", { task: "Fix the reading-list search miss", progress: "Opened PR #3744, CI running" }),
  helper("calendar-sync", { task: "Check the calendar sync", status: "waiting", started: ago(3), progress: "Asked Calendar about the token" }),
  helper("old", { task: "Tidy the scorecard", status: "done", ended: ago(120), progress: "Merged" }),
];
const BOTS: FolderListing = { path: "bots", folderDefault: "team", entries: [entry("folder", "bots/grok-bot"), entry("folder", "bots/architect")], truncated: false, manifestUsable: true };

beforeEach(() => {
  forgetViews();
  resetRefreshes();
});
afterEach(unmountAll);

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("a bot's helpers, read from their notes", () => {
  test("live ones first, each named with its bot; one whose time ran out reads stopped, not working forever", () => {
    const lapsed = helper("lapsed", { task: "Run the bench", ends: ago(5) });
    const helpers = helpersOf({ name: "Grok Bot", card: CARD }, [...NOTES, lapsed, { path: "bots/grok-bot/helpers/notes.md", properties: {} }], NOW);
    expect(helpers.map((each) => [each.task, each.status])).toEqual([
      ["Check the calendar sync", "waiting"],
      ["Fix the reading-list search miss", "working"],
      ["Run the bench", "stopped"],
      ["Tidy the scorecard", "done"],
    ]);
    expect(helpers.every((each) => each.name === "Claude via Grok Bot")).toBe(true);
    expect(statusWords(helpers[1]!, NOW)).toBe("Working · 14 min");
    expect(statusWords(helpers[0]!, NOW)).toBe("Waiting on an answer · 3 min");
    expect(liveLine(helpers)).toBe("1 helper working, 1 waiting");
    expect(endedLine(helpers.slice(2), NOW)).toBe("2 ended earlier today");
    // A note whose front matter only has the gateway's helper_id is a helper too; a bot with none has none.
    expect(helpersOf({ name: "Grok Bot", card: CARD }, [helper("bare", { kind: "" })], NOW)).toHaveLength(1);
    expect(helpersOf({ name: "Architect", card: NOTES[2] as ListNote & { path: string } }, NOTES, NOW)).toEqual([]);
  });

  test("a helper's mail name reads back as \"Claude via Grok Bot\", its bot matched by the start of its name", () => {
    expect(helperParts("claude-via-grok-bot-a3f1")).toEqual({ helper: "claude", bot: "grok-bot" });
    expect(helperWords("claude-via-grok-bot-a3f1")).toBe("Claude via Grok Bot");
    expect(helperWords("claude-via-tex-qual-a3f1", "Tex Quality")).toBe("Claude via Tex Quality");
    expect(helperOfBot(helperParts("claude-via-tex-qual-a3f1"), "tex-quality-and-research")).toBe(true);
    expect(helperOfBot(helperParts("claude-via-grok-bot-a3f1"), "architect")).toBe(false);
    expect(nameOf("claude-via-grok-bot-a3f1")).toBe("Claude via Grok Bot");
    expect(helperParts("grok-bot")).toBeNull();
    expect(nameOf("grok-bot")).toBe("Grok Bot");
  });
});

describe("the Bots page and the bot's panel", () => {
  test("the row says how many are working; the panel lists them with progress, and folds the ended", async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ["setTimeout", "setInterval", "queueMicrotask", "nextTick", "setImmediate", "clearTimeout", "clearInterval"] });
    try {
      windowOf(1440);
      await mount(host([], { notes: NOTES, bodies: {}, files: [] }), BOTS);
      await settle();
      expect(strip(one("areas-bot-helpers-Grok Bot").textContent)).toBe("1 helper working, 1 waiting");
      expect(all("areas-bot-helpers-Architect")).toHaveLength(0);
      // A helper's note is never read as a bot of its own.
      expect(strip(one("areas-bots-view").textContent)).not.toContain("Claude");
      await press(one("areas-bot-Grok Bot"));
      await settle();
      const section = strip(one("bot-panel-helpers").textContent);
      expect(section).toContain("Claude via Grok Bot");
      expect(section).toContain("Fix the reading-list search miss");
      expect(section).toContain("Working · 14 min · Opened PR #3744, CI running");
      expect(section).toContain("1 done earlier today");
      expect(section).not.toContain("Tidy the scorecard");
      expect(section).not.toMatch(/(^|[^a-z])Claude(?! via)/);
      await press(one("bot-panel-helpers-ended"));
      expect(strip(one("bot-panel-helpers").textContent)).toContain("Tidy the scorecard");
      expect(all("bot-panel-helper-bots/grok-bot/helpers/2026-11-27-fix-search.md")).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a bot that never had a helper keeps the panel it has today", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: {}, files: [] }), BOTS);
    await settle();
    await press(one("areas-bot-Architect"));
    await settle();
    expect(all("bot-panel-helpers")).toHaveLength(0);
  });
});
