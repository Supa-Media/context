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

jest.mock("../features/design/clipboard", () => ({ writeClipboard: async () => true }));
jest.mock("convex/react", () => ({
  useQuery: () => [],
  useAction: () => async () => ({ ok: true, status: 200 }),
  useMutation: () => async () => null,
}));

import { BotSetup } from "../features/console/files/folderPage/areas/BotSetup";
import { BotLookupsScope, botLookups } from "../features/console/files/folderPage/areas/botHealth";
import { botsOf } from "../features/console/files/folderPage/areas/bots";
import { backWords, setupSteps } from "../features/console/files/folderPage/areas/setupSteps";
import type { BotHealth } from "../features/console/files/folderPage/areas/botHealth";
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
  { path: "bots/pipeline/about.md", properties: { holder: "Pipeline", kind: "agent", bot: "muse", belongs_to: "@seyi" } },
];

async function show(reach: string | undefined, options: { me?: string; checkedAt?: number } = {}) {
  return await draw(reach, options);
}

/** Draws the setup, and answers a way to draw it again with a later state, as the page's minute re-ask does. */
async function draw(reach: string | undefined, options: { me?: string; checkedAt?: number }, into?: ReturnType<typeof createRoot>) {
  const notes = NOTES.map((note) => (note.path === "bots/pipeline/about.md" && reach !== undefined ? { ...note, properties: { ...note.properties, reach } } : note));
  const bot = botsOf("areas", notes, options.me ?? "@seyi").find((one) => one.name === "Pipeline")!;
  const state = { week: "2026-11-23", routines: [], usage: [], checks: options.checkedAt === undefined ? [] : [{ bot: "pipeline", at: options.checkedAt }] };
  const lookups = botLookups([], state, Date.now());
  let root = into;
  if (root === undefined) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const made = createRoot(container);
    root = made;
    unmounts.push(() => {
      act(() => made.unmount());
      container.remove();
    });
  }
  const drawn = root;
  await act(async () =>
    root.render(
      createElement(BotLookupsScope, { lookups, children: createElement(BotSetup, { bot, health: lookups.healthOf(bot.name, bot.card.reach), canEdit: true, workspace: "@acme", cardPath: bot.card.path, chooseMany: async () => null }) }),
    ),
  );
  return { again: (next: { me?: string; checkedAt?: number }) => draw(reach, next, drawn) };
}

/** Opens the prompt behind "Show the prompt" and reads it. */
async function promptText(): Promise<string> {
  await act(async () => one("bot-setup-prompt-toggle").click());
  return strip(one("bot-setup-prompt-text").textContent);
}

describe("a bot's setup on its page", () => {
  test("one prompt sets it up, naming no area, since which areas it holds changes", async () => {
    await show("webhook");
    const text = await promptText();
    expect(text).toContain("https://mcp.context.lc/mcp");
    // Dev, 2026-11-27: "we shouldnt have area specific wording as area assignments can change".
    expect(text).not.toContain("areas/finance");
    expect(text).not.toContain("areas/engineering");
    expect(text).toContain('orient { context: "@acme", for: "Pipeline" }');
    expect(text).toContain("Manager:");
    // A webhook bot hands its secret over from its own shell.
    expect(text).toContain('header_from_shell: "Authorization"');
  });

  test("a bot that checks in has no webhook step", async () => {
    await show(undefined);
    expect(one("bot-setup-way-check").getAttribute("aria-checked")).toBe("true");
    // Its app's way, and why (`botApps.cjs`).
    expect(strip(one("bot-setup-why").textContent)).toContain("Muse checks in every 5 minutes");
    const text = await promptText();
    expect(text).toContain('for: "Pipeline"');
    expect(text).not.toContain("header_from_shell");
    expect(all("area-panel-hook-by-hand")).toHaveLength(0);
  });
});

