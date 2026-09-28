/**
 * @jest-environment jsdom
 */

/**
 * A TASK OPENS BESIDE THE LIST, NOT INSTEAD OF IT.
 *
 * The approved side panel (owner, 2026-09-28): on a desktop page, pressing a
 * task — a List row or a Board card — opens it on the right: where it is,
 * its name, Status, Priority, Owners, Tags and Due as one-click values, its
 * subtasks with dots that tick them off, and the notes in it, with "+ Add
 * subtask" and "+ Add a note". Expand goes where pressing used to; ✕ and
 * Escape close it. On a phone pressing still opens the page. A member reads
 * every value and has nothing to press that would write. Notes, projects and
 * the body are `sidePeek.test.ts`'s.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

// What is under test is the panel around the note's words, not CodeMirror's own DOM.
jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: { value: string; editable: boolean }) =>
    require("react").createElement("div", { "data-testid": "task-panel-body-editor", "data-editable": String(props.editable) }, props.value),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { isoDay } from "../features/console/files/folderPage/tasks/taskWords";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { act } from "react";
import { CAFE, NOTES, all, host, key, mount, one, press, strip, type, unmountAll, windowOf, type Toast, type Write } from "./projectPage/fixtures";

beforeEach(() => {
  windowOf(1280);
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});
afterEach(unmountAll);

const row = (name: string) => all("folder-item").find((node) => strip(node.textContent).includes(name))!;
const panel = () => one("task-panel");
const value = (name: string) => strip(one(`task-panel-${name}`).textContent);

async function openTask(name: string, writes: Write[] | null = [], files: string[] = []) {
  const mounted = await mount(host(writes, { files }));
  await press(row(name));
  return mounted;
}

describe("the side panel", () => {
  test("a task opens beside the list, with where it is, its name and its values in words", async () => {
    const { selected } = await openTask("Get the kitchen ready");
    expect(selected).toEqual([]);
    expect(all("folder-groups")).toHaveLength(1);
    expect(strip(one("task-panel-crumb").textContent)).toContain("Café opening");
    expect(strip(one("task-panel-title").textContent)).toBe("Get the kitchen ready");
    expect(value("status")).toContain("in progress");
    expect(value("priority")).toContain("High");
    expect(value("owners")).toMatch(/@sayo.*@seyi/);
    expect(value("tags")).toMatch(/Kitchen.*Suppliers/);
    expect(value("due")).toContain("No due date");
    expect(strip(panel().textContent)).not.toMatch(/\bp[0-3]\b|frontmatter|markdown/i);
    // The row it came from is marked while it is open.
    expect(row("Get the kitchen ready").getAttribute("aria-current")).toBe("true");
  });

  test("Expand goes where pressing the row used to; ✕ and Escape close it", async () => {
    const { selected } = await openTask("Get the kitchen ready");
    await press(one("task-panel-expand"));
    expect(selected).toEqual([`${CAFE}/kitchen`]);
    await press(one("task-panel-close"));
    expect(all("task-panel")).toHaveLength(0);
    await press(row("Sign the lease"));
    expect(strip(one("task-panel-title").textContent)).toBe("Sign the lease");
    await key(document, "Escape");
    expect(all("task-panel")).toHaveLength(0);
  });

  test("subtasks say how many are done, and a dot ticks one off or back", async () => {
    const writes: Write[] = [];
    await openTask("Get the kitchen ready", writes);
    expect(strip(one("task-panel-subtasks-head").textContent)).toBe("Subtasks · 2 of 3 done");
    const subtasks = all("task-panel-subtask").map((node) => strip(node.textContent));
    expect(subtasks).toEqual([expect.stringContaining("Order the oven"), expect.stringContaining("Compare fridge prices"), expect.stringContaining("Book the health inspection")]);
    const dots = all("task-panel-tick");
    expect(dots.map((node) => node.getAttribute("aria-label"))).toEqual(["Mark not done", "Mark not done", "Mark done"]);
    await press(dots[0]);
    await press(dots[2]);
    // Unticked, it is work to do now — not Backlog.
    expect(writes).toEqual([
      [`${CAFE}/kitchen/oven.md`, "status", "to do", undefined],
      [`${CAFE}/kitchen/inspection.md`, "status", "finished", undefined],
    ]);
  });

  test("a subtask's name opens it in the panel, under the task it belongs to", async () => {
    await openTask("Get the kitchen ready");
    await press(one("task-panel-subtask-open"));
    expect(strip(one("task-panel-title").textContent)).toBe("Order the oven");
    expect(strip(one("task-panel-crumb").textContent)).toMatch(/Café opening.*Get the kitchen ready/);
    // A subtask can't have subtasks: two levels and no deeper.
    expect(all("task-panel-subtasks-head")).toHaveLength(0);
    await press(one("task-panel-crumb-parent"));
    expect(strip(one("task-panel-title").textContent)).toBe("Get the kitchen ready");
  });

  test("priority, due and tags are one press each, in words", async () => {
    const writes: Write[] = [];
    await openTask("Get the kitchen ready", writes);
    await press(one("task-panel-priority-button"));
    expect(strip(one("menu-root").textContent)).toMatch(/Urgent.*High.*Medium.*Low.*No priority/);
    await press(one("menu-item-p0"));
    await press(one("task-panel-due-button"));
    await press(one("menu-item-today"));
    await press(all("task-panel-tag-remove")[0]);
    expect(writes).toEqual([
      [`${CAFE}/kitchen/overview.md`, "priority", "p0", undefined],
      [`${CAFE}/kitchen/overview.md`, "due", isoDay(new Date()), undefined],
      [`${CAFE}/kitchen/overview.md`, "tags", ["Suppliers"], undefined],
    ]);
  });

  test("an owner is taken off by name, and the rest stay", async () => {
    const writes: Write[] = [];
    await openTask("Get the kitchen ready", writes);
    const remove = all("task-panel-owner-remove");
    expect(remove.map((node) => node.getAttribute("aria-label"))).toEqual(["Remove @sayo", "Remove @seyi"]);
    await press(remove[1]);
    expect(writes).toEqual([[`${CAFE}/kitchen/overview.md`, "owner", "@sayo", undefined]]);
  });

  test("the notes in a task are listed, and one opens here in its place", async () => {
    const { selected } = await openTask("Get the kitchen ready");
    expect(strip(one("task-panel-notes-head").textContent)).toBe("Notes · 1");
    await press(one("task-panel-note"));
    expect(selected).toEqual([]);
    expect(strip(one("task-panel-title").textContent)).toBe("Kitchen layout sketch");
    expect(strip(one("task-panel-crumb").textContent)).toMatch(/Café opening.*Get the kitchen ready/);
  });

  test("+ Add subtask on a one-note task makes it a folder first, then writes the subtask", async () => {
    const files: string[] = [];
    await openTask("Sign the lease", [], files);
    await press(one("task-panel-add-subtask"));
    await type(one("quick-add-title"), "Read the small print");
    await key(one("quick-add-title"), "Enter");
    expect(files).toEqual([
      `move ${CAFE}/lease.md -> ${CAFE}/lease/overview.md`,
      `create ${CAFE}/lease/Read the small print.md\n---\nstatus: to do\n---\n\n# Read the small print\n`,
    ]);
    // Still open, on the task it became, and a second subtask goes in without converting it again.
    expect(strip(one("task-panel-title").textContent)).toBe("Sign the lease");
    await type(one("quick-add-title"), "Get the keys");
    await key(one("quick-add-title"), "Enter");
    expect(files[2]).toBe(`create ${CAFE}/lease/Get the keys.md\n---\nstatus: to do\n---\n\n# Get the keys\n`);
  });

  test("a subtask added here is drawn at once, in the List too, and one Undo takes it and the folder back", async () => {
    const files: string[] = [];
    const toasts: Toast[] = [];
    await mount(host([], { files, toasts }));
    await press(row("Sign the lease"));
    await press(one("task-panel-add-subtask"));
    await type(one("quick-add-title"), "Read the small print");
    await key(one("quick-add-title"), "Enter");
    // The same road as the List's own "+ Subtask": drawn before any reload, and said with an Undo.
    expect(all("task-panel-subtask").map((node) => strip(node.textContent))).toEqual([expect.stringContaining("Read the small print")]);
    expect(strip(row("Sign the lease").textContent)).toContain("0 of 1 done");
    expect(toasts.at(-1)?.undo).toBeDefined();
    await act(async () => toasts.at(-1)!.undo!());
    await act(async () => undefined);
    expect(files.slice(2)).toEqual([`remove ${CAFE}/lease/Read the small print.md`, `move ${CAFE}/lease/overview.md -> ${CAFE}/lease.md`]);
    expect(toasts.at(-1)!.message).toBe("Undone.");
  });

  test("+ Add a note writes a plain note in the task", async () => {
    const files: string[] = [];
    await openTask("Get the kitchen ready", [], files);
    await press(one("task-panel-add-note"));
    expect(one("quick-add-title").getAttribute("placeholder")).toBe("Name the note…");
    await type(one("quick-add-title"), "Oven comparison");
    await key(one("quick-add-title"), "Enter");
    expect(files).toEqual([`create ${CAFE}/kitchen/Oven comparison.md\n# Oven comparison\n`]);
  });

  test("a member reads every value, with nothing that writes", async () => {
    await openTask("Get the kitchen ready", null);
    expect(value("priority")).toContain("High");
    expect(value("owners")).toMatch(/@sayo.*@seyi/);
    for (const control of ["task-panel-tick", "task-panel-add-subtask", "task-panel-add-note", "task-panel-priority-button", "task-panel-due-button", "task-panel-tag-remove", "task-panel-owner-remove", "task-panel-status-button"]) {
      expect(all(control)).toHaveLength(0);
    }
    expect(all("task-panel-subtask")).toHaveLength(3);
  });

  test("a plain note opens in the panel too, and so does a Board card", async () => {
    const { selected } = await mount(host([]));
    await press(all("folder-note").find((node) => strip(node.textContent).includes("Opening budget"))!);
    expect(selected).toEqual([]);
    expect(strip(one("task-panel-title").textContent)).toBe("Opening budget");
    await press(one("folder-view-board"));
    await press(all("folder-card").find((node) => strip(node.textContent).includes("Take photos"))!);
    expect(strip(one("task-panel-title").textContent)).toBe("Take photos for the menu");
    expect(value("owners")).toContain("No owner");
  });

  test("a task that goes while it is open closes the panel", async () => {
    let notes = NOTES;
    const listeners: (() => void)[] = [];
    const page = host([]);
    await mount({
      ...page,
      source: { ...page.source, load: async () => ({ notes, complete: true }), subscribe: (listener: () => void) => (listeners.push(listener), () => {}) },
    });
    await press(row("Get the kitchen ready"));
    expect(all("task-panel")).toHaveLength(1);
    notes = NOTES.filter((each) => !each.path.startsWith(`${CAFE}/kitchen/`));
    await act(async () => listeners.forEach((listener) => listener()));
    await act(async () => {});
    expect(all("task-panel")).toHaveLength(0);
  });

  test("on a phone, pressing a task opens its page as it always has", async () => {
    windowOf(390, 844);
    const { selected } = await mount(host([]));
    await press(row("Get the kitchen ready"));
    expect(all("task-panel")).toHaveLength(0);
    expect(selected).toEqual([`${CAFE}/kitchen`]);
  });
});
