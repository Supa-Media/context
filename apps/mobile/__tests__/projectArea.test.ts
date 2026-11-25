/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT SAYS WHICH AREA IT SERVES.
 *
 * The owner approved, 2026-11-25 ("Projects in areas" boards, board 3): on a
 * project's page the property line gains "area Finance", or "Set area" for a
 * writer, picked from the workspace's areas by name and never typed; on the
 * Projects List each project row shows its area as a quiet tag, "No area"
 * only for one in progress, and nothing for any other. The properties with
 * teeth: the pick writes `area: <the area's folder>` to the project's front
 * note, the menu reads names not paths and offers no "New value…", and a
 * finished project with no area draws no tag.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { ListNote } from "../features/console/files/listBlock/model";
import { rowExtras } from "../features/console/files/folderPage/rowExtras";
import type { FolderItem } from "../features/console/files/folderPage/model";
import { projectAreaTag } from "../features/console/files/folderPage/areas/areaProjects";
import { areaName } from "../features/console/files/folderPage/areas/useAreaChoices";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { CAFE, NOTES, all, host, mount, one, press, strip, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

const AREAS: ListNote[] = [
  { path: "areas/about.md", properties: {} },
  { path: "areas/finance/about.md", properties: { owner: "@seyi" } },
  { path: "areas/engineering/about.md", properties: { owner: "@sayo" } },
  { path: "areas/engineering/ci-cd/about.md", properties: { owner: "@sayo", area: "true" } },
];

beforeEach(() => {
  windowOf(1280);
  forgetViews();
});
afterEach(unmountAll);

const menuItems = () =>
  all("menu-root").flatMap((menu) => Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="menu-item-"]')));
const menuItem = (label: string) => menuItems().find((node) => strip(node.textContent).trim() === label)!;

describe("a project's page", () => {
  test("a writer sets the area from the workspace's areas, by name, and it is written as the area's folder", async () => {
    const writes: Write[] = [];
    await mount(host(writes, { notes: [...NOTES, ...AREAS] }));
    const area = one("folder-property-area");
    expect(strip(area.textContent)).toBe("Set area");
    await press(area);
    const labels = menuItems().map((node) => strip(node.textContent).trim());
    expect(labels).toEqual(expect.arrayContaining(["Engineering", "Engineering / Ci cd", "Finance"]));
    expect(labels).not.toContain("New value…");
    expect(labels.some((label) => label.includes("areas/"))).toBe(false);
    await press(menuItem("Finance"));
    expect(writes).toContainEqual([`${CAFE}/overview.md`, "area", "areas/finance", undefined]);
  });

  test("a set area reads as its name; a reader sees it and nothing to press", async () => {
    const notes = [...NOTES.map((note) => (note.path === `${CAFE}/overview.md` ? { ...note, properties: { ...note.properties, area: "areas/engineering/ci-cd" } } : note)), ...AREAS];
    await mount(host(null, { notes }));
    expect(strip(one("folder-property-line").textContent)).toContain("area Engineering / Ci cd");
  });
});

describe("the Projects List's area tag", () => {
  const item = (path: string, status: string, area?: string) =>
    ({ path, status, noted: false, progress: null, properties: area === undefined ? { status } : { status, area } }) as unknown as FolderItem;
  const tones: Record<string, "in-progress" | "done" | "not-started"> = { active: "in-progress", finished: "done", idea: "not-started" };

  test("names the area a project serves, says No area only for one in progress, and nothing for the rest", () => {
    const extras = rowExtras(
      [item("projects/a", "active", "areas/finance"), item("projects/b", "active"), item("projects/c", "finished"), item("projects/d", "idea", "areas/growth/merch")],
      (status) => tones[status] ?? "not-started",
      () => ({ kind: "nobody" }) as never,
      undefined,
      (each, tone) => projectAreaTag(each.properties, tone),
    );
    expect(extras.get("projects/a")!.area).toEqual({ folder: "areas/finance", label: "Finance" });
    expect(extras.get("projects/b")!.area).toEqual({ folder: null, label: "No area" });
    expect(extras.get("projects/c")!.area).toBeUndefined();
    expect(extras.get("projects/d")!.area).toEqual({ folder: "areas/growth/merch", label: "Merch" });
  });

  test("area: true and false are an Areas folder's words, never a project's area", () => {
    expect(projectAreaTag({ area: "false" }, "done")).toBeUndefined();
    expect(projectAreaTag({ area: "true" }, "in-progress")).toEqual({ folder: null, label: "No area" });
  });

  test("a line naming an area that is gone reads as its last folder's name", () => {
    expect(areaName("areas/old-thing", new Map([["areas/finance", "Finance"]]))).toBe("Old thing");
    expect(areaName("Areas/Finance/", new Map([["areas/finance", "Finance"]]))).toBe("Finance");
  });
});
