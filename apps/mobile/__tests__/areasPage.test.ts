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

  test("Chart is an org chart: the workspace on top, lines down to each area, sub-areas under their parent", async () => {
    await mount(host([], { notes: AREAS }), LISTING);
    await press(view("chart"));
    const top = one("area-box-areas");
    expect(strip(top.textContent)).toContain("3 areas");
    expect(strip(top.textContent)).toContain("need a look");
    expect(all("area-line").length).toBeGreaterThan(2);
    // Payroll is drawn inside Finance's column, under its box.
    expect(all("area-box-areas/finance/payroll")).toHaveLength(1);
    // Files are counted by kind, the seat's about.md is not one of them.
    expect(strip(one("area-box-areas/engineering").textContent)).toContain("1 note");
  });

  test("an empty seat is a dashed box that offers Assign owner, which opens the seat", async () => {
    await mount(host([], { notes: AREAS }), LISTING);
    await press(view("chart"));
    expect(strip(one("area-box-areas/design").textContent)).toContain("No owner");
    await press(one("area-assign-areas/design"));
    expect(all("seat-dialog")).toHaveLength(1);
  });

  // The owner, 2026-11-23: "in prod this menu doesn't even pop up". A
  // right-click on a row or a box opens that seat's menu, not the page's
  // New note menu behind it: react-native-web forwards no onContextMenu, so
  // the listener goes on the DOM node through useRightClick.
  test.each(["list", "chart"] as const)("a right-click on an area in %s opens its seat menu, not the page's", async (mode) => {
    await mount(host([], { notes: AREAS }), LISTING);
    if (mode === "chart") await press(view("chart"));
    const target = one(mode === "chart" ? "area-box-areas/finance" : "area-row-areas/finance");
    const holder = mode === "chart" ? target : (target.parentElement as HTMLElement);
    await act(async () => {
      holder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
    });
    const items = all("menu-root").flatMap((menu) => Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')).map((node) => strip(node.textContent).trim()));
    expect(items).toContain("Edit seat…");
    expect(items).not.toContain("New note");
  });

  // The owner, 2026-11-23: "why does it flicker from the old ui to the new ui". Until
  // the notes arrive the Areas folder waits, empty, under its List · Chart switch: it
  // never draws the plain listing first.
  test("while its notes load, the Areas folder waits under its switch instead of drawing the plain listing", async () => {
    const page = host([], { notes: AREAS });
    const never = { ...page, source: { ...page.source, load: () => new Promise<never>(() => {}) } };
    await mount(never, LISTING);
    expect(all("areas-waiting")).toHaveLength(1);
    expect(all("folder-view-chart")).toHaveLength(1);
    expect(all("areas-view")).toHaveLength(0);
    expect(document.body.textContent ?? "").not.toContain("engineering");
    // Notes that never come do not leave a blank page: the plain listing takes over.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    expect(all("areas-waiting")).toHaveLength(0);
    expect(document.body.textContent ?? "").toContain("engineering");
  });

  // The owner, 2026-11-23, holding the prototype's menu beside the shipped one: the seat
  // menu opens with the area and its holder, how to reach them, and an icon on every action.
  test("the seat menu opens with the area, who holds it and how to reach them, then the prototype's actions", async () => {
    await mount(host([], { notes: AREAS }), LISTING);
    await press(document.querySelector<HTMLElement>('[aria-label="Options for engineering"]')!);
    const menu = one("menu-root");
    expect(strip(one("seat-menu-head", menu).textContent)).toContain("Engineering");
    expect(strip(one("seat-menu-holder", menu).textContent)).toContain("Doer");
    const reach = all("seat-menu-reach", menu).map((block) => strip(block.textContent));
    expect(reach.join(" ")).toContain("+1 555 010 0177");
    expect(reach.join(" ")).toContain("Helper");
    const labels = Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')).map((node) => strip(node.textContent).trim());
    expect(labels).toEqual(expect.arrayContaining(["Edit seat…", "Add a sub-area…", "Change owner…", "Add a metric…", "Open about.md"]));
    expect(labels.some((label) => label.startsWith("Edit how to reach"))).toBe(true);
  });

  // The prototype's labels: "Open chart" only where the seat has sub-areas to chart.
  test.each<[string, boolean]>([
    ["finance", true],
    ["engineering", false],
  ])("the %s seat menu offers Open chart: %s", async (name, offered) => {
    await mount(host([], { notes: AREAS }), LISTING);
    await press(document.querySelector<HTMLElement>(`[aria-label="Options for ${name}"]`)!);
    const labels = Array.from(one("menu-root").querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')).map((node) => strip(node.textContent).trim());
    expect(labels.includes("Open chart")).toBe(offered);
    expect(labels).not.toContain("Open");
  });

  test("Add a metric… opens the seat with an empty metric row ready", async () => {
    await mount(host([], { notes: AREAS }), LISTING);
    await press(document.querySelector<HTMLElement>('[aria-label="Options for engineering"]')!);
    await press(one("menu-item-metric"));
    expect(all("seat-dialog")).toHaveLength(1);
    const names = Array.from(document.querySelectorAll<HTMLInputElement>('[aria-label="Metric name"]'));
    expect(names.length).toBeGreaterThan(0);
    expect(names[names.length - 1]!.value).toBe("");
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
