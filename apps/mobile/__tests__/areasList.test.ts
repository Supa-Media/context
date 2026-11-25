/**
 * @jest-environment jsdom
 */

/**
 * THE AREAS LIST DRAWS THE OPEN FOLDER AS ITS ROOT AND NESTS EVERYTHING UNDER IT.
 *
 * The owner's board, 2026-11-24 ("E Trend"): a top row for the open folder,
 * sub-areas nested under it, and on every area row its owner's face, its one
 * headline metric as a trend with the latest value and the target, a count of
 * its notes and folders that shows them, and ⋯. Notes and folders are hidden
 * until that count is pressed. The properties with teeth: the root row carries
 * the workspace's name, a sub-area indents deeper than its parent, files stay
 * hidden until asked for and then show a CSV or Page tag and a folder's note
 * count, a value is drawn against its target with the state in words to a
 * screen reader, and an unowned area draws the empty face.
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
  { path: "areas/engineering/about.md", properties: { owner: "@sayo", delegate: "Claude", modes: ["Doer"] } },
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
    faceOf: (owner) => (owner === null ? { kind: "nobody" } : ({ kind: "person", name: owner } as never)),
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

  test("the top row opens the seat menu for the open folder, not navigation, and draws no ⋯", async () => {
    const menus: string[] = [];
    const opened: string[] = [];
    await render({ onMenu: (seat) => menus.push(seat.folder), onOpen: (path) => opened.push(path) });
    // The prototype's top row has no ⋯ (the owner, 2026-11-24); its own press is the menu.
    expect(all("area-more-areas")).toHaveLength(0);
    await press(one("area-row-root"));
    expect(menus).toEqual([ROOT]);
    expect(opened).toEqual([]);
    // A sub-area's ⋯ still opens its menu.
    await press(one("area-more-areas/finance"));
    expect(menus).toEqual([ROOT, "areas/finance"]);
  });

  test("a sub-area sits one level deeper than the top row, and a sub-area of it deeper still", async () => {
    await render();
    await press(one("area-toggle-areas/finance"));
    const finance = one("area-row-areas/finance");
    const payroll = one("area-row-areas/finance/payroll");
    expect(depthOf(finance)).toBe(1);
    expect(depthOf(payroll)).toBe(2);
    expect(depthOf(payroll)).toBeGreaterThan(depthOf(finance));
    expect(parseInt(payroll.style.paddingLeft, 10)).toBeGreaterThan(parseInt(finance.style.paddingLeft, 10));
  });

  test("notes and folders are hidden until the area's count is pressed, which shows them all", async () => {
    await render();
    const design = "areas/design";
    const shown = () =>
      all("area-file-areas/design/brand.md").concat(
        all("area-file-areas/design/one.md"),
        all("area-file-areas/design/two.md"),
        all("area-file-areas/design/three.md"),
        all("area-file-areas/design/four.md"),
      );
    expect(shown()).toHaveLength(0);
    const count = one(`area-notes-${design}`);
    expect(strip(count.textContent)).toContain("5");
    expect(count.getAttribute("aria-expanded")).toBe("false");
    await press(count);
    expect(shown()).toHaveLength(5);
    expect(one(`area-notes-${design}`).getAttribute("aria-expanded")).toBe("true");
    await press(one(`area-notes-${design}`));
    expect(shown()).toHaveLength(0);
  });

  test("an area with no notes or folders has no count", async () => {
    await render();
    await press(one("area-toggle-areas/finance"));
    expect(all("area-row-areas/finance/payroll")).toHaveLength(1);
    expect(all("area-notes-areas/finance/payroll")).toHaveLength(0);
  });

  test("a CSV shows the CSV tag and a page shows the Page tag", async () => {
    await render();
    await press(one("area-notes-areas/finance"));
    expect(strip(one("area-file-areas/finance/ledger.csv").textContent)).toContain("CSV");
    expect(strip(one("area-file-areas/finance/home.page.md").textContent)).toContain("Page");
  });

  test("a plain folder shows how many notes it holds", async () => {
    await render();
    await press(one("area-notes-areas/finance"));
    expect(strip(one("area-file-areas/finance/receipts").textContent)).toContain("2 notes");
  });

  test("a value is drawn against its target, with a trend from its readings", async () => {
    // Finance's Monthly cost is $640 against "under $600".
    await render({ readingOf: (seat) => (seat.folder === "areas/finance" ? { value: "$640", date: "2026-11-23", series: [480, 560, 640] } : undefined) });
    const finance = one("area-row-areas/finance");
    expect(strip(finance.textContent)).toContain("Monthly cost");
    expect(strip(finance.textContent)).toContain("$640");
    expect(strip(finance.textContent)).toContain("< $600");
    expect(all("area-trend", finance)).toHaveLength(1);
    expect(all("area-trend-target", finance)).toHaveLength(1);
  });

  test("a metric with no reading yet shows its name and target, with no placeholder", async () => {
    await render();
    const finance = strip(one("area-row-areas/finance").textContent);
    expect(finance).toContain("Monthly cost");
    expect(finance).toContain("target < $600");
    expect(finance).not.toContain("No data");
    expect(all("area-trend", one("area-row-areas/finance"))).toHaveLength(0);
  });

  test("an unowned area draws the empty face and says No owner to a screen reader", async () => {
    await render();
    const design = one("area-row-areas/design");
    expect(all("owner-face-nobody", design)).toHaveLength(1);
    expect(design.querySelector('[aria-label="No owner"]')).not.toBeNull();
  });

  test("on open only the top level is unfolded: areas show, their sub-areas wait for the chevron", async () => {
    await render();
    expect(all("area-row-areas/finance")).toHaveLength(1);
    expect(one("area-toggle-areas").getAttribute("aria-expanded")).toBe("true");
    expect(one("area-toggle-areas/finance").getAttribute("aria-expanded")).toBe("false");
    expect(all("area-row-areas/finance/payroll")).toHaveLength(0);
  });

  test("a chevron shows only on an area with sub-areas, and unfolds and folds them", async () => {
    await render();
    expect(all("area-toggle-areas/engineering")).toHaveLength(0);
    await press(one("area-toggle-areas/finance"));
    expect(all("area-row-areas/finance/payroll")).toHaveLength(1);
    await press(one("area-toggle-areas/finance"));
    expect(all("area-row-areas/finance/payroll")).toHaveLength(0);
    expect(all("area-row-areas/finance")).toHaveLength(1);
  });

  test("the top row's chevron folds everything under it", async () => {
    await render();
    await press(one("area-toggle-areas"));
    expect(all("area-row-areas/finance")).toHaveLength(0);
    expect(all("area-row-areas/design")).toHaveLength(0);
  });

  test("on a phone, the open folder is a heading that opens its seat menu, and each area keeps its metric under its name", async () => {
    const menus: string[] = [];
    await render({ compact: true, onMenu: (seat) => menus.push(seat.folder) });
    const head = one("area-row-root");
    expect(strip(head.textContent)).toContain("Supa");
    await press(head);
    expect(menus).toEqual([ROOT]);
    expect(strip(one("area-row-areas/finance").textContent)).toContain("Monthly cost");
    expect(all("area-file-areas/finance/budget.md")).toHaveLength(0);
    await press(one("area-notes-areas/finance"));
    expect(all("area-file-areas/finance/budget.md")).toHaveLength(1);
  });
});
