/**
 * EVERY CHANGE TO A TASK IS PLANNED, NAMED, AND TAKEN BACK THE SAME WAY.
 *
 * The right-click menu, the selection bar and a drop all change a task
 * through these plans: a property is one frontmatter write that undoes to
 * exactly what the note held; a move to another project never lands on a
 * name already there; several plans are one change with one undo that puts
 * back everything that went, newest first. A drop says what it will do
 * before it is let go — including why the two-level rule refuses it.
 */

import { describe, expect, test } from "@jest/globals";
import type { FolderItem } from "../features/console/files/folderPage/model";
import { countTasks, planMoveToProject, planSet, runManyPlanned, taskRefOf, wordsValue } from "../features/console/files/folderPage/tasks/taskEdits";
import { dropZone, rowDrop, statusDrop } from "../features/console/files/folderPage/tasks/taskDrop";
import { taskMenuAction, taskMenuItems, type TaskMenuContext } from "../features/console/files/folderPage/tasks/taskMenu";
import {
  NO_PENDING,
  noteFromText,
  pendCreate,
  pendMove,
  pendRemove,
  settlePending,
  withPendingEntries,
  withPendingNotes,
} from "../features/console/files/folderPage/tasks/pendingNotes";
import { planPark, type TaskSnapshot, type TaskWriteIO } from "../features/console/files/folderPage/tasks/taskWrites";
import { statusMenu } from "../features/console/files/folderPage/statuses";

const P = "1-projects/cafe";

function item(path: string, kind: "note" | "folder", label: string, properties: Record<string, string | string[]> = {}): FolderItem {
  const status = typeof properties.status === "string" ? properties.status : "";
  return {
    path,
    kind,
    label,
    target: kind === "note" ? path : `${path}/overview.md`,
    creates: false,
    title: label,
    properties,
    lede: null,
    updatedAt: 1,
    status,
    priority: null,
    progress: null,
  };
}

const LEASE = item(`${P}/lease.md`, "note", "Sign the lease", { status: "to do", priority: "p1", tags: ["Setup"] });
const PHOTOS = item(`${P}/photos.md`, "note", "Take photos", { status: "to do" });
const KITCHEN = item(`${P}/kitchen`, "folder", "Get the kitchen ready", { status: "in progress" });
const OVEN = item(`${P}/kitchen/oven.md`, "note", "Order the oven", { status: "finished" });
const SNAPSHOT: TaskSnapshot = {
  folder: P,
  notes: [
    { path: `${P}/lease.md`, properties: LEASE.properties },
    { path: `${P}/photos.md`, properties: PHOTOS.properties },
    { path: `${P}/kitchen/overview.md`, properties: { status: "in progress" } },
    { path: `${P}/kitchen/oven.md`, properties: { status: "finished" } },
    { path: "1-projects/menu/lease.md", properties: {} },
  ],
};
const LIST = { "not-started": ["backlog", "to do"], "in-progress": ["in progress"], done: ["finished"] };

function recorder(failOn?: (call: string) => boolean) {
  const calls: string[] = [];
  const io: TaskWriteIO = {
    create: async (path) => void calls.push(`create ${path}`),
    move: async (from, to) => {
      calls.push(`move ${from} -> ${to}`);
      if (failOn?.(`move ${from} -> ${to}`)) throw new Error("no");
    },
    setProperties: async (path, changes) => {
      const call = `set ${path} ${JSON.stringify(changes)}`;
      calls.push(call);
      return failOn?.(call) ? "That change could not be saved." : null;
    },
    remove: async (path) => void calls.push(`remove ${path}`),
  };
  return { io, calls };
}

