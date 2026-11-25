/**
 * WHICH PROJECTS SERVE WHICH AREA.
 *
 * The owner approved, 2026-11-25 ("Projects in areas" boards): projects stay
 * in the Projects folder, and each names the area it serves with an
 * `area: areas/<folder>` line in its front note. An area row counts the
 * projects in progress for it and its sub-areas. The properties with teeth:
 * a grouping folder (`backlog/`) is not a project but its children are; a
 * task folder inside a project is not a project; `area: true|false` is never
 * an area; matching ignores case, `@` and slashes; custom status words count
 * by their group; a parent area counts its sub-areas' projects but a sibling
 * whose name merely starts the same does not.
 */

import { describe, expect, test } from "@jest/globals";
import type { ListNote } from "../features/console/files/listBlock/model";
import {
  areaKey,
  attachChange,
  attachChoices,
  groupedProjects,
  projectsOfArea,
  projectsUnder,
  restLine,
} from "../features/console/files/folderPage/areas/areaProjects";

const NOTES: ListNote[] = [
  { path: "projects/about.md", properties: { "statuses-not-started": ["Not started"], "statuses-in-progress": ["In progress", "building"], "statuses-done": ["Done"] } },
  { path: "projects/stripe-sync/about.md", properties: { status: "In progress", owner: "@seyi", area: "areas/finance" } },
  { path: "projects/stripe-sync/task-a/about.md", properties: { status: "Done", area: "areas/design" } },
  { path: "projects/stripe-sync/task-b/about.md", properties: { status: "In progress" } },
  { path: "projects/cut-spend/about.md", properties: { status: "building", area: "Areas/Finance/Payroll/" } },
  { path: "projects/pricing/README.md", properties: { status: "Not started" } },
  { path: "projects/retreat/about.md", properties: { status: "Done", area: "areas/finance" } },
  { path: "projects/weird/about.md", properties: { status: "parked", area: "areas/finance" } },
  { path: "projects/plain/notes.md", properties: {} },
  { path: "projects/flagged/about.md", properties: { status: "In progress", area: "false" } },
  { path: "projects/backlog/ideas.md", properties: {} },
  { path: "projects/backlog/search/about.md", properties: { status: "Not started", area: "@areas/engineering" } },
  { path: "projects/backlog/map/about.md", properties: { status: "In progress", area: "areas/financeX" } },
];

const projects = projectsUnder("projects", NOTES);
const folders = projects.map((project) => project.folder);

describe("projectsUnder", () => {
  test("lists folders in the Projects folder and in a grouping folder, not task folders or the grouping folder", () => {
    expect(folders).toEqual(
      expect.arrayContaining([
        "projects/stripe-sync",
        "projects/cut-spend",
        "projects/pricing",
        "projects/retreat",
        "projects/plain",
        "projects/backlog/search",
        "projects/backlog/map",
      ]),
    );
    expect(folders).not.toContain("projects/backlog");
    expect(folders).not.toContain("projects/stripe-sync/task-b");
  });

  test("keeps a deeper folder whose front note names an area, so an agent's line is never lost", () => {
    expect(folders).toContain("projects/stripe-sync/task-a");
  });

  test("never reads area: true or false as an area", () => {
    expect(projects.find((project) => project.folder === "projects/flagged")?.area).toBeNull();
  });

  test("a project with no front note is written by creating one", () => {
    const plain = projects.find((project) => project.folder === "projects/plain")!;
    expect(plain.creates).toBe(true);
    expect(attachChange(plain, "areas/design")).toEqual({ target: "projects/plain/about.md", changes: [["area", "areas/design"]], creates: true });
    expect(attachChange(plain, null).creates).toBe(false);
  });

  test("writes to the front note the project already has", () => {
    const pricing = projects.find((project) => project.folder === "projects/pricing")!;
    expect(attachChange(pricing, "areas/growth").target).toBe("projects/pricing/README.md");
  });
});

describe("an area's projects", () => {
  test("matching ignores case, @ and slashes, and counts sub-areas but not a sibling sharing a prefix", () => {
    expect(areaKey("@Areas/Finance/")).toBe("areas/finance");
    const finance = projectsOfArea("areas/finance", projects).map((project) => project.folder);
    expect(finance.sort()).toEqual(["projects/cut-spend", "projects/retreat", "projects/stripe-sync", "projects/weird"]);
    expect(projectsOfArea("areas/finance/payroll", projects).map((project) => project.folder)).toEqual(["projects/cut-spend"]);
    expect(projectsOfArea("areas/engineering", projects).map((project) => project.folder)).toEqual(["projects/backlog/search"]);
  });

  test("groups by the status list's groups, a custom word included, and an unplaced word is never in progress", () => {
    const grouped = groupedProjects("areas/finance", projects);
    expect(grouped.inProgress.map((project) => project.folder).sort()).toEqual(["projects/cut-spend", "projects/stripe-sync"]);
    expect(grouped.done.map((project) => project.folder)).toEqual(["projects/retreat"]);
    expect(grouped.other.map((project) => project.folder)).toEqual(["projects/weird"]);
    expect(restLine(grouped)).toBe("1 not started · 1 done");
    expect(restLine(groupedProjects("areas/nothing", projects))).toBe("");
  });

  test("Attach offers every project not already here, those serving no area first", () => {
    const choices = attachChoices("areas/finance", projects).map((project) => project.folder);
    expect(choices).not.toContain("projects/stripe-sync");
    expect(choices).toContain("projects/cut-spend"); // serves a sub-area, can be moved up
    const firstWithArea = choices.findIndex((folder) => projects.find((project) => project.folder === folder)?.area !== null);
    const lastWithout = choices.map((folder) => projects.find((project) => project.folder === folder)?.area === null).lastIndexOf(true);
    expect(lastWithout).toBeLessThan(firstWithArea);
  });

  test("an empty Projects folder, or none, has no projects", () => {
    expect(projectsUnder("", NOTES)).toEqual([]);
    expect(projectsUnder("projects", [])).toEqual([]);
  });
});
