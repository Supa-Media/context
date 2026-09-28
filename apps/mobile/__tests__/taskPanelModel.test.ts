/**
 * WHAT THE SIDE PANEL AND THE BOARD READ, BEFORE ANYTHING IS DRAWN.
 *
 * The panel opens one task beside the list: the task as the page's rows read
 * it, the task it sits under when it is a subtask, its subtasks (only a
 * top-level task has any: two levels and no deeper) and the plain notes in
 * it. Ticking a subtask's dot flips it between the list's first Done word
 * and its first Not started word that is not Backlog. The Board draws
 * Backlog as a rail beside its columns, and only when the folder's list has
 * it. Pure — no React, no storage.
 */

import { describe, expect, test } from "@jest/globals";
import { boardLayout } from "../features/console/files/folderPage/boardLayout";
import { folderItems, groupFolderItems } from "../features/console/files/folderPage/model";
import {
  bodyPath,
  dueLong,
  ownersValue,
  PANEL_MIN,
  panelEntry,
  panelFits,
  panelText,
  peekLayout,
  taskRefOf,
  tickStatus,
} from "../features/console/files/folderPage/panel/panelModel";
import { statusBands, type StatusList } from "../features/console/files/folderPage/statuses";
import type { ListNote } from "../features/console/files/listBlock/model";

const P = "1-projects/cafe";
const note = (path: string, properties: ListNote["properties"] = {}, heading?: string): ListNote => ({
  path: `${P}/${path}`,
  properties,
  updatedAt: 1,
  ...(heading === undefined ? {} : { heading }),
});
const NOTES: ListNote[] = [
  note("overview.md", { status: "in progress" }, "Café opening"),
  note("lease.md", { status: "to do" }, "Sign the lease"),
  note("kitchen/overview.md", { status: "in progress", priority: "p1" }, "Get the kitchen ready"),
  note("kitchen/oven.md", { status: "finished" }, "Order the oven"),
  note("kitchen/inspection.md", { status: "to do" }, "Book the health inspection"),
  note("kitchen/layout.md", {}, "Kitchen layout sketch"),
  note("kitchen/cleaning/overview.md", { status: "in progress" }, "Draft the cleaning checklist"),
  note("kitchen/cleaning/supplies.md", {}, "Supplies"),
  note("budget.md", {}, "Opening budget"),
];
const DEFAULTS: StatusList = { "not-started": ["backlog", "to do"], "in-progress": ["in progress"], done: ["finished"] };

describe("the task a panel shows", () => {
  test("a folder task: itself, its subtasks, then the plain notes in it", () => {
    const entry = panelEntry(`${P}/kitchen`, P, NOTES)!;
    expect(entry.item.label).toBe("Get the kitchen ready");
    expect(entry.item.priority).toBe(1);
    expect(entry.parent).toBeNull();
    expect(entry.subtasks?.map((item) => item.label)).toEqual(["Order the oven", "Book the health inspection", "Draft the cleaning checklist"]);
    expect(entry.notes.map((item) => item.label)).toEqual(["Kitchen layout sketch"]);
    expect(entry.item.progress).toEqual({ done: 1, total: 3 });
  });

  test("a one-note task has no subtasks yet, and may be given some", () => {
    const entry = panelEntry(`${P}/lease.md`, P, NOTES)!;
    expect(entry.item.kind).toBe("note");
    expect(entry.subtasks).toEqual([]);
    expect(entry.notes).toEqual([]);
  });

  test("a subtask names the task above it, and can hold notes but never subtasks", () => {
    const entry = panelEntry(`${P}/kitchen/cleaning`, P, NOTES)!;
    expect(entry.parent?.label).toBe("Get the kitchen ready");
    expect(entry.subtasks).toBeNull();
    expect(entry.notes.map((item) => item.label)).toEqual(["Supplies"]);
    expect(panelEntry(`${P}/kitchen/oven.md`, P, NOTES)?.parent?.path).toBe(`${P}/kitchen`);
  });

  test("a plain note opens as itself, and one in a subtask names the subtask it is in", () => {
    const budget = panelEntry(`${P}/budget.md`, P, NOTES)!;
    expect(budget.item.status).toBe("");
    expect(budget.parent).toBeNull();
    const supplies = panelEntry(`${P}/kitchen/cleaning/supplies.md`, P, NOTES)!;
    expect(supplies.item.label).toBe("Supplies");
    expect(supplies.parent?.label).toBe("Draft the cleaning checklist");
  });

  test("nothing outside the project, no task deeper than a subtask, nothing the device doesn't have", () => {
    expect(panelEntry("2-areas/x.md", P, NOTES)).toBeNull();
    expect(panelEntry(`${P}/kitchen/cleaning/deeper.md`, P, [...NOTES, note("kitchen/cleaning/deeper.md", { status: "to do" })])).toBeNull();
    expect(panelEntry(`${P}/kitchen/cleaning/a/b.md`, P, [...NOTES, note("kitchen/cleaning/a/b.md")])).toBeNull();
    expect(panelEntry(`${P}/gone.md`, P, NOTES)).toBeNull();
    // The project's own front note speaks for the project, and is not one of its tasks.
    expect(panelEntry(`${P}/overview.md`, P, NOTES)).toBeNull();
  });
});

describe("ticking a subtask", () => {
  test("done goes back to the first Not started word that isn't Backlog; anything else is done", () => {
    expect(tickStatus("finished", DEFAULTS)).toBe("to do");
    expect(tickStatus("to do", DEFAULTS)).toBe("finished");
    expect(tickStatus("in progress", DEFAULTS)).toBe("finished");
    expect(tickStatus("Backlog", DEFAULTS)).toBe("finished");
    const own: StatusList = { "not-started": ["idea"], "in-progress": ["doing"], done: ["shipped", "dropped"] };
    expect(tickStatus("dropped", own)).toBe("idea");
    expect(tickStatus("doing", own)).toBe("shipped");
  });
});