describe("a property change", () => {
  test("writes only what differs and undoes to exactly what the note held", async () => {
    const planned = planSet(LEASE, [["priority", "p0"], ["tags", wordsValue(["Setup"])]], "“Sign the lease” is Urgent now.", "Already Urgent.");
    expect(planned.ok && planned.plan.steps).toEqual([
      { kind: "set", path: `${P}/lease.md`, changes: [["priority", "p0"]], creates: false, previous: [["priority", "p1"]] },
    ]);
    const { io, calls } = recorder();
    const run = await runManyPlanned(io, [planned]);
    expect(run.ok && (await run.undo!())).toBeNull();
    expect(calls).toEqual([`set ${P}/lease.md [["priority","p0"]]`, `set ${P}/lease.md [["priority","p1"]]`]);
  });

  test("a change to what is already there is refused before anything is sent", () => {
    expect(planSet(LEASE, [["priority", "p1"]], "x", "“Sign the lease” is already High.")).toEqual({
      ok: false,
      problem: "“Sign the lease” is already High.",
    });
  });

  test("a key the note never had undoes to nothing, and a list is compared as a list", () => {
    const planned = planSet(PHOTOS, [["owner", wordsValue(["@sayo", "Claude"])]], "m", "u");
    expect(planned.ok && planned.plan.steps[0]).toMatchObject({ previous: [["owner", null]] });
    expect(wordsValue([])).toBeNull();
    expect(wordsValue(["@sayo"])).toBe("@sayo");
  });
});

describe("moving a task to another project", () => {
  test("lands under a free name there", () => {
    const planned = planMoveToProject(taskRefOf(LEASE), { path: "1-projects/menu", label: "Summer menu" }, SNAPSHOT);
    expect(planned.ok && planned.plan.steps).toEqual([{ kind: "move", from: `${P}/lease.md`, to: "1-projects/menu/lease 2.md" }]);
    expect(planned.ok && planned.plan.message).toBe("Moved “Sign the lease” to “Summer menu”.");
  });

  test("not into the project it is in, nor into itself", () => {
    expect(planMoveToProject(taskRefOf(LEASE), { path: P, label: "Café" }, SNAPSHOT).ok).toBe(false);
    expect(planMoveToProject(taskRefOf(KITCHEN), { path: `${P}/kitchen`, label: "k" }, SNAPSHOT).ok).toBe(false);
  });
});

describe("several at once", () => {
  test("one undo takes every change back, newest first; refused ones are skipped", async () => {
    const { io, calls } = recorder();
    const run = await runManyPlanned(io, [
      planPark(taskRefOf(LEASE), LIST),
      planPark(taskRefOf({ ...PHOTOS, status: "backlog" }), LIST),
      planPark(taskRefOf(KITCHEN), LIST),
    ]);
    expect(run).toMatchObject({ ok: true, done: 2, problem: null });
    expect(run.ok && (await run.undo!())).toBeNull();
    expect(calls).toEqual([
      `set ${P}/lease.md [["status","backlog"]]`,
      `set ${P}/kitchen/overview.md [["status","backlog"]]`,
      `set ${P}/kitchen/overview.md [["status","in progress"]]`,
      `set ${P}/lease.md [["status","to do"]]`,
    ]);
  });

  test("a failure stops the rest; the ones before it stand and it says how far it got", async () => {
    const { io } = recorder((call) => call.startsWith(`set ${P}/kitchen`));
    const run = await runManyPlanned(io, [planPark(taskRefOf(LEASE), LIST), planPark(taskRefOf(KITCHEN), LIST)]);
    expect(run).toMatchObject({ ok: true, done: 1, problem: "1 of 2 changed. That change could not be saved." });
  });

  test("when every one is refused, the first reason is the answer and nothing is sent", async () => {
    const { io, calls } = recorder();
    expect(await runManyPlanned(io, [planPark(taskRefOf({ ...LEASE, status: "backlog" }), LIST)])).toEqual({
      ok: false,
      problem: "“Sign the lease” is already in Backlog.",
    });
    expect(calls).toEqual([]);
    expect(countTasks(1)).toBe("1 task");
    expect(countTasks(3)).toBe("3 tasks");
  });
});

