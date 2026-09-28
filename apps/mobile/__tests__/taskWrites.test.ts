/**
 * A PROJECT'S TASKS ARE FILES, AND EVERY WRITE IS PLANNED BEFORE IT IS SENT.
 *
 * Adding a task writes one note; a subtask of a one-note task first moves it
 * to `task/overview.md`; nesting and un-nesting are moves; parking is one
 * frontmatter line. These pin what is planned (names, text, refusals) and
 * what running a plan does when a step fails and when it is undone.
 */

import { describe, expect, test } from "@jest/globals";
import { noteProperties } from "../../mcp/src/lists.js";
import {
  backlogWord,
  hasSubtasks,
  newTaskText,
  planAddNote,
  planAddSubtask,
  planNest,
  planNewTask,
  planPark,
  planUnnest,
  runPlanned,
  runTaskPlan,
  taskWriteIO,
  type TaskRef,
  type TaskSnapshot,
  type TaskWriteIO,
} from "../features/console/files/folderPage/tasks/taskWrites";
import { cleanTitle, taskStem, uniqueStem } from "../features/console/files/folderPage/tasks/taskNames";

const P = "1-projects/cafe";

const note = (path: string, properties: Record<string, string | string[]> = {}) => ({ path, properties });

/** A café project: a one-note task, a folder task with two subtasks, and a plain note. */
const SNAPSHOT: TaskSnapshot = {
  folder: P,
  notes: [
    note(`${P}/overview.md`, { status: "active" }),
    note(`${P}/Sign the lease.md`, { status: "to do" }),
    note(`${P}/Kitchen/overview.md`, { status: "in progress" }),
    note(`${P}/Kitchen/Test the oven.md`, { status: "to do" }),
    note(`${P}/Kitchen/Checklist/overview.md`, { status: "finished" }),
    note(`${P}/Kitchen/recipes.md`),
    note(`${P}/Photos/overview.md`, { status: "to do" }),
    note(`${P}/Photos/shot list.md`),
    note(`${P}/Ideas.md`),
  ],
  paths: [`${P}/floorplan.png`],
};

const task = (path: string, kind: "note" | "folder", label: string, status = "to do"): TaskRef => ({
  path,
  kind,
  target: kind === "note" ? path : `${path}/overview.md`,
  creates: false,
  label,
  status,
});

const LEASE = task(`${P}/Sign the lease.md`, "note", "Sign the lease");
const KITCHEN = task(`${P}/Kitchen`, "folder", "Get the kitchen ready", "in progress");
const OVEN = task(`${P}/Kitchen/Test the oven.md`, "note", "Test the oven");
const CHECKLIST = task(`${P}/Kitchen/Checklist`, "folder", "Checklist", "finished");
const PHOTOS = task(`${P}/Photos`, "folder", "Take photos");

const LIST = { "not-started": ["backlog", "to do"], "in-progress": ["in progress"], done: ["finished"] };

/** An IO that records every call and can be told to fail one. */
function recorder(failOn?: (call: string) => boolean, withRemove = true) {
  const calls: string[] = [];
  const act = async (call: string, answer: string | null = null) => {
    calls.push(call);
    if (failOn?.(call)) throw new Error("storage said no");
    return answer;
  };
  const io: TaskWriteIO = {
    create: (path, text) => act(`create ${path}\n${text}`),
    move: (from, to) => act(`move ${from} -> ${to}`),
    setProperties: async (path, changes, options) => {
      const call = `set ${path} ${JSON.stringify(changes)}${options?.create ? " create" : ""}`;
      calls.push(call);
      return failOn?.(call) ? "That change could not be saved." : null;
    },
    ...(withRemove ? { remove: (path: string) => act(`remove ${path}`) } : {}),
  };
  return { io, calls };
}

