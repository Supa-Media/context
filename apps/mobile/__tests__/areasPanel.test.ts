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

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    // The metric's name and goal are fields, edited where they are drawn.
    expect((one("area-panel-metric") as HTMLInputElement).value).toBe("Monthly cost");
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

  test("owner, helper, phone, email, Tex and the rules are all edited in the panel, with no pop-up", async () => {
    // The owner, 2026-11-24: "why cant I make changes inline? wth is the point of a side panel if its just going to link to this ugly pop up".
    windowOf(1440);
    const writes: Write[] = [];
    const notes = AREAS.map((note) => (note.path === "areas/about.md" ? { ...note, properties: { agents: ["Claude"] } } : note));
    await mount(host(writes, { notes }), LISTING);
    await press(one("area-row-areas/finance"));
    const panel = strip(one("area-panel").textContent);
    for (const word of ["Owner", "Helper", "Modes", "Phone", "Email", "Tex", "Answers for", "Needs approval"]) expect(panel).toContain(word);
    const card = (key: string) => writes.filter(([path, k]) => path === "areas/people/seyi.md" && k === key).map(([, , value]) => value);
    await typeInto(one("area-panel-phone"), "+1 555 0100");
    await blur(one("area-panel-phone"));
    expect(card("phone")).toEqual(["+1 555 0100"]);
    await press(one("area-panel-tex"));
    expect(card("delegation").at(-1)).toBe("Tex");
    // The helper drops a menu of the workspace's agents, and a choice is written at once.
    await press(one("area-panel-helper"));
    await settle();
    await press(one("menu-item-Claude"));
    const seat = (key: string) => writes.filter(([path, k]) => path === "areas/finance/about.md" && k === key).map(([, , value]) => value);
    expect(seat("helper").at(-1)).toBe("Claude");
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