describe("a drop", () => {
  test("a row is three bands: a quarter above, the middle half, a quarter below", () => {
    expect([dropZone(2, 40), dropZone(20, 40), dropZone(38, 40), dropZone(5, 0)]).toEqual(["above", "middle", "below", "middle"]);
  });

  test("on a task's middle makes it a subtask, and says so before it is let go", () => {
    const verdict = rowDrop(PHOTOS, KITCHEN, "middle", SNAPSHOT);
    expect(verdict).toMatchObject({ kind: "plan", hint: "Make it a subtask of “Get the kitchen ready”" });
  });

  test("on a subtask's middle is refused, with the two-level reason", () => {
    expect(rowDrop(PHOTOS, OVEN, "middle", SNAPSHOT)).toEqual({
      kind: "refused",
      hint: "“Order the oven” is already a subtask, and a subtask can’t have subtasks of its own.",
    });
  });

  test("a task holding subtasks can't go under another", () => {
    expect(rowDrop(KITCHEN, LEASE, "middle", SNAPSHOT)).toMatchObject({ kind: "refused" });
  });

  test("between rows takes that row's status; a subtask there becomes a task of its own", () => {
    expect(rowDrop(LEASE, KITCHEN, "above", SNAPSHOT)).toEqual({ kind: "status", hint: "Move to In progress", status: "in progress" });
    expect(rowDrop(LEASE, PHOTOS, "below", SNAPSHOT)).toEqual({ kind: "none" });
    expect(rowDrop(OVEN, LEASE, "below", SNAPSHOT)).toMatchObject({ kind: "plan", hint: "Make it a task of its own" });
    expect(statusDrop(LEASE, "finished")).toMatchObject({ kind: "status", status: "finished" });
    expect(statusDrop(LEASE, "To Do")).toEqual({ kind: "none" });
  });
});

describe("what has just been written, drawn before the device catches up", () => {
  test("a new task shows at once, with the properties it was written with", () => {
    const note = noteFromText(`${P}/new.md`, "---\nstatus: to do\npriority: p0\n---\n\n# Buy cups\n", 5);
    const pending = pendCreate(NO_PENDING, note);
    expect(withPendingNotes([], pending)).toEqual([{ path: `${P}/new.md`, properties: { status: "to do", priority: "p0" }, updatedAt: 5, heading: "Buy cups" }]);
    expect(withPendingEntries(P, [], pending)).toEqual([{ kind: "file", path: `${P}/new.md`, name: "new.md", updatedAt: 5 }]);
  });

  test("a task turned into a folder is one row, the folder, not two", () => {
    const known = [{ path: `${P}/lease.md`, properties: { status: "to do" } }];
    const pending = pendMove(NO_PENDING, known, `${P}/lease.md`, `${P}/lease/overview.md`, 5);
    const rows = [{ kind: "file" as const, path: `${P}/lease.md`, name: "lease.md" }];
    expect(withPendingEntries(P, rows, pending).map((row) => [row.kind, row.path])).toEqual([["folder", `${P}/lease`]]);
    expect(withPendingNotes(known, pending).map((note) => note.path)).toEqual([`${P}/lease/overview.md`]);
  });

  test("taking that back leaves no empty folder drawn where the task was", () => {
    const known = [{ path: `${P}/lease.md`, properties: { status: "to do" } }];
    const rows = [{ kind: "file" as const, path: `${P}/lease.md`, name: "lease.md" }];
    const there = pendMove(NO_PENDING, known, `${P}/lease.md`, `${P}/lease/overview.md`, 5);
    const back = pendMove(there, withPendingNotes(known, there), `${P}/lease/overview.md`, `${P}/lease.md`, 6);
    expect(withPendingEntries(P, rows, back).map((row) => [row.kind, row.path])).toEqual([["file", `${P}/lease.md`]]);
    expect(withPendingNotes(known, back).map((note) => note.path)).toEqual([`${P}/lease.md`]);
  });

  test("a folder moved carries everything under it; a removal hides it", () => {
    const known = [
      { path: `${P}/kitchen/overview.md`, properties: {} },
      { path: `${P}/kitchen/oven.md`, properties: {} },
    ];
    const moved = pendMove(NO_PENDING, known, `${P}/kitchen`, `${P}/lease/kitchen`, 5);
    expect(withPendingNotes(known, moved).map((note) => note.path).sort()).toEqual([`${P}/lease/kitchen/oven.md`, `${P}/lease/kitchen/overview.md`]);
    expect(withPendingNotes(known, pendRemove(NO_PENDING, known, `${P}/kitchen`))).toEqual([]);
  });

  test("the device's own copy wins, and the overlay goes once it agrees", () => {
    const pending = pendCreate(NO_PENDING, noteFromText(`${P}/new.md`, "# x\n", 5));
    const real = { path: `${P}/new.md`, properties: { status: "to do" } };
    expect(withPendingNotes([real], pending)).toEqual([real]);
    const settled = settlePending(pending, [real], new Map([[P, [`${P}/new.md`]]]));
    expect(settled.notes.size + settled.entries.size).toBe(0);
    // Nothing to settle is the same object, so a caller can skip a render.
    expect(settlePending(pending, [], new Map())).toBe(pending);
  });
});

