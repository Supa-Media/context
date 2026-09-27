/**
 * A folder page's statuses in their groups: the bands a board and a list
 * draw, the words that need a group, and what a rename or delete rewrites.
 * Pure — `folderPage/statuses.ts`. The list's format and meaning are the
 * gateway's, proved in `apps/mcp/test/listStatuses.test.mjs`.
 */

import { describe, expect, test } from "@jest/globals";
import { folderItems, groupFolderItems } from "../features/console/files/folderPage/model";
import {
  folderStatuses,
  governingFolder,
  listBands,
  moveStatus,
  notesUsing,
  placeStatus,
  removeStatus,
  renameStatus,
  replacementFor,
  statusBands,
  statusListIssue,
  statusListWrite,
  statusMenu,
  undeclaredStatuses,
  type StatusList,
} from "../features/console/files/folderPage/statuses";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry } from "../features/console/files/types";

const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});
const note = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path, properties, updatedAt: 1 });

/** The owner's own board, as reported: Active, In Progress and Exploration, nothing declared. */
const PROJECTS: ListNote[] = [
  note("1-projects/worship/overview.md", { status: "active" }),
  note("1-projects/money/overview.md", { status: "active" }),
  note("1-projects/plan.md", { status: "In Progress" }),
  note("1-projects/housing.md", { status: "exploration" }),
  note("1-projects/idea.md"),
];
const ENTRIES = [
  entry("folder", "1-projects/worship"),
  entry("folder", "1-projects/money"),
  entry("file", "1-projects/plan.md"),
  entry("file", "1-projects/housing.md"),
  entry("file", "1-projects/idea.md"),
];
const shape = (bands: ReturnType<typeof statusBands>) =>
  bands.map((band) => [band.label, band.columns.map((column) => [column.value, column.items.length])]);

describe("a folder with nothing declared", () => {
  const { list, from, note: declaredIn } = folderStatuses("1-projects", PROJECTS);
  const items = folderItems("1-projects", ENTRIES, PROJECTS).items;
  const groups = groupFolderItems(items, "status", list);

  test("has the defaults: no status, in progress, finished", () => {
    expect(list).toEqual({ "not-started": [], "in-progress": ["in progress"], done: ["finished"] });
    expect(from).toBeNull();
    expect(declaredIn).toBeNull();
  });

  test("draws Active under In progress, In Progress as the default, and Exploration apart", () => {
    expect(shape(statusBands(groups, list, true))).toEqual([
      ["Not started", [["", 1]]],
      ["In progress", [["In Progress", 1], ["active", 2]]],
      ["Done", [["finished", 0]]],
      ["No group yet", [["exploration", 1]]],
    ]);
  });

  test("the List leaves empty statuses out", () => {
    expect(shape(listBands(groups, list)).map(([label]) => label)).toEqual(["Not started", "In progress", "No group yet"]);
  });

  test("says which words the list does not hold, with what merging would do", () => {
    expect(undeclaredStatuses(items, list)).toEqual([
      { word: "active", count: 2, group: "in-progress", mergeInto: "in progress" },
      { word: "exploration", count: 1, group: null, mergeInto: null },
    ]);
  });

  test("the menu offers No status first, then each group's statuses", () => {
    expect(statusMenu(list).map((section) => [section.label, section.words])).toEqual([
      ["Not started", [""]],
      ["In progress", ["in progress"]],
      ["Done", ["finished"]],
    ]);
  });
});

describe("a declared list", () => {
  const notes = [
    ...PROJECTS,
    note("1-projects/overview.md", { "statuses-not-started": ["exploration"], "statuses-in-progress": ["in progress", "in review"] }),
  ];
  const { list, from } = folderStatuses("1-projects", notes);
  const items = folderItems("1-projects", ENTRIES, notes).items;

  test("is read from the folder's front note, and places its words", () => {
    expect(from).toBe("1-projects");
    const bands = shape(statusBands(groupFolderItems(items, "status", list), list, false));
    expect(bands[0]).toEqual(["Not started", [["", 1], ["exploration", 1]]]);
    expect(bands.map(([label]) => label)).not.toContain("No group yet");
  });

  test("is inherited by a subfolder that declares none", () => {
    expect(folderStatuses("1-projects/worship", notes).from).toBe("1-projects");
  });
});

describe("changing a list", () => {
  const list: StatusList = { "not-started": ["idea"], "in-progress": ["doing", "review"], done: ["won", "lost"] };

  test("adds, moves between groups and reorders", () => {
    expect(placeStatus(list, "exploration", "not-started")["not-started"]).toEqual(["idea", "exploration"]);
    expect(placeStatus(list, "review", "done")).toMatchObject({ "in-progress": ["doing"], done: ["won", "lost", "review"] });
    expect(moveStatus(list, "review", -1)["in-progress"]).toEqual(["review", "doing"]);
    expect(moveStatus(list, "doing", -1)).toBe(list);
  });

  test("renames in place and removes", () => {
    expect(renameStatus(list, "review", "in review")["in-progress"]).toEqual(["doing", "in review"]);
    expect(removeStatus(list, "lost").done).toEqual(["won"]);
  });

  test("a deleted status's notes go to the next in its group, or to No status", () => {
    expect(replacementFor(list, "won")).toBe("lost");
    expect(replacementFor(list, "idea")).toBeNull();
  });

  test("every group but Not started keeps a status", () => {
    expect(statusListIssue(removeStatus(removeStatus(list, "won"), "lost"))).toBe("Done needs at least one status.");
    expect(statusListIssue(removeStatus(list, "idea"))).toBeNull();
  });

  test("is written as three keys, one per group", () => {
    expect(statusListWrite(list)).toEqual([
      ["statuses-not-started", ["idea"]],
      ["statuses-in-progress", ["doing", "review"]],
      ["statuses-done", ["won", "lost"]],
    ]);
  });
});

describe("the notes a rename or delete rewrites", () => {
  test("a folder's status is described by its parent's list", () => {
    expect(governingFolder("p/web/overview.md")).toBe("p");
    expect(governingFolder("p/web/page.md")).toBe("p/web");
  });

  test("every note the list describes, and none whose folder declares its own", () => {
    const notes = [
      note("p/overview.md", { "statuses-done": ["won"] }),
      note("p/a.md", { status: "Won" }),
      note("p/sub/overview.md", { status: "won" }),
      note("p/sub/b.md", { status: "won" }),
      note("p/own/overview.md", { status: "won", "statuses-done": ["won"] }),
      note("p/own/c.md", { status: "won" }),
      note("q/d.md", { status: "won" }),
    ];
    expect(notesUsing("won", "p", "p", notes)).toEqual(["p/a.md", "p/own/overview.md", "p/sub/b.md", "p/sub/overview.md"]);
  });

  test("with the defaults, only notes under the folder the list will be written to", () => {
    const notes = [note("p/a.md", { status: "finished" }), note("elsewhere/b.md", { status: "finished" })];
    expect(notesUsing("finished", null, "p", notes)).toEqual(["p/a.md"]);
  });
});
