/**
 * @jest-environment jsdom
 */

/**
 * THE AREAS LIST DRAWS THE OPEN FOLDER AS ITS ROOT AND NESTS EVERYTHING UNDER IT.
 *
 * The prototype, 2026-11-23: a top row for the open folder, then sub-areas at
 * depth 1, their files and sub-areas deeper, guide lines down the left, an
 * owner, a value and a status dot on every area row, a CSV or Page tag and a
 * note count on file rows, and at most three files per area before "Show N
 * more". The properties with teeth: the root row carries the workspace's name,
 * a sub-area indents deeper than its parent, a CSV shows its tag, a folder
 * shows its note count, an unowned area says "No owner" and draws the ring, and
 * an area with five files shows three until it is opened.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createRoot, type Root } from "react-dom/client";
import type { ListNote } from "../features/console/files/listBlock/model";
import { AreasList, type AreasListProps } from "../features/console/files/folderPage/areas/AreasList";
import { areaTree } from "../features/console/files/folderPage/areas/seat";
import { all, one, press, strip, unmountAll } from "./projectPage/fixtures";

const ROOT = "areas";

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

/** The fixture plus what the list tests need: a CSV, a page, a plain folder of two notes, and five files in design. */
const NOTES: ListNote[] = [
  ...AREAS,
  { path: "areas/finance/ledger.csv", properties: {} },
  { path: "areas/finance/home.page.md", properties: {} },
  { path: "areas/finance/receipts/jan.md", properties: {} },
  { path: "areas/finance/receipts/feb.md", properties: {} },
  { path: "areas/design/one.md", properties: {} },
  { path: "areas/design/two.md", properties: {} },
  { path: "areas/design/three.md", properties: {} },
  { path: "areas/design/four.md", properties: {} },
];

const notesUnder = (folder: string) => NOTES.filter((note) => note.path.startsWith(`${folder}/`)).length;

let mounted: Root | null = null;
let container: HTMLElement | null = null;

async function render(overrides: Partial<AreasListProps> = {}, notes: ListNote[] = NOTES) {
  const props: AreasListProps = {
    tree: areaTree(ROOT, ROOT, notes),
    compact: false,
    faceOf: () => ({ kind: "initials", text: "S" }) as never,
    label: (owner) => owner,
    reach: () => "",
    rootTitle: "Supa",
    notesUnder,
    readingOf: () => undefined,
    onOpen: () => {},
    onMenu: () => {},
    ...overrides,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  mounted = createRoot(container);
  await act(async () => {
    mounted!.render(createElement(AreasList, props));
  });
  await act(async () => {});
}

beforeEach(() => {
  mounted = null;
  container = null;
});

afterEach(() => {
  if (mounted !== null) {
    act(() => mounted!.unmount());
    mounted = null;
  }
  container?.remove();
  unmountAll();
});

const depthOf = (node: HTMLElement) => Number(node.getAttribute("data-depth"));

describe("the Areas List", () => {
  test("the top row is the open folder, drawn with the workspace's name", async () => {
    await render();
    const top = one("area-row-root");
    expect(strip(top.textContent)).toContain("Supa");
    expect(depthOf(top)).toBe(0);
    expect(all("area-row-areas")).toHaveLength(0);
  });

  test("the top row's ⋯ opens the seat menu for the open folder, not navigation", async () => {
    const menus: string[] = [];
    const opened: string[] = [];
    await render({ onMenu: (seat) => menus.push(seat.folder), onOpen: (path) => opened.push(path) });
    await press(one("area-more-areas"));
    expect(menus).toEqual([ROOT]);
    await press(one("area-row-root"));
    expect(menus).toEqual([ROOT, ROOT]);
    expect(opened).toEqual([]);
  });

  test("a sub-area sits one level deeper than the top row, and a sub-area of it deeper still", async () => {
    await render();
    const finance = one("area-row-areas/finance");
    const payroll = one("area-row-areas/finance/payroll");
    expect(depthOf(finance)).toBe(1);
    expect(depthOf(payroll)).toBe(2);
    expect(depthOf(payroll)).toBeGreaterThan(depthOf(finance));
    expect(parseInt(payroll.style.paddingLeft, 10)).toBeGreaterThan(parseInt(finance.style.paddingLeft, 10));
  });

  test("guide lines draw one per level down the left of each nested row", async () => {
    await render();
    expect(all("area-guide").length).toBeGreaterThan(0);
    const payroll = one("area-row-areas/finance/payroll");
    expect(all("area-guide", payroll)).toHaveLength(2);
    expect(all("area-guide", one("area-row-root"))).toHaveLength(0);
  });

  test("a CSV shows the CSV tag and a page shows the Page tag", async () => {
    await render();
    expect(strip(one("area-file-areas/finance/ledger.csv").textContent)).toContain("CSV");
    expect(strip(one("area-file-areas/finance/home.page.md").textContent)).toContain("Page");
  });

  test("a plain folder shows how many notes it holds", async () => {
    await render();
    // Finance holds four files, so the folder sits past the first three until "Show 1 more" opens it.
    await press(one("area-more-files-areas/finance"));
    expect(strip(one("area-file-areas/finance/receipts").textContent)).toContain("2 notes");
  });

  test("an unowned area says No owner and draws the ring dot; a warm one draws the warn dot", async () => {
    await render();
    const design = one("area-row-areas/design");
    expect(strip(design.textContent)).toContain("No owner");
    expect(all("area-dot-ring", design)).toHaveLength(1);
    const engineering = one("area-row-areas/engineering");
    expect(all("area-dot-warn", engineering)).toHaveLength(1);
    expect(all("area-gap-dot", engineering)).toHaveLength(1);
    expect(all("area-dot-neutral", one("area-row-areas/finance"))).toHaveLength(1);
  });

  test("an area with five files shows three and a Show 2 more row, which shows all five", async () => {
    await render();
    const design = "areas/design";
    const files = () => NOTES.filter((note) => note.path.startsWith(`${design}/`) && note.path.split("/").length === 3);
    expect(files()).toHaveLength(5);
    const shown = () => all("area-file-areas/design/brand.md").concat(all("area-file-areas/design/one.md"), all("area-file-areas/design/two.md"), all("area-file-areas/design/three.md"), all("area-file-areas/design/four.md"));
    expect(shown().length).toBe(3);
    const more = one("area-more-files-areas/design");
    expect(strip(more.textContent)).toContain("Show 2 more");
    await press(more);
    expect(shown().length).toBe(5);
    expect(strip(one("area-more-files-areas/design").textContent)).toContain("Show fewer");
  });

  test("the file cap never hides a sub-area", async () => {
    const notes: ListNote[] = [
      { path: "areas/ops/about.md", properties: {} },
      { path: "areas/ops/a/about.md", properties: { owner: "@sayo" } },
      { path: "areas/ops/b.md", properties: {} },
      { path: "areas/ops/c.md", properties: {} },
      { path: "areas/ops/d.md", properties: {} },
      { path: "areas/ops/e.md", properties: {} },
    ];
    await render({ tree: areaTree(ROOT, ROOT, notes) }, notes);
    expect(all("area-row-areas/ops/a")).toHaveLength(1);
  });

  test("the top row's chevron folds everything under it", async () => {
    await render();
    await press(one("area-toggle-areas"));
    expect(all("area-row-areas/finance")).toHaveLength(0);
    expect(all("area-file-areas/design/brand.md")).toHaveLength(0);
  });
});
