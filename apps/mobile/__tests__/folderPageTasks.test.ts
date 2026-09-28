/**
 * A PROJECT'S LIST IS ITS TASKS, THEN ITS NOTES.
 *
 * Decided by the owner on 2026-09-28 ("Projects for everyone"): anything with
 * a `status` is a task, and anything without one is a plain note — drawn in
 * its own Notes section, never as a "No status" task nobody started. Backlog
 * is a status, drawn first as a folded band; the Done group is folded at the
 * end. Priority (`p0`–`p3`) leads each row and orders it inside its group;
 * `owner:` may name several; `tags` and `due` are drawn short.
 *
 * Pure — `folderPage/taskProps.ts`, `listLayout.ts` and `showFilter.ts` take
 * the device's notes and decide nothing about drawing.
 */

import { describe, expect, test } from "@jest/globals";
import { defaultStatusList } from "../../mcp/src/lists.js";
import { folderItems, groupFolderItems, taskChildren, type FolderItem } from "../features/console/files/folderPage/model";
import { listLayout, makeItTaskStatus } from "../features/console/files/folderPage/listLayout";
import {
  chipCounts,
  filterMatch,
  ownerOptions,
  parseShowFilter,
  showFilterKey,
  tasksWithSubtasks,
  type OwnerWho,
} from "../features/console/files/folderPage/showFilter";
import { dueOf, dueWord, ownersOf, priorityOf, priorityWord, tagsOf } from "../features/console/files/folderPage/taskProps";
import type { StatusList } from "../features/console/files/folderPage/statuses";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry } from "../features/console/files/types";

const strip = (text: string): string => text.replace(/[\u2066-\u2069]/g, "");

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
  note(`${CAFE}/lease.md`, { status: "to do", priority: "p0", owner: "@seyi", tags: ["setup"], due: "2026-10-02" }, 5),
  note(`${CAFE}/photos.md`, { status: "to do", priority: "p2" }, 9),
  note(`${CAFE}/post.md`, { status: "to do", priority: "p3", owner: "Claude" }, 7),
  note(`${CAFE}/later.md`, { status: "backlog" }, 3),
  note(`${CAFE}/Someday.md`, { status: "Backlog", owner: "any agent" }, 4),
  note(`${CAFE}/kitchen/overview.md`, { status: "in progress", priority: "p1", owner: ["@sayo", "@seyi"] }, 6),
  note(`${CAFE}/kitchen/oven.md`, { status: "finished", owner: "@sayo" }, 6),
  note(`${CAFE}/kitchen/fridge.md`, { status: "finished", owner: "@shay's Claude" }, 6),
  note(`${CAFE}/kitchen/inspection.md`, { status: "to do" }, 6),
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
const names = (rows: readonly { item: FolderItem }[]) => rows.map((row) => row.item.path.split("/").pop());

describe("tasks and notes", () => {
  const layout = listLayout(items, list, CAFE_NOTES, null);
  const shape = layout.sections.map((section) => [strip(section.label), section.folded, section.total]);

  test("a child with no status is a note, below every task, and never a No status row", () => {
    expect(layout.notes.map((item) => item.path.split("/").pop())).toEqual(["budget.md", "research.md"]);
    expect(layout.sections.flatMap((section) => section.columns.map((column) => column.value))).not.toContain("");
  });

  test("Backlog is its own folded band first, the Done group a folded band last", () => {
    expect(shape).toEqual([
      ["Backlog", true, 2],
      ["To do", false, 3],
      ["In progress", false, 1],
      ["Finished", true, 1],
    ]);
    // Any spelling of backlog is the one band.
    expect(names(layout.sections[0].columns[0].rows)).toEqual(["Someday.md", "later.md"]);
  });

  test("rows run by priority, then newest, inside a group", () => {
    expect(names(layout.sections[1].columns[0].rows)).toEqual(["lease.md", "photos.md", "post.md"]);
    const grouped = groupFolderItems(items.filter((item) => item.status !== ""), "status", list);
    expect(grouped.find((group) => group.value === "to do")!.items.map((item) => item.path.split("/").pop())).toEqual([
      "lease.md",
      "photos.md",
      "post.md",
    ]);
  });

  test("a task folder holds its subtasks, then its plain notes, and counts only the subtasks", () => {
    const kitchen = layout.sections[2].columns[0].rows[0];
    expect(kitchen.item.progress).toEqual({ done: 2, total: 3 });
    expect(kitchen.subtasks.map((item) => item.path.split("/").pop()).sort()).toEqual(["fridge.md", "inspection.md", "oven.md"]);
    expect(kitchen.notes.map((item) => item.path.split("/").pop())).toEqual(["layout.md"]);
    expect(taskChildren(`${CAFE}/kitchen`, CAFE_NOTES).notes.map((item) => item.label)).toEqual(["layout"]);
  });

  test("a folder whose list has no backlog word has no Backlog band", () => {
    const own: StatusList = { "not-started": ["idea"], "in-progress": ["doing"], done: ["won"] };
    const layoutOwn = listLayout(folderItems("p", [entry("file", "p/a.md")], [note("p/a.md", { status: "idea" })]).items, own, [], null);
    expect(layoutOwn.sections.map((section) => strip(section.label))).toEqual(["Idea"]);
  });

  test("Make it a task writes the first status of Not started that is not backlog", () => {
    expect(makeItTaskStatus(list)).toBe("to do");
    expect(makeItTaskStatus({ "not-started": ["Backlog"], "in-progress": ["doing"], done: ["won"] })).toBe("Backlog");
    expect(makeItTaskStatus({ "not-started": ["backlog", "planned"], "in-progress": ["doing"], done: ["won"] })).toBe("planned");
  });
});

