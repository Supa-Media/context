/**
 * @jest-environment jsdom
 */

/**
 * BOTS LIVE IN THEIR OWN FOLDER BESIDE THE AREAS, AND WRITING TO A BOT IS MAIL.
 *
 * The owner, 2026-11-25, approving the prototype: "make it clear in the UI that its not a chat, and that its mail,
 * because we wont be able to see into its thinking, stream, etc"; then "top level bots yes", in place of the Areas
 * folder's Bots and Mail tabs. `bots/` lists every bot, a press shows it in the side panel with what it did, where it
 * works and its caps (only its person changes those), its routines and its mail, and a box that says it is mail.
 * `bots/<bot>/` is that bot's page. A card still in the Areas folder's old `bots/` is read where it is.
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
  { path: "bots/grok-bot/about.md", properties: { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi", reach: "webhook", works_in: ["areas/scorecard · 20%"] } },
  // Still where bots lived first, inside the Areas folder.
  { path: "areas/bots/socials/about.md", properties: { holder: "Socials", kind: "agent", bot: "grok", belongs_to: "@shyoh" } },
  { path: "areas/scorecard/about.md", properties: { owner: "Grok Bot" } },
  { path: "areas/scorecard/mail/socials.md", properties: {} },
  { path: "areas/growth/about.md", properties: { owner: "@shyoh", delegate: "Socials" } },
];

const BODIES: Record<string, string> = {
  "areas/scorecard/mail/socials.md": "# Mail with Grok Bot\n\n```mail\n- 2026-11-25T20:00:00.000Z socials (Grok) to everyone: Growth's number is in.\n- 2026-11-25T20:05:00.000Z grok-bot (Grok) to everyone [used 3%]: Thanks, scored it.\n```\n",
};

const AREAS: FolderListing = {
  path: "areas",
  folderDefault: "team",
  entries: [entry("folder", "areas/scorecard"), entry("folder", "areas/growth"), entry("folder", "areas/bots")],
  truncated: false,
  manifestUsable: true,
};
const BOTS: FolderListing = { path: "bots", folderDefault: "team", entries: [entry("folder", "bots/grok-bot")], truncated: false, manifestUsable: true };
const GROK: FolderListing = { path: "bots/grok-bot", folderDefault: "team", entries: [entry("file", "bots/grok-bot/about.md")], truncated: false, manifestUsable: true };

beforeEach(() => forgetViews());
afterEach(unmountAll);

async function typeInto(input: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("The bots folder", () => {
  test("the Areas folder has only List and Chart, and its old bots folder is never drawn as an area", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: BODIES }), AREAS);
    await settle();
    expect(all("area-row-areas/bots")).toHaveLength(0);
    expect(all("folder-view-bots")).toHaveLength(0);
    expect(all("folder-view-talks")).toHaveLength(0);
    expect(all("folder-view-chart")).toHaveLength(1);
  });

  test("bots/ lists every bot, theirs first, wherever its card is; a press shows it, with mail that says it is mail", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: BODIES, files: [] }), BOTS);
    await settle();
    const view = strip(one("areas-bots-view").textContent);
    expect(view.indexOf("Grok Bot")).toBeLessThan(view.indexOf("Socials"));
    expect(view).toContain("20% of its week here");
    expect(view).toContain("@shyoh's · only @shyoh can change them");
    await press(one("areas-bot-Grok Bot"));
    await settle();
    expect(strip(one("bot-panel-whose").textContent)).toBe("Yours: only you change where it works and its caps");
    // No file path in the panel (Dev2, 2026-11-26: "no need to show the full path").
    expect(strip(one("bot-panel-mail-note").textContent)).toContain("Mail, not a chat.");
    expect(strip(one("bot-panel-mail-note").textContent)).not.toContain("mail/seyi.md");
    // Its activity is what it wrote in Context mail.
    expect(strip(one("bot-panel").textContent)).toContain("Thanks, scored it.");
    // Where it works, with its cap, which its person sets.
    await press(one("bot-panel-tab-works"));
    expect(all("bot-panel-area-areas/scorecard")).toHaveLength(1);
    expect(all("bot-panel-cap-Weekly cap for Scorecard")).toHaveLength(1);
  });

  test("someone else's bot shows its caps but has no field to change them, and its mail stays beside its old card", async () => {
    windowOf(1440);
    await mount(host([], { notes: NOTES, bodies: BODIES, files: [] }), BOTS);
    await settle();
    await press(one("areas-bot-Socials"));
    await settle();
    expect(strip(one("bot-panel-whose").textContent)).toBe("Only @shyoh changes where it works and its caps");
    expect(strip(one("bot-panel-mail-note").textContent)).not.toContain("socials/mail/seyi.md");
    await press(one("bot-panel-tab-works"));
    expect(all("bot-panel-cap-Weekly cap for Growth")).toHaveLength(0);
  });

  test("a bot's own folder is its page, and writing to it starts a mail note there", async () => {
    windowOf(1440);
    const files: string[] = [];
    await mount(host([], { notes: NOTES, bodies: BODIES, files }), GROK);
    await settle();
    expect(all("areas-bots-view")).toHaveLength(0);
    expect(strip(one("bot-panel-whose").textContent)).toBe("Yours: only you change where it works and its caps");
    await press(one("bot-panel-refresh"));
    await settle();
    expect(files.some((line) => line.startsWith("create bots/grok-bot/mail/seyi.md\n# Mail with Grok Bot"))).toBe(true);
    // Refresh sends Context's current setup too (Dev, 2026-11-26): the relay routine's one prompt and the bound login.
    expect(files.join("\n")).toContain("If your name or logo changed");
    expect(files.join("\n")).toContain("Never write to Context, reply, or send anything from this run.");
    expect(files.join("\n")).toMatch(/bind_bot: .?"Grok Bot/);
    // It stays on the bot's page, and says it sent.
    expect(all("bot-panel")).toHaveLength(1);
    expect(strip(one("bot-panel-refresh").textContent)).toBe("Sent");
  });

  test("a bot is added from the bots folder's page: whose it is and its name, with its card in its own folder", async () => {
    // The owner, 2026-11-26, on this page: "no way to add new bots on this page?"
    windowOf(1440);
    const writes: Write[] = [];
    await mount(host(writes, { notes: NOTES, bodies: BODIES, files: [] }), BOTS);
    await settle();
    await press(one("bots-add"));
    await settle();
    expect(all("area-panel-add-bot")).toHaveLength(1);
    await typeInto(one("area-panel-add-bot-name"), "Finance Bot");
    await press(one("area-panel-add-bot-save"));
    await settle();
    const at = (path: string, key: string) => writes.filter(([p, k]) => p === path && k === key).map(([, , value]) => value);
    expect(at("areas/about.md", "agents").at(-1)).toBe("Grok Bot, Socials, Finance Bot");
    expect(at("bots/finance-bot/about.md", "bot").at(-1)).toBe("grok");
    // The reader is offered first as whose it is.
    expect(at("bots/finance-bot/about.md", "belongs_to").at(-1)).toBe("@seyi");
    // It holds no area until an area's Owner menu gives it one.
    expect(writes.filter(([p, k]) => p.startsWith("areas/") && k === "owner")).toEqual([]);
    expect(writes.filter(([p, k]) => p === "bots/finance-bot/about.md" && /secret|token|key|password|url|webhook/i.test(k))).toEqual([]);
    expect(all("area-panel-add-bot")).toHaveLength(0);
  });

  test("a reader who may not write sees no way to add a bot", async () => {
    windowOf(1440);
    await mount(host(null, { notes: NOTES, bodies: BODIES }), BOTS);
    await settle();
    expect(all("bots-add")).toHaveLength(0);
  });

  test("each bot is drawn with its own logo, read through its card, wherever the card is", async () => {
    // The owner, 2026-11-26, on this page: "also realizing these arent the bot logos?"
    windowOf(1440);
    const withLogos = NOTES.map((note) =>
      note.path === "bots/grok-bot/about.md" || note.path === "areas/bots/socials/about.md" ? { ...note, properties: { ...note.properties, avatar: `upload-${note.path.split("/").at(-2)}.webp` } } : note,
    );
    const pictures: string[] = [];
    const page = host([], { notes: withLogos, bodies: BODIES, files: [] });
    const withReader = { ...page, source: { ...page.source, readPicture: async (card: string, leaf: string) => (pictures.push(`${card}|${leaf}`), "data:image/webp;base64,AA") } };
    await mount(withReader, BOTS);
    await settle();
    await settle();
    expect(pictures).toEqual(expect.arrayContaining(["bots/grok-bot/about.md|upload-grok-bot.webp", "areas/bots/socials/about.md|upload-socials.webp"]));
  });
});