describe("a new task's note", () => {
  test("frontmatter the list reader reads back, then the title as its heading", () => {
    const made = newTaskText({ title: "Order the coffee beans", status: "to do", priority: "p1", owners: ["@sayo"], tags: ["setup", "bug"], due: "2026-10-03" });
    expect("text" in made).toBe(true);
    const text = (made as { text: string }).text;
    expect(text).toBe('---\nstatus: to do\npriority: p1\nowner: "@sayo"\ntags: [setup, bug]\ndue: 2026-10-03\n---\n\n# Order the coffee beans\n');
    expect(noteProperties(text)).toEqual({ status: "to do", priority: "p1", owner: "@sayo", tags: ["setup", "bug"], due: "2026-10-03" });
  });

  test("several owners are a list; one is a line; nothing unset is written", () => {
    const two = (newTaskText({ title: "x", status: "to do", owners: ["@sayo", "Claude", "@SAYO"] }) as { text: string }).text;
    expect(noteProperties(two).owner).toEqual(["@sayo", "Claude"]);
    const bare = (newTaskText({ title: "x", status: "to do", owners: [], tags: [], priority: null, due: null }) as { text: string }).text;
    expect(bare).toBe("---\nstatus: to do\n---\n\n# x\n");
  });

  test("refuses no title, no status, a priority off the scale, a day that isn't one, a list word it can't write", () => {
    expect(newTaskText({ title: "  \n\t ", status: "to do" })).toEqual({ problem: "Give the task a name." });
    expect(newTaskText({ title: "x", status: " " })).toEqual({ problem: "A task needs a status." });
    expect(newTaskText({ title: "x", status: "to do", priority: "p9" as never })).toHaveProperty("problem");
    expect(newTaskText({ title: "x", status: "to do", due: "2026-02-30" })).toHaveProperty("problem");
    expect(newTaskText({ title: "x", status: "to do", tags: ["a, b"] })).toHaveProperty("problem");
    // An agent owner with an apostrophe cannot sit in a list the reader splits.
    expect(newTaskText({ title: "x", status: "to do", owners: ["@sayo", "@shay's Claude"] })).toHaveProperty("problem");
  });

  test("a title that tries to write frontmatter or a second line stays one heading", () => {
    const text = (newTaskText({ title: "Plan\n---\nstatus: done", status: "to do" }) as { text: string }).text;
    expect(noteProperties(text)).toEqual({ status: "to do" });
    expect(text.endsWith("# Plan --- status: done\n")).toBe(true);
  });
});

describe("a new task's name", () => {
  const existing = SNAPSHOT.notes.map((each) => each.path).concat(SNAPSHOT.paths ?? []);

  test("is the title, in the folder, as a note", () => {
    const planned = planNewTask({ folder: P, title: "Order the coffee beans", status: "to do" }, existing);
    expect(planned.ok && planned.plan.path).toBe(`${P}/Order the coffee beans.md`);
    expect(planned.ok && planned.plan.steps.map((step) => step.kind)).toEqual(["create"]);
    expect(planned.ok && planned.plan.message).toBe("Added “Order the coffee beans”.");
  });

  test("never collides, ignoring case, with a note or a folder of that name", () => {
    const lease = planNewTask({ folder: P, title: "sign the LEASE", status: "to do" }, existing);
    expect(lease.ok && lease.plan.path).toBe(`${P}/sign the LEASE 2.md`);
    const kitchen = planNewTask({ folder: P, title: "Kitchen", status: "to do" }, existing);
    expect(kitchen.ok && kitchen.plan.path).toBe(`${P}/Kitchen 2.md`);
    const twice = planNewTask({ folder: P, title: "Kitchen", status: "to do" }, [...existing, `${P}/Kitchen 2.md`]);
    expect(twice.ok && twice.plan.path).toBe(`${P}/Kitchen 3.md`);
  });

  test("the same name in another Unicode form is the same name", () => {
    const planned = planNewTask({ folder: P, title: "Café", status: "to do" }, [`${P}/Cafe\u0301.md`]);
    expect(planned.ok && planned.plan.path).toBe(`${P}/Café 2.md`);
  });

  test("a name Windows can't hold is moved along, so an export keeps it", () => {
    const planned = planNewTask({ folder: P, title: "con", status: "to do" }, []);
    expect(planned.ok && planned.plan.path).toBe(`${P}/con 2.md`);
  });

  test("is never a front note's, which would become the project's own description", () => {
    for (const title of ["Overview", "index", "README", "privacy"]) {
      const planned = planNewTask({ folder: P, title, status: "to do" }, existing);
      expect(planned.ok && planned.plan.path).toBe(`${P}/${title} 2.md`);
    }
  });

  test("cannot climb out of the folder or hide as plumbing", () => {
    const cases: [string, string][] = [
      ["../../secrets", "secrets"],
      ["../..", "Task"],
      ["a/b\\c", "a b c"],
      [".history", "history"],
      ["///", "Task"],
      ["what? now: <yes>|*", "what now yes"],
      ["trailing dots...", "trailing dots"],
      ["tab\there\u0000null", "tab here null"],
    ];
    for (const [title, stem] of cases) {
      const planned = planNewTask({ folder: P, title, status: "to do" }, existing);
      expect(planned.ok && planned.plan.path).toBe(`${P}/${stem}.md`);
      expect(planned.ok && planned.plan.path.split("/").length).toBe(3);
    }
  });

  test("keeps unicode, and is cut at a character, not inside one", () => {
    expect(taskStem("Café opening ☕")).toBe("Café opening ☕");
    expect(taskStem("Café")).toBe("Café");
    const long = "🍩".repeat(100);
    expect(Array.from(taskStem(long))).toHaveLength(80);
    expect(taskStem(long)).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(cleanTitle("  a   b  ")).toBe("a b");
  });

  test("uniqueStem is bounded", () => {
    const taken = new Set(Array.from({ length: 1200 }, (_, n) => (n < 2 ? "x.md" : `x ${n}.md`)));
    expect(uniqueStem("x", taken)).toMatch(/^x \d{4,}$/);
  });
});

