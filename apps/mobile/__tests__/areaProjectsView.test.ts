/**
 * @jest-environment jsdom
 */

/**
 * AN AREA SHOWS ITS PROJECTS IN PROGRESS, AND ITS PANEL ATTACHES AND DETACHES THEM.
 *
 * The owner approved, 2026-11-25 ("Projects in areas" boards): on the Areas
 * List each area row ends in a count of its projects in progress, beside the
 * notes count, which unfolds them under the row; the top row has none. The
 * area panel lists them, folds the rest into one line, and "Attach a project"
 * writes the project's `area:` line, while × removes it. A reader gets
 * neither. The properties with teeth: the count is the in-progress group only,
 * a parent counts its sub-areas', a project serving a sub-area says which, and
 * the writes go to the project's front note with exactly that one line.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { createRoot, type Root } from "react-dom/client";
import type { ListNote } from "../features/console/files/listBlock/model";
import { AreasList, type AreasListProps } from "../features/console/files/folderPage/areas/AreasList";
import { PanelProjects } from "../features/console/files/folderPage/areas/PanelProjects";
import { areaTree } from "../features/console/files/folderPage/areas/seat";
import { attachChoices, groupedProjects, projectsUnder, type AreaProject } from "../features/console/files/folderPage/areas/areaProjects";
import { all, one, press, strip, unmountAll } from "./projectPage/fixtures";

const AREAS: ListNote[] = [
  { path: "areas/about.md", properties: {} },
  { path: "areas/finance/about.md", properties: { owner: "@seyi" } },
  { path: "areas/finance/payroll/about.md", properties: { owner: "@seyi" } },
  { path: "areas/design/about.md", properties: { owner: "@sayo" } },
  { path: "areas/design/brand.md", properties: {} },
];

const PROJECTS: ListNote[] = [
  { path: "projects/stripe-sync/about.md", properties: { status: "In progress", owner: "@seyi", area: "areas/finance" } },
  { path: "projects/run-payroll/about.md", properties: { status: "In progress", area: "areas/finance/payroll" } },
  { path: "projects/budget/about.md", properties: { status: "Not started", area: "areas/finance" } },
  { path: "projects/retreat/about.md", properties: { status: "Done", area: "areas/finance" } },
  { path: "projects/pricing/README.md", properties: { status: "In progress" } },
];

const projects = projectsUnder("projects", PROJECTS);
const faceOf = (owner: string | null) => (owner === null ? { kind: "nobody" as const } : ({ kind: "person", name: owner } as never));

let mounted: Root | null = null;
let container: HTMLElement | null = null;

async function mount(element: ReturnType<typeof createElement>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  mounted = createRoot(container);
  await act(async () => {
    mounted!.render(element);
  });
  await act(async () => {});
}

afterEach(() => {
  if (mounted !== null) act(() => mounted!.unmount());
  mounted = null;
  container?.remove();
  unmountAll();
});

function list(overrides: Partial<AreasListProps> = {}) {
  const props: AreasListProps = {
    tree: areaTree("areas", "areas", AREAS),
    compact: false,
    faceOf,
    label: (owner) => owner,
    reach: () => "",
    rootTitle: "Supa",
    notesUnder: () => 0,
    readingOf: () => undefined,
    onOpen: () => {},
    onMenu: () => {},
    projectsOf: (folder) => groupedProjects(folder, projects),
    ...overrides,
  };
  return createElement(AreasList, props);
}

describe("the Areas List's projects count", () => {
  test("counts an area's projects in progress, its sub-areas' included, and the top row and an area with none draw no count", async () => {
    await mount(list());
    expect(strip(one("area-projects-areas/finance").textContent)).toContain("2");
    expect(one("area-projects-areas/finance").getAttribute("aria-label")).toBe("Show 2 projects in progress for finance");
    expect(all("area-projects-areas/design")).toHaveLength(0);
    expect(all("area-projects-areas")).toHaveLength(0);
  });

  test("hidden until pressed; then the projects in progress unfold, say a sub-area's name, open the project, and the rest is one line", async () => {
    const opened: string[] = [];
    await mount(list({ onOpen: (path) => opened.push(path) }));
    expect(all("area-project-projects/stripe-sync")).toHaveLength(0);
    await press(one("area-projects-areas/finance"));
    expect(all("area-project-projects/stripe-sync")).toHaveLength(1);
    expect(strip(one("area-project-projects/run-payroll").textContent)).toContain("payroll");
    expect(all("area-project-projects/budget")).toHaveLength(0);
    expect(strip(one("area-projects-rest-areas/finance").textContent)).toBe("1 not started · 1 done");
    await press(one("area-project-projects/stripe-sync"));
    expect(opened).toEqual(["projects/stripe-sync"]);
  });

  test("with no Projects folder read, no row draws a count", async () => {
    await mount(list({ projectsOf: undefined }));
    expect(all("area-projects-areas/finance")).toHaveLength(0);
  });
});

describe("the area panel's projects", () => {
  function panel(attach?: (project: AreaProject, area: string | null) => Promise<string | null>) {
    return createElement(PanelProjects, {
      area: "areas/finance",
      tools: { projects: groupedProjects("areas/finance", projects), choices: attachChoices("areas/finance", projects), faceOf, open: () => {}, ...(attach === undefined ? {} : { attach }) },
      onProblem: () => {},
    });
  }

  test("attach writes the picked project's area line; × detaches; the rest line unfolds the others", async () => {
    const writes: [string, string | null][] = [];
    await mount(panel(async (project, area) => (writes.push([project.folder, area]), null)));
    await press(one("area-panel-attach"));
    // Serving no area first: pricing before the ones already elsewhere.
    expect(all("area-panel-attach-projects/pricing")).toHaveLength(1);
    expect(all("area-panel-attach-projects/stripe-sync")).toHaveLength(0);
    await press(one("area-panel-attach-projects/pricing"));
    await press(one("area-panel-detach-projects/stripe-sync"));
    expect(writes).toEqual([
      ["projects/pricing", "areas/finance"],
      ["projects/stripe-sync", null],
    ]);
    expect(all("area-panel-project-projects/budget")).toHaveLength(0);
    await press(one("area-panel-projects-rest"));
    expect(all("area-panel-project-projects/budget")).toHaveLength(1);
    expect(all("area-panel-project-projects/retreat")).toHaveLength(1);
  });

  test("a reader sees the projects but cannot attach or detach", async () => {
    await mount(panel());
    expect(all("area-panel-project-projects/stripe-sync")).toHaveLength(1);
    expect(all("area-panel-attach")).toHaveLength(0);
    expect(all("area-panel-detach-projects/stripe-sync")).toHaveLength(0);
  });
});
