/**
 * A PROJECT'S TASKS AND NOTES, AS PURE MODEL.
 *
 * Decided by the owner on 2026-09-28 ("Projects for everyone"): anything with
 * a `status` is a task, and anything without one is a plain note, never a
 * "No status" task nobody started. Backlog is a status; priority (`p0`–`p3`)
 * orders a task inside its group; `owner:` may name several; `tags` and `due`
 * are drawn short.
 *
 * The List view itself no longer groups by status (the owner, 2026-10-10: it
 * draws the Notes rows with a dot, a count and faces; see
 * `folderPageList.test.ts`). What is tested here is the pure model those
 * still rest on — `folderPage/taskProps.ts`, `model.ts` and `listLayout.ts`
 * take the device's notes and decide nothing about drawing.
 */

import { describe, expect, test } from "@jest/globals";
import { defaultStatusList } from "../../mcp/src/lists.js";
import { folderItems, groupFolderItems, taskChildren } from "../features/console/files/folderPage/model";
import { makeItTaskStatus } from "../features/console/files/folderPage/taskBasics";
import { dueOf, dueWord, estimateOf, ownersOf, priorityOf, priorityWord, tagsOf } from "../features/console/files/folderPage/taskProps";
import type { StatusList } from "../features/console/files/folderPage/statuses";
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
const note = (path: string, properties: ListNote["properties"] = {}, updatedAt = 1): ListNote => ({ path, properties, updatedAt });
const list = defaultStatusList() as StatusList;

describe("a task's own properties", () => {
  test("priority is p0 to p3, in any case, and anything else is none", () => {
    expect(priorityOf({ priority: "p0" })).toBe(0);
    expect(priorityOf({ priority: " P2 " })).toBe(2);
    expect(priorityOf({ priority: "high" })).toBeNull();
    expect(priorityOf({ priority: "p4" })).toBeNull();
    expect(priorityOf({})).toBeNull();
  });

  test("is said in words, never as p0", () => {
    expect([0, 1, 2, 3, null].map((p) => priorityWord(p as 0 | null))).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
  });

  test("owner may name one or several, and nobody twice", () => {
    expect(ownersOf({ owner: "@sayo" })).toEqual(["@sayo"]);
    expect(ownersOf({ owner: ["@sayo", "Claude", "@Sayo", " "] })).toEqual(["@sayo", "Claude"]);
    expect(ownersOf({ owner: "  " })).toEqual([]);
    expect(ownersOf({})).toEqual([]);
  });

  test("tags are free words, as a list or one line", () => {
    expect(tagsOf({ tags: ["bug", "Kitchen", "bug"] })).toEqual(["bug", "Kitchen"]);
    expect(tagsOf({ tags: "setup, writing" })).toEqual(["setup", "writing"]);
    expect(tagsOf({})).toEqual([]);
  });

  test("estimate is a size from XS to XXL, in any case, and anything else is none", () => {
    expect(estimateOf({ estimate: "M" })).toBe("M");
    expect(estimateOf({ estimate: " xxl " })).toBe("XXL");
    expect(estimateOf({ estimate: ["s"] })).toBe("S");
    expect(estimateOf({ estimate: "huge" })).toBeNull();
    expect(estimateOf({ estimate: "3d" })).toBeNull();
    expect(estimateOf({})).toBeNull();
  });

  test("due is a calendar day, shown as a weekday within the week and a date otherwise", () => {
    // Monday 28 September 2026, mid-morning, wherever the test runs.
    const now = new Date(2026, 8, 28, 10, 0).getTime();
    expect(dueOf({ due: "2026-10-02" })).toEqual({ year: 2026, month: 10, day: 2 });
    expect(dueOf({ due: "2026-02-30" })).toBeNull();
    expect(dueOf({ due: "soon" })).toBeNull();
    expect(dueWord({ year: 2026, month: 9, day: 28 }, now)).toBe("Today");
    expect(dueWord({ year: 2026, month: 10, day: 2 }, now)).toBe("Fri");
    expect(dueWord({ year: 2026, month: 10, day: 5 }, now)).toBe("Oct 5");
    // Past dates are never a weekday, which would read as next week's.
    expect(dueWord({ year: 2026, month: 9, day: 25 }, now)).toBe("Sep 25");
    expect(dueWord({ year: 2027, month: 1, day: 4 }, now)).toBe("Jan 4, 2027");
  });
});