describe("adding a subtask", () => {
  test("inside a folder task, next to its other subtasks", () => {
    const planned = planAddSubtask(KITCHEN, { title: "Test the oven", status: "to do" }, SNAPSHOT);
    expect(planned.ok && planned.plan.steps).toEqual([expect.objectContaining({ kind: "create", path: `${P}/Kitchen/Test the oven 2.md` })]);
    expect(planned.ok && planned.plan.message).toBe("Added “Test the oven” to “Get the kitchen ready”.");
  });

  test("to a one-note task: it becomes a folder first, then the subtask goes in", () => {
    const planned = planAddSubtask(LEASE, { title: "Read the small print", status: "to do" }, SNAPSHOT);
    expect(planned.ok && planned.plan.steps.map((step) => (step.kind === "move" ? `move ${step.from} -> ${step.to}` : `${step.kind} ${"path" in step ? step.path : ""}`))).toEqual([
      `move ${P}/Sign the lease.md -> ${P}/Sign the lease/overview.md`,
      `create ${P}/Sign the lease/Read the small print.md`,
    ]);
  });

  test("a subtask called Overview doesn't take the converted task's place", () => {
    const planned = planAddSubtask(LEASE, { title: "overview", status: "to do" }, SNAPSHOT);
    expect(planned.ok && planned.plan.path).toBe(`${P}/Sign the lease/overview 2.md`);
  });

  test("refused under a subtask: two levels and no deeper", () => {
    const planned = planAddSubtask(OVEN, { title: "Preheat", status: "to do" }, SNAPSHOT);
    expect(planned).toEqual({ ok: false, problem: "“Test the oven” is already a subtask, and a subtask can’t have subtasks of its own." });
    expect(planAddSubtask(CHECKLIST, { title: "x", status: "to do" }, SNAPSHOT).ok).toBe(false);
  });

  test("refused when a folder of the task's name is already beside it", () => {
    const crowded = { ...SNAPSHOT, paths: [`${P}/sign the lease/photo.png`] };
    const planned = planAddSubtask(LEASE, { title: "x", status: "to do" }, crowded);
    expect(planned.ok).toBe(false);
  });
});