describe("the Show filter", () => {
  const me = new Set(["@seyi"]);
  const who: OwnerWho = {
    isMe: (owner) => me.has(owner.toLowerCase()) || owner.toLowerCase() === "@seyi's claude",
    isAgent: (owner) => ["claude", "any agent", "@shay's claude"].includes(owner.toLowerCase()),
    label: (owner) => owner,
  };
  const tasks = tasksWithSubtasks(items, CAFE_NOTES);

  test("counts every task, subtasks included, for its quick choices", () => {
    // No owner: photos, later, opened, inspection. Urgent: lease. Mine: lease, kitchen.
    expect(chipCounts(tasks, who)).toEqual({ noOwner: 4, urgent: 1, mine: 2 });
  });

  test("keeps a parent whose subtask matches, dimmed, with only the matching subtasks", () => {
    const layout = listLayout(items, list, CAFE_NOTES, filterMatch({ kind: "no-owner" }, who));
    expect(layout.sections.map((section) => [strip(section.label), section.shown, section.total])).toEqual([
      ["Backlog", 1, 2],
      ["To do", 1, 3],
      ["In progress", 1, 1],
      ["Finished", 1, 1],
    ]);
    const kitchen = layout.sections[2].columns[0].rows[0];
    expect(kitchen.dim).toBe(true);
    expect(kitchen.subtasks.map((item) => item.path.split("/").pop())).toEqual(["inspection.md"]);
    expect(kitchen.notes).toEqual([]);
    // Notes are not tasks, so a filter on tasks leaves them out.
    expect(layout.notes).toEqual([]);
  });

  test("a group with nothing matching is left out", () => {
    const layout = listLayout(items, list, CAFE_NOTES, filterMatch({ kind: "urgent" }, who));
    expect(layout.sections.map((section) => strip(section.label))).toEqual(["To do"]);
  });

  test("an owner matches any of several, and Mine includes my own agent", () => {
    const sayo = listLayout(items, list, CAFE_NOTES, filterMatch({ kind: "owner", owner: "@Sayo" }, who));
    expect(sayo.sections.map((section) => strip(section.label))).toEqual(["In progress"]);
    expect(sayo.sections[0].columns[0].rows[0].dim).toBe(false);
    expect(filterMatch({ kind: "everyone" }, who)).toBeNull();
  });

  test("the owner list offers no owner, me, then people and helpers in use, each with a count", () => {
    const options = ownerOptions(tasks, who, "");
    expect(options.none).toBe(4);
    expect(options.me).toBe(2);
    expect(options.people.map((row) => [row.label, row.count])).toEqual([["@sayo", 2]]);
    expect(options.agents.map((row) => [row.label, row.count])).toEqual([
      ["Claude", 1],
      ["@shay's Claude", 1],
      ["Any AI helper", 1],
    ]);
    expect(ownerOptions(tasks, who, "sha").agents.map((row) => row.label)).toEqual(["@shay's Claude"]);
  });

  test("is remembered as a word, and a word it cannot read is nothing", () => {
    for (const filter of [{ kind: "everyone" }, { kind: "mine" }, { kind: "no-owner" }, { kind: "urgent" }, { kind: "owner", owner: "@sayo" }] as const) {
      expect(parseShowFilter(showFilterKey(filter))).toEqual(filter);
    }
    expect(parseShowFilter("owner:")).toBeNull();
    expect(parseShowFilter("nonsense")).toBeNull();
    expect(parseShowFilter(null)).toBeNull();
  });
});