describe("what a panel writes and says", () => {
  test("owners: none clears the line, one is a line, several are a list", () => {
    expect(ownersValue([])).toBeNull();
    expect(ownersValue(["@sayo"])).toBe("@sayo");
    expect(ownersValue(["@sayo", "Claude"])).toEqual(["@sayo", "Claude"]);
  });

  test("a due day in full, with the year only when it isn't this one", () => {
    const now = new Date(2026, 8, 28).getTime();
    expect(dueLong({ year: 2026, month: 10, day: 3 }, now)).toBe("Saturday, Oct 3");
    expect(dueLong({ year: 2027, month: 1, day: 4 }, now)).toBe("Monday, Jan 4, 2027");
  });

  test("a note task shown as the folder it became is written to as that folder", () => {
    const lease = panelEntry(`${P}/lease.md`, P, NOTES)!.item;
    expect(taskRefOf(lease, `${P}/lease.md`)).toMatchObject({ path: `${P}/lease.md`, kind: "note", target: `${P}/lease.md` });
    expect(taskRefOf(lease, `${P}/lease`)).toMatchObject({ path: `${P}/lease`, kind: "folder", target: `${P}/lease/overview.md`, creates: false });
  });

  test("opens wherever the panel itself fits, beside the list or over it", () => {
    expect(PANEL_MIN).toBe(430);
    expect(panelFits(1280, 0)).toBe(true);
    expect(panelFits(700, 1600)).toBe(true);
    expect(panelFits(500, 1600)).toBe(false);
    // Before the page has been measured, the window stands in for it.
    expect(panelFits(0, 1280)).toBe(true);
    expect(panelFits(0, 400)).toBe(false);
  });

  test("about half the page, beside the list where both fit and over it where they don't", () => {
    const wide = peekLayout(1440, 640, false)!;
    expect(wide.mode).toBe("beside");
    expect(wide.panel).toBe(672);
    // The list keeps its measure under the title; the panel takes the room at the right.
    expect(wide.width - wide.panel - 24).toBe(640);
    const narrower = peekLayout(1100, 640, false)!;
    expect(narrower.mode).toBe("over");
    expect(narrower.panel).toBe(502);
    // The list is not squeezed: the panel lies over its right side, up to the page's margin.
    expect(narrower.main).toBe(640);
    expect(narrower.overlap).toBe(640 + 502 - narrower.width);
    expect(narrower.overlap).toBeGreaterThan(0);
    expect(peekLayout(4000, 640, false)!.panel).toBe(720);
    expect(peekLayout(0, 640, false)).toBeNull();
  });
});

describe("the words a panel shows", () => {
  test("a note's own, a folder's front note's, and none for a folder with no front note", () => {
    expect(bodyPath(panelEntry(`${P}/budget.md`, P, NOTES)!.item)).toBe(`${P}/budget.md`);
    expect(bodyPath(panelEntry(`${P}/kitchen`, P, NOTES)!.item)).toBe(`${P}/kitchen/overview.md`);
    const bare = [...NOTES, note("bare/one.md", {}, "One")];
    expect(bodyPath(panelEntry(`${P}/bare`, P, bare)!.item)).toBeNull();
  });

  test("without the frontmatter, and without a first heading the panel already shows as its title", () => {
    expect(panelText("---\nstatus: to do\n---\n# Sign the lease\n\nTwo years.\n", "Sign the lease")).toBe("Two years.\n");
    expect(panelText("# Other heading\n\nWords.\n", "Sign the lease")).toBe("# Other heading\n\nWords.\n");
    expect(panelText("Just words.", "x")).toBe("Just words.");
    expect(panelText("---\nstatus: to do\n---\n", "x")).toBe("");
  });
});

describe("the board's rail and columns", () => {
  const LATER = note("later.md", { status: "Backlog" }, "Loyalty cards");
  const entries = (names: readonly string[]) =>
    names.map((name) => ({ kind: "file" as "file" | "folder", path: `${P}/${name}`, name })).concat([{ kind: "folder" as const, path: `${P}/kitchen`, name: "kitchen" }]);
  const bands = (list: StatusList, withLater: boolean) => {
    const { items } = folderItems(P, entries(withLater ? ["lease.md", "budget.md", "later.md"] : ["lease.md", "budget.md"]), [...NOTES, LATER]);
    return statusBands(groupFolderItems(items.filter((item) => item.status !== ""), "status", list), list);
  };

  test("Backlog is the rail, and every other status a column, tinted by its group", () => {
    const board = boardLayout(bands(DEFAULTS, true));
    expect(board.backlog?.items.map((item) => item.label)).toEqual(["Loyalty cards"]);
    expect(board.columns.map((column) => [column.group.value, column.tone, column.group.items.length])).toEqual([
      ["to do", "not-started", 1],
      ["in progress", "in-progress", 1],
      ["finished", "done", 0],
    ]);
    // Empty, it is still somewhere to park a card.
    expect(boardLayout(bands(DEFAULTS, false)).backlog?.items).toEqual([]);
  });

  test("a list with no Backlog word has no rail — unless a task still says it, as the List's band does", () => {
    const own: StatusList = { "not-started": ["to do"], "in-progress": ["in progress"], done: ["finished"] };
    const board = boardLayout(bands(own, false));
    expect(board.backlog).toBeNull();
    expect(board.columns.map((column) => column.group.value)).toEqual(["to do", "in progress", "finished"]);
    expect(boardLayout(bands(own, true)).backlog?.value).toBe("Backlog");
  });
});