describe("adding a note to a task", () => {
  const steps = (planned: ReturnType<typeof planAddNote>) =>
    planned.ok ? planned.plan.steps.map((step) => (step.kind === "move" ? `move ${step.from} -> ${step.to}` : step.kind === "create" ? `create ${step.path}\n${step.text}` : "set")) : planned.problem;

  test("goes in a folder task as a plain note: a heading and no status, so it is not a subtask", () => {
    const planned = planAddNote(KITCHEN, "Oven comparison", SNAPSHOT);
    expect(steps(planned)).toEqual([`create ${P}/Kitchen/Oven comparison.md\n# Oven comparison\n`]);
    expect(planned.ok && planned.plan.message).toBe("Added the note “Oven comparison” to “Get the kitchen ready”.");
    expect(planned.ok && planned.plan.touched).toEqual([P, `${P}/Kitchen`]);
  });

  test("turns a one-note task into a folder first, the same way a first subtask does", () => {
    expect(steps(planAddNote(LEASE, "Questions for the landlord", SNAPSHOT))).toEqual([
      `move ${P}/Sign the lease.md -> ${P}/Sign the lease/overview.md`,
      `create ${P}/Sign the lease/Questions for the landlord.md\n# Questions for the landlord\n`,
    ]);
  });

  test("a subtask may hold notes too, one level down and no deeper", () => {
    expect(steps(planAddNote(OVEN, "Temperatures", SNAPSHOT))).toEqual([
      `move ${P}/Kitchen/Test the oven.md -> ${P}/Kitchen/Test the oven/overview.md`,
      `create ${P}/Kitchen/Test the oven/Temperatures.md\n# Temperatures\n`,
    ]);
    const deeper = task(`${P}/Kitchen/Checklist/Wipe.md`, "note", "Wipe");
    expect(planAddNote(deeper, "x", SNAPSHOT)).toEqual({ ok: false, problem: "“Wipe” isn’t a task of this project." });
    expect(planAddNote(task("2-areas/x.md", "note", "Elsewhere"), "x", SNAPSHOT).ok).toBe(false);
  });

  test("never takes a name already there, nor the converted task's own", () => {
    const planned = planAddNote(KITCHEN, "recipes", SNAPSHOT);
    expect(planned.ok && planned.plan.path).toBe(`${P}/Kitchen/recipes 2.md`);
    expect(planAddNote(LEASE, "Overview", SNAPSHOT).ok && (planAddNote(LEASE, "Overview", SNAPSHOT) as { plan: { path: string } }).plan.path).toBe(
      `${P}/Sign the lease/Overview 2.md`,
    );
  });

  test("a title that tries to write frontmatter stays one heading, and no title is refused", () => {
    const planned = planAddNote(KITCHEN, "Plan\n---\nstatus: done", SNAPSHOT);
    const text = planned.ok && planned.plan.steps[0]!.kind === "create" ? planned.plan.steps[0]!.text : "";
    expect(noteProperties(text)).toEqual({});
    expect(planAddNote(KITCHEN, " \n ", SNAPSHOT)).toEqual({ ok: false, problem: "Give the note a name." });
  });

  test("undone, the note goes to the trash and a converted task moves back", async () => {
    const { io, calls } = recorder();
    const run = await runPlanned(io, planAddNote(LEASE, "Keys", SNAPSHOT));
    expect(run.ok && (await run.undo!())).toBeNull();
    expect(calls.slice(2)).toEqual([`remove ${P}/Sign the lease/Keys.md`, `move ${P}/Sign the lease/overview.md -> ${P}/Sign the lease.md`]);
  });
});