/** A café-opening project: tasks in every group, a task holding subtasks and notes, and plain notes. */
const CAFE = "1-projects/cafe";
const CAFE_NOTES: ListNote[] = [
  note(`${CAFE}/overview.md`, { status: "in progress" }),
  note(`${CAFE}/lease.md`, { status: "to do", priority: "p0", owner: "@seyi", tags: ["setup"], due: "2026-10-02", estimate: "M" }, 5),
  note(`${CAFE}/photos.md`, { status: "to do", priority: "p2" }, 9),
  note(`${CAFE}/post.md`, { status: "to do", priority: "p3", owner: "Claude" }, 7),
  note(`${CAFE}/later.md`, { status: "backlog" }, 3),
  note(`${CAFE}/Someday.md`, { status: "Backlog", owner: "any agent" }, 4),
  note(`${CAFE}/kitchen/overview.md`, { status: "in progress", priority: "p1", owner: ["@sayo", "@seyi"], tags: ["kitchen"], estimate: "xl" }, 6),
  note(`${CAFE}/kitchen/oven.md`, { status: "finished", owner: "@sayo", tags: "kitchen" }, 6),
  note(`${CAFE}/kitchen/fridge.md`, { status: "finished", owner: "@shay's Claude" }, 6),
  note(`${CAFE}/kitchen/inspection.md`, { status: "to do", estimate: "S" }, 6),
  note(`${CAFE}/kitchen/layout.md`, {}, 6),
  note(`${CAFE}/opened.md`, { status: "finished" }, 2),
  note(`${CAFE}/budget.md`, {}, 8),
  note(`${CAFE}/research.md`, { owner: "@sayo" }, 1),
];
const CAFE_ENTRIES = [
  entry("file", `${CAFE}/overview.md`),
  entry("file", `${CAFE}/lease.md`),
  entry("file", `${CAFE}/photos.md`),
  entry("file", `${CAFE}/post.md`),
  entry("file", `${CAFE}/later.md`),
  entry("file", `${CAFE}/Someday.md`),
  entry("folder", `${CAFE}/kitchen`),
  entry("file", `${CAFE}/opened.md`),
  entry("file", `${CAFE}/budget.md`),
  entry("file", `${CAFE}/research.md`),
];
const items = folderItems(CAFE, CAFE_ENTRIES, CAFE_NOTES).items;

describe("tasks and notes", () => {
  test("rows run by priority, then newest, inside a group", () => {
    const grouped = groupFolderItems(items.filter((item) => item.status !== ""), "status", list);
    expect(grouped.find((group) => group.value === "to do")!.items.map((item) => item.path.split("/").pop())).toEqual([
      "lease.md",
      "photos.md",
      "post.md",
    ]);
  });

  test("a task folder counts only its subtasks, and holds its plain notes apart", () => {
    const kitchen = items.find((item) => item.path === `${CAFE}/kitchen`)!;
    expect(kitchen.progress).toEqual({ done: 2, total: 3 });
    const children = taskChildren(`${CAFE}/kitchen`, CAFE_NOTES);
    expect(children.subtasks.map((item) => item.path.split("/").pop()).sort()).toEqual(["fridge.md", "inspection.md", "oven.md"]);
    expect(children.notes.map((item) => item.label)).toEqual(["layout"]);
  });

  test("Make it a task writes the first status of Not started that is not backlog", () => {
    expect(makeItTaskStatus(list)).toBe("to do");
    expect(makeItTaskStatus({ "not-started": ["Backlog"], "in-progress": ["doing"], done: ["won"] })).toBe("Backlog");
    expect(makeItTaskStatus({ "not-started": ["backlog", "planned"], "in-progress": ["doing"], done: ["won"] })).toBe("planned");
  });
});
