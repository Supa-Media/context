/**
 * @jest-environment jsdom
 */

/**
 * A BOT'S SETUP IS ON ITS OWN PAGE, ONE PROMPT FOR EVERY AREA IT WORKS IN.
 *
 * Dev, 2026-11-27: "the setup options should be in the bot page". Its setup prompt names each area it owns or acts in,
 * their modes and whom it acts for, and says how it reaches Context: a webhook, or checking in every 5 minutes.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({
  useQuery: () => [],
  useAction: () => async () => ({ ok: true, status: 200 }),
  useMutation: () => async () => null,
}));

import { BotSetup } from "../features/console/files/folderPage/areas/BotSetup";
import { BotLookupsScope, botLookups } from "../features/console/files/folderPage/areas/botHealth";
import { botsOf } from "../features/console/files/folderPage/areas/bots";
import type { ListNote } from "../features/console/files/listBlock/model";
import { all, one, strip } from "./projectPage/fixtures";

const unmounts: Array<() => void> = [];
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
});

const NOTES: ListNote[] = [
  { path: "areas/about.md", properties: { agents: ["Pipeline", "Chief"] } },
  { path: "areas/finance/about.md", properties: { owner: "Pipeline", modes: ["Manager"] } },
  { path: "areas/engineering/about.md", properties: { owner: "@sayo", delegate: "Pipeline" } },
  { path: "bots/pipeline/about.md", properties: { holder: "Pipeline", kind: "agent", bot: "grok", belongs_to: "@seyi" } },
];

async function show(reach: string | undefined) {
  const notes = NOTES.map((note) => (note.path === "bots/pipeline/about.md" && reach !== undefined ? { ...note, properties: { ...note.properties, reach } } : note));
  const bot = botsOf("areas", notes, "@seyi").find((one) => one.name === "Pipeline")!;
  const lookups = botLookups([], null, Date.now());
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      createElement(BotLookupsScope, { lookups }, createElement(BotSetup, { bot, health: lookups.healthOf(bot.name, bot.card.reach), canEdit: true, workspace: "@acme", cardPath: bot.card.path, chooseMany: async () => null })),
    ),
  );
}

describe("a bot's setup on its page", () => {
  test("one prompt covers every area it owns or acts in, with their modes", async () => {
    await show("webhook");
    const text = strip(one("bot-setup-prompt-text").textContent);
    expect(text).toContain("https://mcp.context.lc/mcp");
    expect(text).toContain("(areas/finance)");
    expect(text).toContain("(areas/engineering, for @sayo, who owns it)");
    expect(text).toContain("Manager:");
    // A webhook bot hands its secret over from its own shell.
    expect(text).toContain('header_from_shell: "Authorization"');
  });

  test("a bot that checks in has no webhook step", async () => {
    await show(undefined);
    expect(one("bot-setup-way-check").getAttribute("aria-checked")).toBe("true");
    const text = strip(one("bot-setup-prompt-text").textContent);
    expect(text).toContain('for: "Pipeline"');
    expect(text).not.toContain("header_from_shell");
    expect(all("area-panel-hook-by-hand")).toHaveLength(0);
  });
});