describe("nesting a task under another", () => {
  test("a note under a folder task is a move into it", () => {
    const planned = planNest(LEASE, PHOTOS, SNAPSHOT);
    expect(planned.ok && planned.plan.steps).toEqual([{ kind: "move", from: `${P}/Sign the lease.md`, to: `${P}/Photos/Sign the lease.md` }]);
    expect(planned.ok && planned.plan.message).toBe("Made “Sign the lease” a subtask of “Take photos”.");
  });

  test("onto a one-note task converts it first", () => {
    const planned = planNest(PHOTOS, LEASE, SNAPSHOT);
    expect(planned.ok && planned.plan.steps).toEqual([
      { kind: "move", from: `${P}/Sign the lease.md`, to: `${P}/Sign the lease/overview.md` },
      { kind: "move", from: `${P}/Photos`, to: `${P}/Sign the lease/Photos` },
    ]);
  });

  test("a subtask can move to another task, under a free name", () => {
    const crowded = { ...SNAPSHOT, notes: [...SNAPSHOT.notes, note(`${P}/Photos/Test the oven.md`, { status: "to do" })] };
    const planned = planNest(OVEN, PHOTOS, crowded);
    expect(planned.ok && planned.plan.path).toBe(`${P}/Photos/Test the oven 2.md`);
  });

  test("refusals: itself, inside itself, onto a subtask, carrying subtasks, already there", () => {
    expect(planNest(KITCHEN, KITCHEN, SNAPSHOT).ok).toBe(false);
    expect(planNest(KITCHEN, CHECKLIST, SNAPSHOT)).toEqual({ ok: false, problem: "“Get the kitchen ready” can’t be a subtask of itself." });
    expect(planNest(LEASE, OVEN, SNAPSHOT)).toEqual({ ok: false, problem: "“Test the oven” is already a subtask, and a subtask can’t have subtasks of its own." });
    expect(planNest(KITCHEN, PHOTOS, SNAPSHOT)).toEqual({ ok: false, problem: "“Get the kitchen ready” has subtasks of its own, so it can’t go under another task." });
    expect(planNest(OVEN, KITCHEN, SNAPSHOT)).toEqual({ ok: false, problem: "“Test the oven” is already a subtask of “Get the kitchen ready”." });
    expect(planNest(task("2-areas/x.md", "note", "x"), PHOTOS, SNAPSHOT).ok).toBe(false);
  });

  test("a folder task holding only plain notes may nest", () => {
    expect(hasSubtasks(`${P}/Photos`, SNAPSHOT.notes)).toBe(false);
    expect(hasSubtasks(`${P}/Kitchen`, SNAPSHOT.notes)).toBe(true);
    expect(planNest(PHOTOS, task(`${P}/Kitchen`, "folder", "Kitchen"), SNAPSHOT).ok).toBe(true);
  });
});

describe("un-nesting and parking", () => {
  test("a subtask moves up into the project", () => {
    const planned = planUnnest(OVEN, SNAPSHOT);
    expect(planned.ok && planned.plan.steps).toEqual([{ kind: "move", from: `${P}/Kitchen/Test the oven.md`, to: `${P}/Test the oven.md` }]);
    expect(planUnnest(LEASE, SNAPSHOT).ok).toBe(false);
  });

  test("a subtask whose name the project already has comes up under a free one", () => {
    const planned = planUnnest(task(`${P}/Kitchen/Ideas.md`, "note", "Ideas"), SNAPSHOT);
    expect(planned.ok && planned.plan.path).toBe(`${P}/Ideas 2.md`);
  });

  test("parking writes the folder's own Backlog word to the task's front note", () => {
    const planned = planPark(KITCHEN, { ...LIST, "not-started": ["Backlog", "to do"] });
    expect(planned.ok && planned.plan.steps).toEqual([
      { kind: "set", path: `${P}/Kitchen/overview.md`, changes: [["status", "Backlog"]], creates: false, previous: [["status", "in progress"]] },
    ]);
    expect(planPark(task(`${P}/x.md`, "note", "x", "backlog"), LIST)).toEqual({ ok: false, problem: "“x” is already in Backlog." });
    expect(planPark(LEASE, { "not-started": ["to do"], "in-progress": ["doing"], done: ["done"] })).toEqual({ ok: false, problem: "This project has no Backlog." });
    expect(backlogWord(LIST)).toBe("backlog");
  });
});

