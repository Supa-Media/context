/**
 * @jest-environment jsdom
 */

/**
 * ONE CLICK SHOWS AN AREA IN THE SIDE PANEL; A DOUBLE CLICK OPENS IT.
 *
 * The owner, 2026-11-24, after trying the side-panel prototype: "one click
 * open up the right panel, double click to get into more details". On a page
 * with room, pressing an area row draws its details beside the list and opens
 * nothing; pressing it again at once opens the area's page. The panel's goal
 * and modes are edited in place and written to the area's own about.md. A
 * phone has no panel: a press opens the area as before.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The Areas page's Connect a source asks the url sources' syncs with the console grant; no gateway here.
// A bot's webhook reads the account server (`PanelBotHook.tsx`): nothing saved yet.
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

// "Upload logo" picks a picture on the device; here it is always the same few bytes.
jest.mock("../features/console/settings/panels/pickSquarePhoto", () => ({
  pickSquarePhoto: async () => ({ kind: "picked", bytes: new Uint8Array([1, 2, 3]).buffer, contentType: "image/png" }),
}));

import type { ListNote } from "../features/console/files/listBlock/model";
import type { FolderListing } from "../features/console/files/types";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { all, entry, host, mount, one, press, strip, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

const AREAS: ListNote[] = [
  { path: "areas/about.md", properties: {} },
  { path: "areas/finance/about.md", properties: { owner: "@seyi", modes: ["Manager"], metrics: ["Monthly cost, target under $600"] } },
  { path: "areas/finance/payroll/about.md", properties: { metrics: ["Payroll run on time"] } },
  { path: "areas/engineering/about.md", properties: { owner: "@sayo", modes: ["Doer"] } },
];

const LISTING: FolderListing = {
  path: "areas",
  folderDefault: "team",
  entries: [entry("folder", "areas/finance"), entry("folder", "areas/engineering")],
  truncated: false,
  manifestUsable: true,
};

beforeEach(() => {
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }
});
afterEach(unmountAll);

async function blur(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    node.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

async function typeInto(input: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Lets a menu placed from a measurement, and a people search, arrive. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the Areas side panel", () => {
  test("one press shows the area beside the list and opens nothing", async () => {
    windowOf(1440);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING);
    expect(all("area-panel")).toHaveLength(0);
    await press(one("area-row-areas/finance"));
    expect(selected).toEqual([]);
    expect(all("area-panel")).toHaveLength(1);
    expect(strip(one("area-panel").textContent)).toContain("Finance");
    // The metric is picked from the workspace's metrics (stage C); its goal is still a field, edited where it is drawn.
    expect(strip(one("area-panel-metric").textContent)).toBe("Monthly cost");
    expect(all("area-panel-pick")).toHaveLength(1);
    expect((one("area-panel-goal") as HTMLInputElement).value).toBe("under $600");
    expect(one("area-row-areas/finance").getAttribute("aria-selected")).toBe("true");
    // Another area replaces it; the panel's own sub-area row shows that one.
    await press(one("area-panel-sub-areas/finance/payroll"));
    expect(strip(one("area-panel").textContent)).toContain("Payroll");
    await press(one("area-panel-close"));
    expect(all("area-panel")).toHaveLength(0);
  });

  test("a second press on the same area opens it", async () => {
    windowOf(1440);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/engineering"));
    await press(one("area-row-areas/engineering"));
    expect(selected).toEqual(["areas/engineering"]);
  });

  test("Open area opens it", async () => {
    windowOf(1440);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    await press(one("area-panel-open"));
    expect(selected).toEqual(["areas/finance"]);
  });

  test("the goal and the modes are written to the area's about.md where they are drawn", async () => {
    windowOf(1440);
    const writes: Write[] = [];
    await mount(host(writes, { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    await typeInto(one("area-panel-goal"), "under $500");
    await blur(one("area-panel-goal"));
    const metric = writes.filter(([path, key]) => path === "areas/finance/about.md" && key === "metrics").map(([, , value]) => value);
    expect(metric).toEqual([["Monthly cost · target under $500"]]);
    await press(one("area-panel-mode-Doer"));
    const modes = writes.filter(([path, key]) => path === "areas/finance/about.md" && key === "modes").map(([, , value]) => value);
    expect(modes.at(-1)).toEqual(["Manager", "Doer"]);
  });

  test("owner, delegate, phone, email and the rules are all edited in the panel, with no pop-up", async () => {
    // The owner, 2026-11-24: "why cant I make changes inline? wth is the point of a side panel if its just going to link to this ugly pop up".
    windowOf(1440);
    const writes: Write[] = [];
    const notes = AREAS.map((note) => (note.path === "areas/about.md" ? { ...note, properties: { agents: ["Claude"] } } : note));
    await mount(host(writes, { notes }), LISTING);
    await press(one("area-row-areas/finance"));
    const panel = strip(one("area-panel").textContent);
    for (const word of ["Owner", "Delegate", "Modes", "Phone", "Email", "Needs approval"]) expect(panel).toContain(word);
    // Helper is gone (the owner, 2026-11-25): one delegate per area.
    expect(panel).not.toContain("Helper");
    expect(all("area-panel-helper")).toHaveLength(0);
    const card = (key: string) => writes.filter(([path, k]) => path === "areas/people/seyi.md" && k === key).map(([, , value]) => value);
    await typeInto(one("area-panel-phone"), "+1 555 0100");
    await blur(one("area-panel-phone"));
    expect(card("phone")).toEqual(["+1 555 0100"]);
    // The area's one delegate is a dropdown: Tex, one of the workspace's bots or agents, or nobody, never a person
    // (the owner, 2026-11-25: "1 delegate per area please"). It is written on the area, not the person's card.
    await press(one("area-panel-delegate"));
    await settle();
    expect(all("menu-item-@sayo")).toHaveLength(0);
    await press(one("menu-item-Claude"));
    const seat = (key: string) => writes.filter(([path, k]) => path === "areas/finance/about.md" && k === key).map(([, , value]) => value);
    expect(seat("delegate").at(-1)).toBe("Claude");
    expect(card("delegation").filter((value) => value !== null)).toEqual([]);
    // The owner drops the workspace's people.
    await press(one("area-panel-owner"));
    await settle();
    await press(one("menu-item-@sayo"));
    expect(seat("owner").at(-1)).toBe("@sayo");
    await press(one("area-panel-add-rule"));
    await typeInto(one("area-panel-rule-new"), "Spending over $20 needs approval.");
    await blur(one("area-panel-rule-new"));
    expect(seat("approvals").at(-1)).toEqual(["Spending over $20 needs approval."]);
    expect(all("seat-dialog")).toHaveLength(0);
  });

  test("a Grok bot is added as an owner where it is drawn: whose it is, its name, then its prompt", async () => {
    // The owner, 2026-11-25: "when you choose grokbot, it asks you like whose grokbot it is and the name of the grokbot".
    windowOf(1440);
    const writes: Write[] = [];
    const notes = AREAS.map((note) => (note.path === "areas/about.md" ? { ...note, properties: { agents: ["Claude"] } } : note));
    await mount(host(writes, { notes }), LISTING);
    await press(one("area-row-areas/finance"));
    await press(one("area-panel-owner"));
    await settle();
    await press(one("menu-item-__add_bot__"));
    expect(all("area-panel-add-bot")).toHaveLength(1);
    await press(one("area-panel-add-bot-whose"));
    await settle();
    await press(one("menu-item-@seyi"));
    await typeInto(one("area-panel-add-bot-name"), "Finance Bot");
    await press(one("area-panel-add-bot-save"));
    await settle();
    const at = (path: string, key: string) => writes.filter(([p, k]) => p === path && k === key).map(([, , value]) => value);
    expect(at("areas/about.md", "agents").at(-1)).toBe("Claude, Finance Bot");
    // A new bot's card goes in the bots folder beside the Areas folder, which no area can be mistaken for (the owner,
    // 2026-11-25: "top level bots yes"), so nothing is written to say it is not one.
    expect(writes.filter(([p]) => p === "areas/bots/about.md" || p === "bots/about.md")).toEqual([]);
    expect(at("bots/finance-bot/about.md", "bot").at(-1)).toBe("grok");
    expect(at("bots/finance-bot/about.md", "belongs_to").at(-1)).toBe("@seyi");
    expect(at("areas/finance/about.md", "owner").at(-1)).toBe("Finance Bot");
    // No login, key or address is ever written to the card.
    expect(writes.filter(([p, k]) => p === "bots/finance-bot/about.md" && /secret|token|key|password|url|webhook/i.test(k))).toEqual([]);
  });

  test("a bot holding an area shows its setup prompt, naming the area and its modes", async () => {
    windowOf(1440);
    const notes: ListNote[] = [
      ...AREAS.map((note) =>
        note.path === "areas/about.md"
          ? { ...note, properties: { agents: ["Claude", "Finance"] } }
          : note.path === "areas/finance/about.md"
            ? { ...note, properties: { owner: "Finance", modes: ["Manager"] } }
            : note,
      ),
      { path: "areas/people/finance.md", properties: { kind: "agent", bot: "grok", belongs_to: "@seyi" } },
    ];
    const writes: Write[] = [];
    await mount(host(writes, { notes }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(all("area-panel-prompt")).toHaveLength(1);
    // Reach: Context calls its webhook, written on the bot's card; the address itself is never on the card.
    await press(one("area-panel-reach-webhook"));
    expect(writes.filter(([p, k]) => p === "areas/people/finance.md" && k === "reach").map(([, , v]) => v)).toEqual(["webhook"]);
    // The bot sets its own webhook from its setup prompt; typing it here is behind a link.
    expect(all("area-panel-hook-address")).toHaveLength(0);
    await press(one("area-panel-hook-by-hand"));
    expect(all("area-panel-hook-address")).toHaveLength(1);
    const text = strip(one("area-panel-prompt-text").textContent);
    // Every setup prompt says how to connect Context first, and hands the secret over from the bot's shell.
    expect(text).toContain("https://mcp.context.lc/mcp");
    expect(text).toContain('header_from_shell: "Authorization"');
    expect(text).toContain("You are Finance, @seyi's Grok bot.");
    expect(text).toContain('area: "areas/finance"');
    expect(text).toContain("Manager:");
    // The owner menu lists it with whose bot it is.
    await press(one("area-panel-owner"));
    await settle();
    expect(strip(one("menu-item-Finance").textContent)).toContain("@seyi's Grok bot");
  });

  test("a bot is drawn with the logo its card names, and one without a logo gets Upload logo and is told to add its own", async () => {
    // The owner, 2026-11-25: "match the logos from the actual grok bot ... part of the setup somehow, maybe from first response".
    windowOf(1440);
    const notes: ListNote[] = [
      ...AREAS.map((note) =>
        note.path === "areas/about.md"
          ? { ...note, properties: { agents: ["Pipeline", "Finance"] } }
          : note.path === "areas/finance/about.md"
            ? { ...note, properties: { owner: "Finance" } }
            : note.path === "areas/engineering/about.md"
              ? { ...note, properties: { owner: "Pipeline" } }
              : note,
      ),
      { path: "areas/people/pipeline.md", properties: { kind: "agent", bot: "grok", belongs_to: "@seyi", avatar: "upload-0123456789abcdef.png" } },
      { path: "areas/people/finance.md", properties: { kind: "agent", bot: "grok", belongs_to: "@seyi" } },
    ];
    const writes: Write[] = [];
    const reads: string[] = [];
    const stored: string[] = [];
    const base = host(writes, { notes });
    const withPictures = {
      ...base,
      source: {
        ...base.source,
        readPicture: async (note: string, leaf: string) => {
          reads.push(`${note} ${leaf}`);
          return "data:image/png;base64,AAAA";
        },
        storePicture: async (picture: { bytes: ArrayBuffer; contentType: string }) => {
          stored.push(picture.contentType);
          return { leaf: "upload-fedcba9876543210.png" };
        },
      },
    };
    await mount(withPictures, LISTING);
    await settle();
    // The list draws Pipeline's logo, read through its card; Finance keeps the robot.
    expect(reads).toContain("areas/people/pipeline.md upload-0123456789abcdef.png");
    expect(all("owner-face-logo").length).toBeGreaterThan(0);
    await press(one("area-row-areas/finance"));
    await settle();
    expect(strip(one("area-panel-prompt-text").textContent)).toContain('path: "areas/people/finance.md"');
    await press(one("area-panel-upload-logo"));
    await settle();
    expect(stored).toEqual(["image/png"]);
    expect(writes.filter(([p, k]) => p === "areas/people/finance.md" && k === "avatar").map(([, , v]) => v)).toEqual(["upload-fedcba9876543210.png"]);
  });

  test("an area's own page draws its bot's logo too, though the cards sit beside the areas", async () => {
    // The owner, 2026-11-25: "the images arent loading when you get out of the first layer?" A folder page reads
    // only its own folder (and the front notes above), and the cards are in areas/people/.
    windowOf(1440);
    const notes: ListNote[] = [
      { path: "areas/about.md", properties: { agents: ["Pipeline"] } },
      { path: "areas/engineering/about.md", properties: { owner: "Pipeline" } },
      { path: "areas/engineering/ci/about.md", properties: { metrics: ["Red main hours"] } },
      { path: "areas/people/pipeline.md", properties: { kind: "agent", bot: "grok", belongs_to: "@seyi", avatar: "upload-00112233445566aa.png" } },
    ];
    const reads: string[] = [];
    const base = host([], { notes });
    const under = (folder: string, deep: boolean) =>
      notes.filter((note) => note.path.startsWith(`${folder}/`) && (deep || !note.path.slice(folder.length + 1).includes("/")));
    const page = {
      ...base,
      source: {
        ...base.source,
        load: async (folder: string, deep: boolean) => ({ notes: under(folder, deep), complete: true }),
        loadFront: undefined,
        readPicture: async (note: string, leaf: string) => {
          reads.push(`${note} ${leaf}`);
          return "data:image/png;base64,AAAA";
        },
      },
    };
    await mount(page, { ...LISTING, path: "areas/engineering", entries: [entry("folder", "areas/engineering/ci")] });
    await settle();
    expect(reads).toContain("areas/people/pipeline.md upload-00112233445566aa.png");
    expect(all("owner-face-logo").length).toBeGreaterThan(0);
  });

  test("a bot that owns several areas gets one setup prompt covering them all", async () => {
    // The owner, 2026-11-25: "a grokbot can own multiple areas".
    windowOf(1440);
    const notes: ListNote[] = [
      ...AREAS.map((note) =>
        note.path === "areas/about.md"
          ? { ...note, properties: { agents: ["Pipeline"] } }
          : note.path === "areas/finance/about.md" || note.path === "areas/engineering/about.md"
            ? { ...note, properties: { ...note.properties, owner: "Pipeline" } }
            : note,
      ),
      { path: "areas/people/pipeline.md", properties: { kind: "agent", bot: "grok", belongs_to: "@seyi", reach: "mail" } },
    ];
    await mount(host([], { notes }), LISTING);
    await press(one("area-row-areas/finance"));
    const text = strip(one("area-panel-prompt-text").textContent);
    expect(text).toContain("(areas/finance)");
    expect(text).toContain("(areas/engineering)");
    expect(text).toContain('for: "Pipeline"');
    // A bot that checks its own mail has no webhook step.
    expect(text).not.toContain("header_from_shell");
  });

  test("an area's delegate bot gets its setup prompt, acting for the area's owner there", async () => {
    windowOf(1440);
    const notes: ListNote[] = [
      ...AREAS.map((note) =>
        note.path === "areas/about.md"
          ? { ...note, properties: { agents: ["Chief"] } }
          : note.path === "areas/finance/about.md"
            ? { ...note, properties: { ...note.properties, delegate: "Chief" } }
            : note,
      ),
      { path: "areas/people/chief.md", properties: { kind: "agent", bot: "grok", belongs_to: "@seyi" } },
    ];
    await mount(host([], { notes }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(strip(one("area-panel-delegate").textContent)).toContain("Chief");
    expect(strip(one("area-panel").textContent)).toContain("Acts for @seyi here");
    const text = strip(one("area-panel-delegate-prompt-text").textContent);
    expect(text).toContain("Set yourself up as Chief");
    expect(text).toContain("You act for @seyi in the area");
  });

  test("an area's mail is a folder with one note per sender: listed in the panel, and a first message starts your own", async () => {
    // The owner, 2026-11-25: "mail is a folder and then per person it's one note, or per, not just per person, per AI".
    windowOf(1440);
    const writes: Write[] = [];
    const files: string[] = [];
    const notes: ListNote[] = [...AREAS, { path: "areas/finance/mail/pipeline.md", properties: {} }];
    const bodies = { "areas/finance/mail/pipeline.md": "# Mail with Finance\n\n```mail\n- 2026-11-25T03:00:00.000Z pipeline (Grok) to everyone: CI is red again.\n```\n" };
    const { selected } = await mount(host(writes, { notes, files, bodies }), LISTING);
    await press(one("area-row-areas/finance"));
    await settle();
    // The mail folder is the Mail section, never a plain folder in the area's notes.
    expect(all("area-panel-note-areas/finance/mail")).toHaveLength(0);
    expect(strip(one("area-panel-mail-pipeline").textContent)).toContain("pipeline: CI is red again.");
    await typeInto(one("area-panel-mail-input"), "Why did spend jump on Friday?");
    await press(one("area-panel-mail-send"));
    await settle();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^create areas\/finance\/mail\/seyi\.md\n# Mail with @seyi\n\n```mail\n- \S+ @seyi to everyone: Why did spend jump on Friday\?\n```\n$/);
    expect(all("area-panel-mail-input")).toHaveLength(0);
    await press(one("area-panel-mail-pipeline"));
    expect(selected).toEqual(["areas/finance/mail/pipeline.md"]);
  });

  test("in a console the area goes in the right panel, where Meetings is, not in the page", async () => {
    windowOf(1440);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING, undefined, undefined, true);
    expect(all("aside-area")).toHaveLength(0);
    await press(one("area-row-areas/finance"));
    expect(selected).toEqual([]);
    // The owner, 2026-11-24: "just put it in the left panel like this", of the right panel.
    expect(all("aside-area")).toHaveLength(1);
    expect(one("aside-area").querySelector('[data-testid="area-panel"]')).not.toBeNull();
    expect(all("task-panel-peek")).toHaveLength(0);
    await press(one("area-panel-close"));
    expect(all("aside-area")).toHaveLength(0);
  });

  test("the top row shows in the panel too, named for the workspace, and a second press does not leave the page", async () => {
    windowOf(1440);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING);
    // The owner, 2026-11-24: "it doesnt open up for the top level?"
    await press(one("area-row-root"));
    await press(one("area-row-root"));
    expect(selected).toEqual([]);
    expect(all("area-panel")).toHaveLength(1);
    expect(strip(one("area-panel").textContent)).toContain("Seyi");
    expect(all("area-panel-open")).toHaveLength(0);
  });

  test("a phone has no panel: a press opens the area", async () => {
    windowOf(390);
    const { selected } = await mount(host([], { notes: AREAS }), LISTING);
    await press(one("area-row-areas/finance"));
    expect(all("area-panel")).toHaveLength(0);
    expect(selected).toEqual(["areas/finance"]);
  });
});
