/**
 * @jest-environment jsdom
 */

/**
 * THE AREAS FOLDER SHOWS ITS BOTS AND THE MAIL BETWEEN THEM, AND WRITING TO A BOT IS MAIL.
 *
 * The owner, 2026-11-25, approving the prototype: "make it clear in the UI that its not a chat, and that its mail,
 * because we wont be able to see into its thinking, stream, etc". Areas › Bots lists every bot, a press shows it in
 * the side panel with what it did, where it works and its caps (only its person changes those), its routines and
 * its mail, and a box that says it is mail. Areas › Mail lists the conversations, bot to bot or the reader's own.
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
import { all, entry, host, mount, one, press, strip, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

const NOTES: ListNote[] = [
  { path: "areas/about.md", properties: { agents: ["Grok Bot", "Socials"] } },
  { path: "areas/bots/about.md", properties: { area: "false" } },
  { path: "areas/bots/grok-bot/about.md", properties: { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi", reach: "webhook", works_in: ["areas/scorecard · 20%"] } },
  { path: "areas/bots/socials/about.md", properties: { holder: "Socials", kind: "agent", bot: "grok", belongs_to: "@shyoh" } },
  { path: "areas/scorecard/about.md", properties: { owner: "Grok Bot" } },
  { path: "areas/scorecard/mail/socials.md", properties: {} },
  { path: "areas/growth/about.md", properties: { owner: "@shyoh", delegate: "Socials" } },
];

const BODIES: Record<string, string> = {
  "areas/scorecard/mail/socials.md": "# Mail with Grok Bot\n\n```mail\n- 2026-11-25T20:00:00.000Z socials (Grok) to everyone: Growth's number is in.\n- 2026-11-25T20:05:00.000Z grok-bot (Grok) to everyone [used 3%]: Thanks, scored it.\n```\n",
};

const LISTING: FolderListing = {
  path: "areas",
  folderDefault: "team",
  entries: [entry("folder", "areas/scorecard"), entry("folder", "areas/growth"), entry("folder", "areas/bots")],
  truncated: false,
  manifestUsable: true,
};

beforeEach(() => forgetViews());
afterEach(unmountAll);

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("Areas › Bots and Mail", () => {
  test("the bots folder is never drawn as an area, and the Areas folder offers Bots and Mail", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: BODIES }), LISTING);
    expect(all("area-row-areas/bots")).toHaveLength(0);
    expect(all("folder-view-bots")).toHaveLength(1);
    expect(all("folder-view-talks")).toHaveLength(1);
  });

  test("Bots lists every bot, theirs first; a press shows it, with mail that says it is mail", async () => {
    windowOf(1440);
    const writes: Write[] = [];
    const files: string[] = [];
    await mount(host(writes, { notes: NOTES, bodies: BODIES, files }), LISTING);
    await press(one("folder-view-bots"));
    await settle();
    const view = strip(one("areas-bots-view").textContent);
    expect(view.indexOf("Grok Bot")).toBeLessThan(view.indexOf("Socials"));
    expect(view).toContain("20% of its week here");
    expect(view).toContain("@shyoh's · only @shyoh can change them");
    await press(one("areas-bot-Grok Bot"));
    await settle();
    expect(strip(one("bot-panel-whose").textContent)).toBe("Yours: only you change where it works and its caps");
    expect(strip(one("bot-panel-mail-note").textContent)).toContain("Mail, not a chat: goes to areas/bots/grok-bot/mail/seyi.md");
    // Its activity is what it wrote in Context mail.
    expect(strip(one("bot-panel").textContent)).toContain("Thanks, scored it.");
    // Where it works, with its cap, which its person sets.
    await press(one("bot-panel-tab-works"));
    expect(all("bot-panel-area-areas/scorecard")).toHaveLength(1);
    expect(all("bot-panel-cap-Weekly cap for Scorecard")).toHaveLength(1);
  });

  test("someone else's bot shows its caps but has no field to change them", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: BODIES, files: [] }), LISTING);
    await press(one("folder-view-bots"));
    await settle();
    await press(one("areas-bot-Socials"));
    await settle();
    expect(strip(one("bot-panel-whose").textContent)).toBe("Only @shyoh changes where it works and its caps");
    await press(one("bot-panel-tab-works"));
    expect(all("bot-panel-cap-Weekly cap for Growth")).toHaveLength(0);
  });

  test("writing to a bot starts a mail note in its own folder", async () => {
    windowOf(1440);
    const files: string[] = [];
    await mount(host([], { notes: NOTES, bodies: BODIES, files }), LISTING);
    await press(one("folder-view-bots"));
    await settle();
    await press(one("areas-bot-Grok Bot"));
    await settle();
    await press(one("bot-panel-refresh"));
    await settle();
    expect(files.some((line) => line.startsWith("create areas/bots/grok-bot/mail/seyi.md\n# Mail with Grok Bot"))).toBe(true);
    expect(files.join("\n")).toContain("if your name or your logo has changed");
  });

  test("Mail lists the conversations, and Bot to bot keeps the ones between bots", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: BODIES }), LISTING);
    await press(one("folder-view-talks"));
    await settle();
    expect(strip(one("areas-mail-view").textContent)).toContain("socials ↔ Grok Bot");
    await press(one("areas-mail-filter-mine"));
    expect(all("areas-mail-areas/scorecard/mail/socials.md")).toHaveLength(0);
    await press(one("areas-mail-filter-bots"));
    expect(all("areas-mail-areas/scorecard/mail/socials.md")).toHaveLength(1);
  });
});
