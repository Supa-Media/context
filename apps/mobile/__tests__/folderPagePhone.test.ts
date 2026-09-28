/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S LIST ON A PHONE: THE SAME ACTIONS, UNDER A THUMB.
 *
 * The approved PhoneList and PhoneMenu screens ("Projects for everyone",
 * 2026-09-28): every row carries a visible ⋯ that opens a sheet from the
 * bottom — a row of priority chips, then Status, Owners, Assign to me, Tags,
 * Due date, Add a subtask, Move to Backlog, Archive — and press-and-hold
 * opens the same sheet. A task swiped left offers Assign and Backlog; a full
 * swipe only reveals them. An "Add a task" bar sits at the bottom of the page,
 * and the Show chips scroll sideways rather than wrapping. The properties with
 * teeth:
 *
 * - the sheet is the right-click menu's own list (`taskMenu.ts`), redrawn —
 *   never a second list that can drift from it;
 * - every write keeps the toast with its Undo;
 * - every control is at least a 44pt target;
 * - a member gets none of it.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { defaultStatusList } from "../../mcp/src/lists.js";
import { layout as tokens } from "../features/design/tokens";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import { statusMenu, type StatusList } from "../features/console/files/folderPage/statuses";
import { phoneSheet, swipeActions } from "../features/console/files/folderPage/tasks/phoneSheet";
import { taskMenuItems, type TaskMenuContext } from "../features/console/files/folderPage/tasks/taskMenu";
import type { TaskHost } from "../features/console/files/folderPage/tasks/taskHost";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const PHONE = 390;

/* -------------------------------------------------------------------------- */
/*                         the sheet is the menu's list                        */
/* -------------------------------------------------------------------------- */

const context = (over: Partial<TaskMenuContext> = {}): TaskMenuContext => ({
  kind: "task",
  status: "to do",
  priority: "p1",
  owners: [],
  tags: [],
  hasDue: false,
  isSubtask: false,
  hasSubtasks: false,
  statusSections: statusMenu(defaultStatusList() as StatusList),
  backlog: "backlog",
  nestTargets: [{ path: "a/kitchen", label: "Get the kitchen ready" }],
  projects: [{ path: "a/menu", label: "Summer menu" }],
  tagsInUse: ["Setup"],
  me: "@seyi",
  ownerLabel: (value) => value,
  canCopyLink: true,
  canArchive: true,
  makeTaskLabel: "Make it a task",
  ...over,
});

