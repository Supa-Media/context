/**
 * Context's own icons in the picker, and Tex's own folders in the menu
 * (owner, 2026-10-21, "Context icon set" boards 3 and 4).
 */

import { describe, expect, test } from "@jest/globals";
import { CONTEXT_ICONS, contextIconOf } from "@context/shared/src/contextIcons.cjs";
import { openingTab, sectionsFor } from "../features/console/files/FolderIconDialog";
import { ICONS, PARTS } from "../features/console/files/contextIcons/drawings";
import { PART_EMOJI } from "@context/shared/src/contextIcons.cjs";
import { TEX_PART_DETAIL } from "../features/console/files/menuBuiltIn";
import { dir, find, ids, menu } from "./fileMenu/fixtures";
import { texPartIconUnder } from "../features/console/files/jobIcons/folderJobs";
import { contextPartMarker } from "@context/shared/src/contextIcons.cjs";

describe("the picker opens on Context icons", () => {
  test("every one of the hundred, by family, before anything is typed", () => {
    const sections = sectionsFor("", [], 240, "context");
    expect(sections.map((section) => section.title)[0]).toBe("Work");
    const cells = sections.flatMap((section) => section.cells);
    expect(cells).toHaveLength(100);
    expect(cells.every((cell) => contextIconOf(cell.icon) !== null)).toBe(true);
  });

  test("search finds Context icons first, then emoji", () => {
    const titles = sectionsFor("birthday", [], 240, "context").map((section) => section.title);
    expect(titles[0]).toBe("Context icons");
    expect(titles).toContain("Emoji");
  });

  test("the Emoji tab is the picker it was", () => {
    expect(sectionsFor("", [], 240, "emoji").map((section) => section.title)).toEqual(["Popular", "All emoji"]);
  });

  test("it opens on Emoji only when an emoji is chosen now", () => {
    expect(openingTab(null)).toBe("context");
    expect(openingTab("context:icon:rocket")).toBe("context");
    expect(openingTab("context:part:tex_skills")).toBe("context");
    expect(openingTab("🍳")).toBe("emoji");
    expect(openingTab(":party-parrot:")).toBe("emoji");
  });
});

test("every Context icon and every part has a drawing", () => {
  for (const icon of CONTEXT_ICONS) expect(ICONS[icon.name]?.length ?? 0).toBeGreaterThan(0);
  for (const part of Object.keys(PART_EMOJI) as (keyof typeof PARTS)[]) expect(PARTS[part]?.length ?? 0).toBeGreaterThan(0);
  expect(Object.keys(ICONS)).toHaveLength(CONTEXT_ICONS.length);
});

describe("Tex's own folders keep their name and place", () => {
  const jobOf = (path: string) => (path === "Assistant/tex" ? ("tex" as const) : null);

  test("Rename and Move to are dimmed, with the reason", () => {
    const list = menu({ kind: "row", row: dir("Assistant/tex/transcripts") }, { jobOf });
    expect(find(list, "rename")?.disabled).toBe(true);
    expect(find(list, "moveTo")?.disabled).toBe(true);
    expect(find(list, "moveTo")?.detail).toBe(TEX_PART_DETAIL);
    const page = menu({ kind: "page", row: dir("Assistant/tex/routines") }, { jobOf });
    expect(find(page, "moveTo")?.disabled).toBe(true);
  });

  test("a folder of a person's own inside Tex's, or a skills folder elsewhere, moves", () => {
    expect(find(menu({ kind: "row", row: dir("Assistant/tex/trips") }, { jobOf }), "moveTo")?.disabled).toBeFalsy();
    expect(find(menu({ kind: "row", row: dir("Work/skills") }, { jobOf }), "moveTo")?.disabled).toBeFalsy();
    expect(ids(menu({ kind: "row", row: dir("Work/skills") }, { jobOf }))).toContain("rename");
  });
});

describe("Tex's own folders draw their parts wherever Tex's folder is", () => {
  const jobs = new Map([["Assistant/tex", "tex" as const]]);
  test("a nested Tex folder's parts, notes and cadences", () => {
    expect(texPartIconUnder(jobs, "Assistant/tex/skills")).toBe(contextPartMarker("tex_skills"));
    expect(texPartIconUnder(jobs, "Assistant/tex/about-me.md")).toBe(contextPartMarker("tex_about"));
    expect(texPartIconUnder(jobs, "Assistant/tex/routines/every-day")).toBe(contextPartMarker("cadence_day"));
  });
  test("a folder of the person's own, or outside Tex's folder, draws nothing", () => {
    expect(texPartIconUnder(jobs, "Assistant/tex/recipes")).toBeNull();
    expect(texPartIconUnder(jobs, "Assistant/skills")).toBeNull();
    expect(texPartIconUnder(jobs, "Assistant/tex/skills/deep/er")).toBeNull();
  });
});
