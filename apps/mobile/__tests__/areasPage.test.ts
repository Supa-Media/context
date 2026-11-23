/**
 * @jest-environment jsdom
 */

/**
 * THE AREAS FOLDER IS A LIST AND A CHART OF WHO HOLDS WHAT.
 *
 * The owner, 2026-11-23, after several prototype rounds: the Areas folder's
 * page offers List (the default, as for projects) and Chart; each row or box
 * is a seat, a right-click or ⋯ opens its menu, and Edit seat writes the
 * area's `about.md` and the holder's how-to-reach card in `people/`, which
 * everyone in the workspace sees. See
 * `docs/decisions/app-and-console/areas-as-seats.md`.
 *
 * The properties with teeth: the switch is List · Chart, never Board; a
 * folder outside the Areas folder shows no such switch; the cards' folder is
 * never drawn as an area; a seat saved writes its lines to its own about.md
 * and the card to people/, and a member is offered no Save.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { ListNote } from "../features/console/files/listBlock/model";
import type { FolderListing } from "../features/console/files/types";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { all, entry, host, mount, one, press, strip, type, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

const AREAS: ListNote[] = [
  { path: "areas/about.md", properties: {} },
  { path: "areas/finance/about.md", properties: { owner: "@seyi", modes: ["Visionary", "Manager"], metrics: ["Monthly cost, target under $600"] } },
  { path: "areas/finance/budget.md", properties: {} },
  { path: "areas/finance/payroll/about.md", properties: { metrics: ["Payroll run on time"] } },
  { path: "areas/engineering/about.md", properties: { owner: "@sayo", helper: "Claude", modes: ["Doer"] } },
  { path: "areas/engineering/on-call.md", properties: {} },
  { path: "areas/design/brand.md", properties: {} },
  { path: "areas/people/about.md", properties: { area: "false" } },
  { path: "areas/people/sayo.md", properties: { holder: "@sayo", kind: "person", phone: "+1 555 010 0177", email: "sayo@example.com", delegation: "Tex" } },
];

const LISTING: FolderListing = {
  path: "areas",
  folderDefault: "team",
  entries: [entry("folder", "areas/finance"), entry("folder", "areas/engineering"), entry("folder", "areas/design"), entry("folder", "areas/people")],
  truncated: false,
  manifestUsable: true,
};

beforeEach(() => {
  windowOf(1280);
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }
});
afterEach(unmountAll);

const view = (name: string) => one(`folder-view-${name}`);

describe("the Areas folder", () => {
  test("opens in List under a List · Chart switch, with every area and no people card as an area", async () => {
    await mount(host([], { notes: AREAS }), LISTING);
    expect(all("folder-view-switch")).toHaveLength(1);
    expect(all("folder-view-board")).toHaveLength(0);
    expect(view("list").getAttribute("aria-selected")).toBe("true");
    expect(all("areas-list")).toHaveLength(1);
    const rows = all("area-row-areas/finance").concat(all("area-row-areas/engineering"), all("area-row-areas/design"));
    expect(rows).toHaveLength(3);
    expect(all("area-row-areas/people")).toHaveLength(0);
    // A sub-area that declares a seat is an area; a note is a file row.
    expect(all("area-row-areas/finance/payroll")).toHaveLength(1);
    expect(all("area-file-areas/finance/budget.md")).toHaveLength(1);
  });

  test("Chart draws the open folder's areas as boxes", async () => {
    await mount(host([], { notes: AREAS }), LISTING);
    await press(view("chart"));
    expect(all("areas-chart")).toHaveLength(1);
    expect(all("area-box-areas/finance")).toHaveLength(1);
    expect(all("area-box-areas/people")).toHaveLength(0);
    expect(strip(one("area-box-areas/engineering").textContent)).toContain("No manager loop");
  });

  test("Edit seat writes the seat to the area's about.md and the card to people/", async () => {
    const writes: Write[] = [];
    await mount(host(writes, { notes: AREAS }), LISTING);
    const options = document.querySelector<HTMLElement>('[aria-label="Options for engineering"]');
    expect(options).not.toBeNull();
    await press(options!);
    const edit = all("menu-root")
      .flatMap((menu) => Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')))
      .find((node) => strip(node.textContent).trim() === "Edit seat…");
    expect(edit).toBeDefined();
    await press(edit!);
    expect(all("seat-dialog")).toHaveLength(1);
    await type(one("seat-phone"), "+1 555 010 0199");
    await press(one("seat-save"));
    await act(async () => {});
    const seatLines = writes.filter(([path]) => path === "areas/engineering/about.md").map(([, key, value]) => [key, value]);
    expect(seatLines).toContainEqual(["owner", "@sayo"]);
    expect(seatLines).toContainEqual(["modes", ["Doer"]]);
    const card = writes.filter(([path]) => path === "areas/people/sayo.md").map(([, key, value]) => [key, value]);
    expect(card).toContainEqual(["phone", "+1 555 010 0199"]);
    expect(card).toContainEqual(["delegation", "Tex"]);
    // Credentials never land in a card.
    expect(card.map(([key]) => key).some((key) => /password|secret|token|login/i.test(String(key)))).toBe(false);
  });

  test("saving a seat without touching a card writes no card", async () => {
    const writes: Write[] = [];
    await mount(host(writes, { notes: AREAS }), LISTING);
    await press(document.querySelector<HTMLElement>('[aria-label="Options for finance"]')!);
    const edit = all("menu-root")
      .flatMap((menu) => Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')))
      .find((node) => strip(node.textContent).trim() === "Edit seat…");
    await press(edit!);
    await press(one("seat-save"));
    await act(async () => {});
    expect(writes.some(([path]) => path === "areas/finance/about.md")).toBe(true);
    expect(writes.some(([path]) => path.startsWith("areas/people/"))).toBe(false);
  });

  test("a member sees the seat but is offered no Save", async () => {
    await mount(host(null, { notes: AREAS }), LISTING);
    await press(document.querySelector<HTMLElement>('[aria-label="Options for finance"]')!);
    const edit = all("menu-root")
      .flatMap((menu) => Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')))
      .find((node) => strip(node.textContent).trim() === "View seat…");
    expect(edit).toBeDefined();
    await press(edit!);
    expect(all("seat-dialog")).toHaveLength(1);
    expect(all("seat-save")).toHaveLength(0);
  });

  test("a folder outside the Areas folder has no List · Chart switch", async () => {
    await mount(host([], { notes: [{ path: "resources/a.md", properties: {} }] }), {
      path: "resources",
      folderDefault: "team",
      entries: [entry("file", "resources/a.md")],
      truncated: false,
      manifestUsable: true,
    });
    expect(all("folder-view-chart")).toHaveLength(0);
    expect(all("areas-view")).toHaveLength(0);
  });
});