describe("the right-click menu", () => {
  const context: TaskMenuContext = {
    kind: "task",
    status: "to do",
    priority: "p1",
    owners: ["@sayo"],
    tags: ["Setup"],
    hasDue: false,
    isSubtask: false,
    hasSubtasks: false,
    statusSections: statusMenu(LIST),
    backlog: "backlog",
    nestTargets: [{ path: `${P}/kitchen`, label: "Get the kitchen ready" }],
    projects: [{ path: "1-projects/menu", label: "Summer menu" }],
    tagsInUse: ["Kitchen", "Setup"],
    me: "@seyi",
    ownerLabel: (value) => value,
    canCopyLink: true,
    canArchive: true,
    makeTaskLabel: "Make it a task",
  };
  const labels = (items: ReturnType<typeof taskMenuItems>) => items.map((each) => each.label);

  test("is the approved order, in the owner's words", () => {
    const items = taskMenuItems(context);
    expect(labels(items)).toEqual([
      "Status",
      "Priority",
      "Owners",
      "Assign to me",
      "Tags",
      "Due date",
      "Add a subtask",
      "Make it a subtask of…",
      "Move to Backlog",
      "Move to another project…",
      "Open",
      "Copy link",
      "Archive",
    ]);
    expect(labels(items[1]!.items!)).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
    expect(items[1]!.items!.find((each) => each.checked)?.label).toBe("High");
    expect(labels(items[0]!.items!)).toEqual(["Backlog", "To do", "In progress", "Finished"]);
    expect(JSON.stringify(items)).not.toMatch(/"label":"[^"]*\bp[0-3]\b/i);
    expect(labels(items[4]!.items!)).toEqual(["Setup", "Kitchen", "New tag…"]);
  });

  test("leaves out what cannot apply rather than greying it", () => {
    const subtask = labels(taskMenuItems({ ...context, isSubtask: true, backlog: null, projects: [], me: "@sayo", canCopyLink: false }));
    expect(subtask).not.toContain("Add a subtask");
    expect(subtask).toContain("Make it a task of its own");
    expect(subtask).not.toContain("Move to Backlog");
    expect(subtask).not.toContain("Move to another project…");
    expect(subtask).not.toContain("Assign to me");
    expect(subtask).not.toContain("Copy link");
    expect(labels(taskMenuItems({ ...context, hasSubtasks: true }))).not.toContain("Make it a subtask of…");
    expect(labels(taskMenuItems({ ...context, status: "Backlog" }))).not.toContain("Move to Backlog");
  });

  test("a plain note is offered Make it a task, Open, Copy link and Archive", () => {
    expect(labels(taskMenuItems({ ...context, kind: "note" }))).toEqual(["Make it a task", "Open", "Copy link", "Archive"]);
  });

  test("an id is read back as its action, splitting at the first colon only", () => {
    expect(taskMenuAction("status:to do")).toEqual({ kind: "status", value: "to do" });
    expect(taskMenuAction("priority:none")).toEqual({ kind: "priority", value: null });
    expect(taskMenuAction("priority:p9")).toBeNull();
    expect(taskMenuAction("nest:1-projects/a:b")).toEqual({ kind: "nest", path: "1-projects/a:b" });
    expect(taskMenuAction("due:next-week")).toEqual({ kind: "due", value: "next-week" });
    expect(taskMenuAction("park")).toEqual({ kind: "park" });
    expect(taskMenuAction("status")).toBeNull();
    expect(taskMenuAction("delete-everything")).toBeNull();
  });
});