// Dev, 2026-11-27: "can you fix this side panel to be more clear on how to set things up?", after a bot read "Not
// answering" and the panel didn't say what to do. While it isn't working, Setup is three numbered steps tied to its
// state; a healthy bot has none.
describe("the steps that set a bot up or bring it back", () => {
  test("a check-in bot that never checked in: copy, paste into its own chat in its app, green at its first check-in", async () => {
    await show(undefined);
    expect(strip(one("bot-setup-steps").textContent)).toContain("Set up Pipeline");
    expect(strip(one("bot-setup-step-paste").textContent)).toBe("Paste it into Pipeline's own chat in Muse. It connects to Context, asks you to sign in, and sets up its check-in every 5 minutes.");
    expect(strip(one("bot-setup-step-green").textContent)).toBe("The status above turns green at its first check-in, within 5 minutes.");
  });

  test("copying ticks step 1", async () => {
    await show(undefined);
    expect(strip(one("bot-setup-step-1").textContent)).toMatch(/^1/);
    await act(async () => one("bot-setup-prompt-copy").click());
    expect(strip(one("bot-setup-prompt-copy").textContent)).toBe("Copied");
    expect(strip(one("bot-setup-step-1").textContent)).not.toMatch(/^1/);
  });

  test("a bot that stopped checking is brought back the same way; someone else is told who can", async () => {
    // Dev, 2026-11-27: "no instructions on how to get it back in good standing?"
    await show(undefined, { checkedAt: Date.now() - 60 * 60 * 1000 });
    expect(strip(one("bot-setup-steps").textContent)).toContain("Get Pipeline checking in again");
    expect(strip(one("bot-setup-step-paste").textContent)).toContain("It sets its 5-minute check-in up again");
    unmounts.pop()!();
    await show(undefined, { me: "@sayo", checkedAt: Date.now() - 60 * 60 * 1000 });
    expect(strip(one("bot-setup-fix").textContent)).toBe("To fix it, @seyi pastes its setup prompt into Pipeline again.");
    expect(all("bot-setup-steps")).toHaveLength(0);
  });

  test("the steps give way to a line saying it is back, once the bot this panel saw failing works", async () => {
    const shown = await show(undefined);
    expect(all("bot-setup-done")).toHaveLength(0);
    await shown.again({ checkedAt: Date.now() - 60 * 1000 });
    expect(all("bot-setup-steps")).toHaveLength(0);
    expect(strip(one("bot-setup-done").textContent)).toBe("Pipeline is checking in. You're all set.");
  });

  test("a bot that checks in has no steps, and keeps its Copy", async () => {
    // A bot already working when the panel opened never shows the "back" line.
    await show(undefined, { checkedAt: Date.now() - 60 * 1000 });
    expect(all("bot-setup-done")).toHaveLength(0);
    expect(all("bot-setup-steps")).toHaveLength(0);
    expect(all("bot-setup-copy")).toHaveLength(1);
  });
});

describe("the words for each state", () => {
  const health = (state: string, why = "") => ({ state, why }) as unknown as BotHealth;
  test("not answering names the routines it has to answer", () => {
    expect(setupSteps("Architect", "Grok", health("not answering", "Its webhook takes calls, but 2 routines have no answer."), "webhook")).toEqual({
      title: "Get Architect answering again",
      paste: "Paste it into Architect's own chat in Grok. It reconnects to Context and finds what is waiting for it.",
      green: "The status above turns green once it answers the 2 routines waiting for it.",
    });
    expect(setupSteps("Architect", "Grok", health("not answering", "It checks in, but a routine has no answer."), "check")?.green).toBe("The status above turns green once it answers the routine waiting for it.");
  });
  test("a webhook bot not set up or failing is green once its test is answered", () => {
    expect(setupSteps("Architect", "Grok", health("not set up"), "webhook")?.green).toBe("The status above turns green once the test is answered.");
    expect(setupSteps("Architect", "Grok", health("webhook failing"), "webhook")?.title).toBe("Get Architect reachable again");
  });
  test("a working bot, or one whose webhook nothing has called yet, has no steps", () => {
    for (const state of ["answering", "checking", "not tried"]) expect(setupSteps("Architect", "Grok", health(state), "webhook")).toBeNull();
    expect(setupSteps("Muse", "Muse", health("checking"), "check")).toBeNull();
  });
  test("a bot that came back says so", () => {
    expect(backWords("Architect", health("answering"))).toBe("Architect is answering.");
    expect(backWords("Muse", health("checking"))).toBe("Muse is checking in.");
  });
});