describe("the phone sheet, from the right-click menu's own list", () => {
  test("lifts Priority into a chip row, and keeps every other item, in order", () => {
    const menu = taskMenuItems(context());
    const sheet = phoneSheet(menu, {});
    expect(sheet.chips.map((chip) => chip.id)).toEqual(["priority:p0", "priority:p1", "priority:p2", "priority:p3", "priority:none"]);
    expect(sheet.chips.map((chip) => chip.label)).toEqual(["Urgent", "High", "Medium", "Low", "None"]);
    expect(sheet.chips.find((chip) => chip.checked)?.id).toBe("priority:p1");
    expect(sheet.items.map((item) => item.id)).toEqual(menu.filter((item) => item.id !== "priority").map((item) => item.id));
    // The submenus are the menu's own, untouched.
    expect(sheet.items.find((item) => item.id === "status")!.items).toEqual(menu.find((item) => item.id === "status")!.items);
  });

  test("shows each row's current value beside it", () => {
    const sheet = phoneSheet(taskMenuItems(context()), { status: "In progress", owners: "Sayo", tags: "Kitchen, Suppliers", due: "Sat" });
    const value = (id: string) => sheet.items.find((item) => item.id === id)?.value;
    expect([value("status"), value("owners"), value("tags"), value("due"), value("me")]).toEqual(["In progress", "Sayo", "Kitchen, Suppliers", "Sat", undefined]);
  });

  test("a note has no chips: its sheet is its menu", () => {
    const menu = taskMenuItems(context({ kind: "note" }));
    const sheet = phoneSheet(menu, {});
    expect(sheet.chips).toEqual([]);
    expect(sheet.items.map((item) => item.label)).toEqual(["Make it a task", "Open", "Copy link", "Archive"]);
  });

  test("a swipe offers Assign and Backlog only where the menu does", () => {
    expect(swipeActions(taskMenuItems(context())).map((action) => action.id)).toEqual(["me", "park"]);
    expect(swipeActions(taskMenuItems(context({ owners: ["@seyi"] }))).map((action) => action.id)).toEqual(["park"]);
    expect(swipeActions(taskMenuItems(context({ status: "backlog" }))).map((action) => action.id)).toEqual(["me"]);
    expect(swipeActions(taskMenuItems(context({ me: null, backlog: null })))).toEqual([]);
    expect(swipeActions(taskMenuItems(context({ kind: "note" })))).toEqual([]);
    expect(swipeActions(taskMenuItems(context())).map((action) => action.label)).toEqual(["Assign", "Backlog"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               the page, drawn                              */
/* -------------------------------------------------------------------------- */

const roots: (() => void)[] = [];
/** What the page opened: a ⋯, a hold or a swipe must never also open the row. */
let opened: string[] = [];

beforeEach(() => {
  Object.defineProperty(document.documentElement, "clientWidth", { value: PHONE, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 844, configurable: true });
  window.dispatchEvent(new Event("resize"));
  forgetViews();
  opened = [];
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const strip = (text: string | null | undefined): string => (text ?? "").replace(/[\u2066-\u2069]/g, "");

const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

const CAFE = "1-projects/cafe";
const note = (name: string, properties: ListNote["properties"], heading?: string): ListNote => ({
  path: `${CAFE}/${name}`,
  properties,
  updatedAt: 1,
  ...(heading === undefined ? {} : { heading }),
});
const NOTES: ListNote[] = [
  note("overview.md", { status: "in progress" }, "Café opening"),
  note("lease.md", { status: "to do", priority: "p0", owner: "@seyi", tags: ["Setup"] }, "Sign the lease"),
  note("photos.md", { status: "to do" }, "Take photos for the menu"),
  note("later.md", { status: "backlog" }, "Loyalty cards"),
  note("kitchen/overview.md", { status: "in progress", owner: "@sayo", tags: ["Kitchen"] }, "Get the kitchen ready"),
  note("kitchen/oven.md", { status: "finished" }, "Order the oven"),
  note("budget.md", {}, "Opening budget"),
];
const LISTING: FolderListing = {
  path: CAFE,
  folderDefault: "team",
  entries: ["overview.md", "lease.md", "photos.md", "later.md", "budget.md"]
    .map((name) => entry("file", `${CAFE}/${name}`))
    .concat([entry("folder", `${CAFE}/kitchen`)]),
  truncated: false,
  manifestUsable: true,
};

interface Recorded {
  /** The page has been told the viewer's handle: "Assign to me" depends on it. */
  knowsMe: boolean;
  /** Owner lookups still on their way: the page asks again as its notes arrive, and keeps only the last answer. */
  asking: number;
  calls: string[];
  toasts: { message: string; undo?: () => void }[];
  archived: string[][];
}

function host({ member = false }: { member?: boolean } = {}): { page: FolderPageHost; seen: Recorded } {
  const seen: Recorded = { knowsMe: false, asking: 0, calls: [], toasts: [], archived: [] };
  const setProperty = async (path: string, key: string, value: string | null) => {
    seen.calls.push(`set ${path} ${key}=${JSON.stringify(value)}`);
    return null;
  };
  const setProperties = async (path: string, changes: readonly (readonly [string, unknown])[]) => {
    seen.calls.push(`set ${path} ${changes.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`);
    return null;
  };
  const tasks: TaskHost = {
    io: {
      create: async (path, text) => void seen.calls.push(`create ${path}\n${text}`),
      move: async (from, to) => void seen.calls.push(`move ${from} -> ${to}`),
      remove: async (path) => void seen.calls.push(`remove ${path}`),
      setProperties: async () => "not this one",
    },
    say: (message, undo) => void seen.toasts.push({ message, ...(undo === undefined ? {} : { undo }) }),
    refresh: () => {},
    archive: (paths) => void seen.archived.push([...paths]),
    copyLink: () => {},
    remember: async () => {},
  };
  return {
    seen,
    page: {
      workspaceId: "ws_test",
      people: ["Seyi", "Sayo"],
      me: ["Seyi", "seyi@example.com"],
      source: {
        load: async () => ({ notes: NOTES, complete: true }),
        resolveOwners: async (words: readonly string[]) => {
          seen.asking++;
          try {
            if (!words.includes("seyi@example.com")) return [];
            seen.knowsMe = true;
            return [{ word: "seyi@example.com", value: "@seyi" }];
          } finally {
            seen.asking--;
          }
        },
        ...(member
          ? {}
          : {
              setProperty,
              setProperties,
              searchOwners: async () => ({ people: [{ value: "@sayo", name: "Sayo", isMe: false }], agents: [], truncated: false }),
            }),
      },
      ...(member ? {} : { tasks }),
    },
  };
}

/**
 * Mounts the page and waits until it has resolved the viewer's handle, which
 * it asks for asynchronously: until then the menu has no "Assign to me" and a
 * swipe no Assign, so a test that raced it would pass or fail by the runner's
 * speed.
 */
async function mount(page: FolderPageHost, seen?: Recorded) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  localStorage.setItem(["context.folderView", "ws_test", CAFE].join("\u001f"), "list");
  await act(async () => {
    root.render(
      createElement(SafeAreaProvider, {
        initialMetrics: { frame: { x: 0, y: 0, width: PHONE, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
        children: createElement(FolderView, {
          entry: entry("folder", CAFE),
          listing: LISTING,
          canSetVisibility: true,
          contextLabel: "@seyi",
          onSelect: (path: string) => void opened.push(path),
          page,
        }),
      }),
    );
  });
  await settle();
  for (let tries = 0; seen !== undefined && (!seen.knowsMe || seen.asking > 0) && tries < 150; tries++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  if (seen !== undefined && !seen.knowsMe) throw new Error("the page never asked who the viewer is");
  await settle();
  return container;
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

const all = (testID: string, within: ParentNode = document): HTMLElement[] => [...within.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`)];
const one = (testID: string, within: ParentNode = document): HTMLElement => {
  const found = all(testID, within)[0];
  if (found === undefined) throw new Error(`no ${testID}`);
  return found;
};
const row = (name: string) => all("folder-item").find((node) => strip(node.textContent).includes(name))!;
const frameOf = (node: HTMLElement) => node.closest<HTMLElement>('[data-testid="task-row-frame"]')!;
const px = (node: HTMLElement, property: string) => Number.parseFloat(window.getComputedStyle(node).getPropertyValue(property));

async function press(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

/** A pointer that goes down, moves and comes up, with the page coordinates react-native-web's responder reads. */
function pointer(node: HTMLElement) {
  const fire = (type: string, x: number, buttons: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons, clientX: x, clientY: 10 });
    Object.defineProperty(event, "pageX", { value: x });
    Object.defineProperty(event, "pageY", { value: 10 });
    act(() => void node.dispatchEvent(event));
  };
  return {
    down: (x: number) => fire("mousedown", x, 1),
    move: (x: number) => fire("mousemove", x, 1),
    up: (x: number) => fire("mouseup", x, 0),
  };
}

async function swipe(node: HTMLElement, distance: number) {
  const hand = pointer(node);
  hand.down(300);
  for (let step = 1; step <= 6; step++) hand.move(300 - (distance * step) / 6);
  hand.up(300 - distance);
  await settle();
}

/**
 * Waits for `testID` under `within`, the way `appears` in `folderPageList.test.ts` waits for a menu.
 * Up to 4s: a loaded CI runner took longer than the 1s this once allowed to reveal a swipe's buttons.
 */
async function appearsIn(testID: string, within: ParentNode): Promise<HTMLElement> {
  for (let tries = 0; tries < 200 && all(testID, within).length === 0; tries++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  return one(testID, within);
}

async function swipeUntil(name: string, testID: string, distance = 180): Promise<HTMLElement> {
  await swipe(row(name), distance);
  return appearsIn(testID, frameOf(row(name)));
}

async function type(testID: string, value: string) {
  const input = one(testID) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enter(testID: string) {
  await act(async () => {
    one(testID).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await settle();
}

describe("⋯ on a row", () => {
  test("every task and note row has one, a 44pt target", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    const buttons = all("task-more");
    // Three tasks in To do and In progress, and the plain note.
    expect(buttons.length).toBe(all("folder-item").length + all("folder-note").length);
    for (const button of buttons) {
      expect(px(button, "min-width")).toBeGreaterThanOrEqual(tokens.minTouchTarget);
      expect(px(button, "min-height")).toBeGreaterThanOrEqual(tokens.minTouchTarget);
    }
    expect(one("task-more", frameOf(row("Take photos"))).getAttribute("aria-label")).toBe("More for Take photos for the menu");
  });

  test("opens a sheet of the menu's actions: priority chips first, then Status to Archive, each with its value", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    await press(one("task-more", frameOf(row("Get the kitchen ready"))));
    const sheet = one("menu-sheet");
    expect(opened).toEqual([]);
    expect(strip(one("menu-title", sheet).textContent)).toBe("Get the kitchen ready");
    expect(all("task-sheet-priority", sheet).map((chip) => strip(chip.textContent))).toEqual(["!Urgent", "High", "Medium", "Low", "None"]);
    // No Priority row: the chips are it.
    expect(all("menu-item-priority", sheet)).toHaveLength(0);
    const labels = all("menu-list", sheet).map((node) => strip(node.textContent))[0]!;
    for (const words of ["Status", "Owners", "Assign to me", "Tags", "Due date", "Add a subtask", "Move to Backlog", "Open", "Copy link", "Archive"]) {
      expect(labels).toContain(words);
    }
    expect(strip(one("menu-value-status", sheet).textContent)).toBe("In progress");
    expect(strip(one("menu-value-owners", sheet).textContent)).toBe("@sayo");
    expect(strip(one("menu-value-tags", sheet).textContent)).toBe("Kitchen");
    for (const target of all("task-sheet-priority", sheet)) expect(px(target, "min-height")).toBeGreaterThanOrEqual(tokens.minTouchTarget);
  });

  test("a priority chip writes the one line, said with an Undo that takes it back", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    await press(one("task-more", frameOf(row("Sign the lease"))));
    const urgent = all("task-sheet-priority").find((chip) => strip(chip.textContent).includes("Urgent"))!;
    expect(urgent.getAttribute("aria-checked")).toBe("true");
    await press(all("task-sheet-priority").find((chip) => strip(chip.textContent) === "High")!);
    expect(seen.calls).toEqual([`set ${CAFE}/lease.md priority="p1"`]);
    expect(seen.toasts.at(-1)!.message).toBe("“Sign the lease” is High now.");
    expect(all("menu-sheet")).toHaveLength(0);
    await act(async () => seen.toasts.at(-1)!.undo!());
    await settle();
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/lease.md priority="p0"`);
  });

  test("a row goes where the menu's does: Status › In progress, Move to Backlog", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    await press(one("task-more", frameOf(row("Take photos"))));
    await press(one("menu-item-status"));
    await press(one("menu-item-status:in progress"));
    expect(seen.calls).toEqual([`set ${CAFE}/photos.md status="in progress"`]);
    await press(one("task-more", frameOf(row("Sign the lease"))));
    await press(one("menu-item-park"));
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/lease.md status="backlog"`);
    expect(seen.toasts.at(-1)!.undo).toBeDefined();
  });

  test("a note's ⋯ offers its note actions", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    await press(one("task-more", frameOf(one("folder-note"))));
    expect(all("task-sheet-priority")).toHaveLength(0);
    expect(strip(one("menu-list").textContent)).toBe("Make it a taskOpenCopy linkArchive");
    await press(one("menu-item-archive"));
    expect(seen.archived).toEqual([[`${CAFE}/budget.md`]]);
  });

  test("press-and-hold on a row opens the same sheet", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    const target = row("Take photos");
    await act(async () => void target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 })));
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    await act(async () => void target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await settle();
    expect(strip(one("menu-title", one("menu-sheet")).textContent)).toBe("Take photos for the menu");
    expect(all("task-sheet-priority")).toHaveLength(5);
    expect(opened).toEqual([]);
  });
});

describe("swiping a task left", () => {
  test("reveals Assign and Backlog; Assign writes the viewer's handle, with an Undo", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    expect(all("task-swipe-me")).toHaveLength(0);
    await swipeUntil("Take photos", "task-swipe-me");
    const frame = frameOf(row("Take photos"));
    expect(strip(one("task-swipe-me", frame).textContent)).toBe("Assign");
    expect(one("task-swipe-me", frame).getAttribute("aria-label")).toBe("Assign to me");
    expect(strip(one("task-swipe-park", frame).textContent)).toBe("Backlog");
    expect(px(one("task-swipe-me", frame), "min-width")).toBeGreaterThanOrEqual(tokens.minTouchTarget);
    // A full swipe only reveals: nothing is written, or opened, until one is pressed.
    expect(seen.calls).toEqual([]);
    expect(opened).toEqual([]);
    await press(one("task-swipe-me", frame));
    expect(seen.calls).toEqual([`set ${CAFE}/photos.md owner="@seyi"`]);
    expect(seen.toasts.at(-1)!.undo).toBeDefined();
    await act(async () => seen.toasts.at(-1)!.undo!());
    await settle();
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/photos.md owner=null`);
  });

  test("offers only what applies: a task already yours is offered Backlog alone", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    await swipeUntil("Sign the lease", "task-swipe-park");
    const frame = frameOf(row("Sign the lease"));
    expect(all("task-swipe-me", frame)).toHaveLength(0);
    await press(one("task-swipe-park", frame));
    expect(seen.calls).toEqual([`set ${CAFE}/lease.md status="backlog"`]);
    expect(seen.toasts.at(-1)!.message).toBe("Moved “Sign the lease” to Backlog.");
  });

  test("a full swipe, all the way across, writes nothing", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    await swipeUntil("Take photos", "task-swipe-park", PHONE);
    expect(seen.calls).toEqual([]);
    expect(all("task-swipe-park", frameOf(row("Take photos")))).toHaveLength(1);
  });
});

describe("the page on a phone", () => {
  test("an Add a task bar at the bottom opens the composer for the first To do", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    // The Show bar's own button makes way for the bar.
    expect(all("folder-add-task-primary")).toHaveLength(0);
    const bar = one("task-phone-add");
    expect(strip(bar.textContent)).toBe("Add a task");
    expect(px(bar, "min-height")).toBeGreaterThanOrEqual(tokens.minTouchTarget);
    await press(bar);
    expect(strip(one("quick-add").textContent)).toContain("New task in To do");
    await type("quick-add-title", "Order the coffee beans");
    await enter("quick-add-title");
    expect(seen.calls).toEqual([`create ${CAFE}/Order the coffee beans.md\n---\nstatus: to do\n---\n\n# Order the coffee beans\n`]);
    expect(seen.toasts.map((toast) => toast.message)).toEqual(["Added “Order the coffee beans”."]);
    expect(seen.toasts[0]!.undo).toBeDefined();
  });

  test("the Show chips scroll sideways instead of wrapping", async () => {
    const { page, seen } = host();
    await mount(page, seen);
    const chips = one("folder-show-chips");
    expect(window.getComputedStyle(chips).overflowX).toBe("auto");
    expect(one("folder-show-bar").contains(chips)).toBe(true);
    expect(chips.querySelector('[data-testid="folder-show-owner"]')).not.toBeNull();
  });

  test("a member gets no ⋯, no swipe, no hold, and no Add a task", async () => {
    const { page } = host({ member: true });
    await mount(page);
    expect(all("task-more")).toHaveLength(0);
    expect(all("task-phone-add")).toHaveLength(0);
    await swipe(row("Take photos"), 180);
    expect(all("task-swipe-me")).toHaveLength(0);
    expect(all("task-swipe-park")).toHaveLength(0);
    const target = row("Take photos");
    await act(async () => void target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 })));
    await act(() => new Promise((resolve) => setTimeout(resolve, 700)));
    await act(async () => void target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
    await settle();
    expect(all("menu-sheet")).toHaveLength(0);
  });
});
