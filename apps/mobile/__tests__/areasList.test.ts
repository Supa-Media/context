/**
 * @jest-environment jsdom
 */

/**
 * THE AREAS LIST DRAWS THE OPEN FOLDER AS ITS ROOT AND NESTS EVERYTHING UNDER IT.
 *
 * The owner's board, 2026-11-24 ("E Trend"), trimmed on 2026-11-26 (the
 * simplified Areas page, option A): a top row for the open folder, sub-areas
 * nested under it and folded, and on every area row its owner's face, its one
 * metric as the latest value with the goal in words, and ⋯. Then, where the
 * verdict words were (the owner, 2026-11-26: "instead of exceeds targets etc,
 * just show x projects", in "the green and yellow colors"), how many of its
 * projects are in progress, in the verdict's colour, unfolding them under the
 * row. No trend, period tag or notes count on a row: those are in the side
 * panel. The properties with teeth: the root row carries the workspace's name,
 * a sub-area indents deeper than its parent, a value is drawn against its goal
 * with the verdict on its hover tip, the projects count takes the verdict's
 * colour and unfolds the projects, and an unowned area draws the empty face.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createRoot, type Root } from "react-dom/client";
import type { ListNote } from "../features/console/files/listBlock/model";
import { AreasList, type AreasListProps } from "../features/console/files/folderPage/areas/AreasList";
import { areaTree } from "../features/console/files/folderPage/areas/seat";
import type { AreaProject, AreaProjects } from "../features/console/files/folderPage/areas/areaProjects";
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

  test("a row draws no notes or folders count: they live in the side panel", async () => {
    await render();
    expect(all("area-notes-areas/design")).toHaveLength(0);
    expect(all("area-notes-areas/finance")).toHaveLength(0);
    expect(all("area-file-areas/design/brand.md")).toHaveLength(0);
  });

  test("a sub-area count sits beside the name of an area that has some", async () => {
    await render();
    expect(strip(one("area-inside-areas/finance").textContent)).toBe("1");
    expect(all("area-inside-areas/design")).toHaveLength(0);
  });

  test("a value is drawn against its goal in words, with one verdict and no trend on the row", async () => {
    // Finance's Monthly cost is $640 against "under $600": a broken limit.
    await render({ readingOf: (seat) => (seat.folder === "areas/finance" ? { value: "$640", date: "2026-11-23", series: [480, 560, 640] } : undefined) });
    const finance = one("area-row-areas/finance");
    expect(strip(finance.textContent)).toContain("$640 under $600 · Monthly cost");
    // The verdict's words left the row for the projects count; they stay on the hover tip.
    expect(strip(finance.textContent)).not.toContain("Needs a look");
    expect(all("area-verdict-over", finance)).toHaveLength(0);
    expect(one("area-metric", finance).getAttribute("title")).toContain("Needs a look");
    expect(all("area-trend", finance)).toHaveLength(0);
  });

  test("a value past its limit says Exceeds target on its hover tip", async () => {
    await render({ readingOf: (seat) => (seat.folder === "areas/finance" ? { value: "$420", date: "2026-11-23", series: [480, 420] } : undefined) });
    expect(one("area-metric", one("area-row-areas/finance")).getAttribute("title")).toContain("Exceeds target");
  });

  test("a metric with no reading yet shows its goal and name, with no placeholder and no verdict", async () => {
    await render();
    const finance = strip(one("area-row-areas/finance").textContent);
    expect(finance).toContain("under $600 · Monthly cost");
    expect(finance).not.toContain("No data");
    expect(finance).not.toContain("target");
    expect(all("area-trend", one("area-row-areas/finance"))).toHaveLength(0);
  });

  describe("an area's projects, where the verdict words were", () => {
    const project = (name: string, area: string): AreaProject => ({ folder: `projects/${name}`, name, status: "In progress", group: "in-progress", owner: null, area, target: `projects/${name}/about.md`, creates: false });
    const NONE: AreaProjects = { inProgress: [], notStarted: [], done: [], other: [] };
    const projectsOf = (folder: string): AreaProjects =>
      folder === "areas/finance"
        ? { inProgress: [project("Stripe sync", "areas/finance"), project("Payroll move", "areas/finance/payroll")], notStarted: [project("Audit", "areas/finance")], done: [], other: [] }
        : folder === "areas/engineering"
          ? { ...NONE, inProgress: [project("On-call rota", "areas/engineering")] }
          : NONE;
    const finance = (value: string) => ({ readingOf: (seat: { folder: string }) => (seat.folder === "areas/finance" ? { value, date: "2026-11-23", series: [value] } : undefined), projectsOf }) as Partial<AreasListProps>;
    const toneOf = (el: HTMLElement) => el.getAttribute("data-tone");

    test("the count says how many are in progress, in the verdict's yellow when the number needs a look", async () => {
      await render(finance("$640"));
      const count = one("area-projects-areas/finance");
      expect(strip(count.textContent)).toBe("2 projects");
      expect(toneOf(count)).toBe("bad");
      expect(count.getAttribute("aria-label")).toContain("Needs a look");
    });

    test("and in green when the number is past its target", async () => {
      await render(finance("$420"));
      expect(toneOf(one("area-projects-areas/finance"))).toBe("good");
    });

    test("muted with no verdict, one project in the singular, and nothing when none are in progress", async () => {
      await render({ projectsOf });
      const count = one("area-projects-areas/engineering");
      expect(strip(count.textContent)).toBe("1 project");
      expect(toneOf(count)).toBe("quiet");
      expect(all("area-projects-areas/design")).toHaveLength(0);
      expect(all("area-projects-areas")).toHaveLength(0);
    });

    test("a press unfolds the projects in progress under the row, with the rest on one line, and a project row opens it", async () => {
      const opened: string[] = [];
      await render({ ...finance("$640"), onOpen: (path) => opened.push(path) });
      expect(all("area-project-projects/Stripe sync")).toHaveLength(0);
      await press(one("area-projects-areas/finance"));
      expect(all("area-project-projects/Stripe sync")).toHaveLength(1);
      expect(strip(one("area-project-projects/Payroll move").textContent)).toContain("Payroll");
      expect(strip(one("area-projects-rest-areas/finance").textContent)).toBe("1 not started");
      await press(one("area-project-projects/Stripe sync"));
      expect(opened).toEqual(["projects/Stripe sync"]);
      await press(one("area-projects-areas/finance"));
      expect(all("area-project-projects/Stripe sync")).toHaveLength(0);
    });

    test("on a phone the count sits at the end of the name line and unfolds the same way", async () => {
      await render({ ...finance("$640"), compact: true });
      await press(one("area-projects-areas/finance"));
      expect(all("area-project-projects/Stripe sync")).toHaveLength(1);
    });
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
    expect(all("area-notes-areas/finance")).toHaveLength(0);
  });
});