describe("running a plan", () => {
  test("sends the steps in order and undoes them in reverse", async () => {
    const { io, calls } = recorder();
    const run = await runPlanned(io, planAddSubtask(LEASE, { title: "Read it", status: "to do" }, SNAPSHOT));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.path).toBe(`${P}/Sign the lease/Read it.md`);
    expect(run.touched).toEqual([P, `${P}/Sign the lease`]);
    expect(calls.map((call) => call.split("\n")[0])).toEqual([
      `move ${P}/Sign the lease.md -> ${P}/Sign the lease/overview.md`,
      `create ${P}/Sign the lease/Read it.md`,
    ]);
    expect(await run.undo!()).toBeNull();
    expect(calls.slice(2)).toEqual([`remove ${P}/Sign the lease/Read it.md`, `move ${P}/Sign the lease/overview.md -> ${P}/Sign the lease.md`]);
  });

  test("a step that fails takes back the ones before it and says why", async () => {
    const { io, calls } = recorder((call) => call.startsWith("create"));
    const run = await runPlanned(io, planAddSubtask(LEASE, { title: "Read it", status: "to do" }, SNAPSHOT));
    expect(run).toEqual({ ok: false, problem: "That did not work. Try again." });
    expect(calls.at(-1)).toBe(`move ${P}/Sign the lease/overview.md -> ${P}/Sign the lease.md`);
  });

  test("a refusal is returned without a single write", async () => {
    const { io, calls } = recorder();
    expect(await runPlanned(io, planNest(LEASE, OVEN, SNAPSHOT))).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  test("parking undoes to the status it had; a created front note is removed instead", async () => {
    const { io, calls } = recorder();
    const run = await runPlanned(io, planPark(KITCHEN, LIST));
    expect(run.ok && (await run.undo!())).toBeNull();
    expect(calls).toEqual([
      `set ${P}/Kitchen/overview.md [["status","backlog"]]`,
      `set ${P}/Kitchen/overview.md [["status","in progress"]]`,
    ]);
    const bare = recorder();
    const fresh = { ...KITCHEN, creates: true, status: "" };
    const made = await runPlanned(bare.io, planPark(fresh, LIST));
    expect(made.ok && (await made.undo!())).toBeNull();
    expect(bare.calls).toEqual([`set ${P}/Kitchen/overview.md [["status","backlog"]] create`, `remove ${P}/Kitchen/overview.md`]);
  });

  test("a refused property write is the problem, and nothing is left behind", async () => {
    const { io } = recorder((call) => call.startsWith("set"));
    expect(await runPlanned(io, planPark(KITCHEN, LIST))).toEqual({ ok: false, problem: "That change could not be saved." });
  });

  test("without a way to remove a note, a create has no undo — rather than a false one", async () => {
    const { io } = recorder(undefined, false);
    const planned = planNewTask({ folder: P, title: "x", status: "to do" }, []);
    const run = planned.ok ? await runTaskPlan(io, planned.plan) : null;
    expect(run?.ok && run.undo).toBeNull();
  });

  test("the console's actions become the IO: a create has no version, so it never replaces a note", async () => {
    const sent: unknown[] = [];
    const io = taskWriteIO({
      workspaceId: "ws_test",
      writeNote: async (args) => sent.push(["write", args]),
      moveEntry: async (args) => sent.push(["move", args]),
      trashEntry: async (args) => sent.push(["trash", args]),
      setProperties: async () => null,
    })!;
    const run = await runPlanned(io, planAddSubtask(LEASE, { title: "Read it", status: "to do" }, SNAPSHOT));
    expect(run.ok && (await run.undo!())).toBeNull();
    expect(sent).toEqual([
      ["move", { workspaceId: "ws_test", from: `${P}/Sign the lease.md`, to: `${P}/Sign the lease/overview.md` }],
      ["write", { workspaceId: "ws_test", path: `${P}/Sign the lease/Read it.md`, text: "---\nstatus: to do\n---\n\n# Read it\n" }],
      ["trash", { workspaceId: "ws_test", path: `${P}/Sign the lease/Read it.md` }],
      ["move", { workspaceId: "ws_test", from: `${P}/Sign the lease/overview.md`, to: `${P}/Sign the lease.md` }],
    ]);
    expect(taskWriteIO({ workspaceId: "ws_test", writeNote: async () => null, moveEntry: async () => null, setProperties: undefined })).toBeNull();
  });
});
