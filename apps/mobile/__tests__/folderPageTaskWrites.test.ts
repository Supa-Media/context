/**
 * @jest-environment jsdom
 */

/**
 * ADDING, NESTING AND MOVING A PROJECT'S TASKS, FROM THE LIST ITSELF.
 *
 * The approved "Projects for everyone" screens (QuickAdd, DragNest,
 * RightClick): "+ Add task" at the right of the Show bar and at the end of
 * each group, "+ Subtask" on a row, a right-click menu, a selection with a
 * bar, and dragging a task onto another. The properties with teeth:
 *
 * - every write is the console's own road — a new note, a move, a
 *   frontmatter line — and every one is said in a toast with an Undo that
 *   takes it back exactly;
 * - a task that is one note becomes a folder the first time it gets a
 *   subtask, and nothing goes deeper than two levels: the drop that would
 *   says why before it is let go;
 * - what was just added is on the page at once, not a sync later;
 * - a member gets none of it, and nobody reads a file name or "P0".
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import type { TaskHost } from "../features/console/files/folderPage/tasks/taskHost";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];

beforeEach(() => {
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1280, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  window.dispatchEvent(new Event("resize"));
  forgetViews();
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
  note("kitchen/overview.md", { status: "in progress", owner: "@sayo" }, "Get the kitchen ready"),
  note("kitchen/oven.md", { status: "finished" }, "Order the oven"),
  note("budget.md", {}, "Opening budget"),
  { path: "1-projects/menu/overview.md", properties: { status: "to do" }, updatedAt: 1, heading: "Summer menu" },
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
  calls: string[];
  toasts: { message: string; undo?: () => void }[];
  refreshed: string[];
  archived: string[][];
  remembered: [readonly string[], readonly string[]][];
}

function host({ member = false, statuses }: { member?: boolean; statuses?: Record<string, string[]> } = {}): { page: FolderPageHost; seen: Recorded } {
  const seen: Recorded = { calls: [], toasts: [], refreshed: [], archived: [], remembered: [] };
  const notes = NOTES.map((each) => (each.path === `${CAFE}/overview.md` && statuses !== undefined ? { ...each, properties: { ...each.properties, ...statuses } } : each));
  const setProperty = async (path: string, key: string, value: string | null, options?: { create?: boolean }) => {
    seen.calls.push(`set ${path} ${key}=${JSON.stringify(value)}${options?.create ? " create" : ""}`);
    return null;
  };
  const setProperties = async (path: string, changes: readonly (readonly [string, unknown])[], options?: { create?: boolean }) => {
    seen.calls.push(`set ${path} ${changes.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}${options?.create ? " create" : ""}`);
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
    refresh: (folders) => void seen.refreshed.push(...folders),
    archive: (paths) => void seen.archived.push([...paths]),
    copyLink: () => {},
    remember: async (written, gone) => void seen.remembered.push([written, gone]),
  };
  return {
    seen,
    page: {
      workspaceId: "ws_test",
      people: ["Seyi", "Sayo"],
      me: ["Seyi", "seyi@example.com"],
      source: {
        load: async () => ({ notes, complete: true }),
        resolveOwners: async (words: readonly string[]) =>
          words.includes("seyi@example.com") ? [{ word: "seyi@example.com", value: "@seyi" }] : [],
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

async function mount(page: FolderPageHost) {
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
        initialMetrics: { frame: { x: 0, y: 0, width: 1280, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
        children: createElement(FolderView, {
          entry: entry("folder", CAFE),
          listing: LISTING,
          canSetVisibility: true,
          contextLabel: "@seyi",
          onSelect: () => {},
          page,
        }),
      }),
    );
  });
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

async function press(node: HTMLElement, modifiers: MouseEventInit = {}) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ...modifiers }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, ...modifiers }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers }));
  });
  await settle();
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

async function rightClick(node: HTMLElement) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  await act(async () => void node.dispatchEvent(event));
  await settle();
  return event;
}

/** A drag event carrying a task, as jsdom has no DataTransfer of its own. */
function drag(type: string, data: Map<string, string>, clientY = 0): Event {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientY: number };
  event.dataTransfer = {
    types: [...data.keys()],
    setData: (key: string, value: string) => void data.set(key, value),
    getData: (key: string) => data.get(key) ?? "",
    effectAllowed: "all",
    dropEffect: "none",
  };
  Object.defineProperty(event, "clientY", { value: clientY });
  return event;
}

/** Rows are 40 tall at the top of the window, so a y picks a band. */
function sized(node: HTMLElement) {
  node.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
}

async function dragOnto(from: HTMLElement, onto: HTMLElement, y: number, release = true) {
  const data = new Map<string, string>();
  sized(onto);
  await act(async () => void from.dispatchEvent(drag("dragstart", data)));
  await act(async () => void onto.dispatchEvent(drag("dragenter", data, y)));
  await act(async () => void onto.dispatchEvent(drag("dragover", data, y)));
  await settle();
  const hint = all("task-drop-hint", onto).map((node) => strip(node.textContent))[0] ?? all("folder-drop-hint").map((node) => strip(node.textContent))[0] ?? null;
  if (release) {
    await act(async () => void onto.dispatchEvent(drag("drop", data, y)));
    await act(async () => void from.dispatchEvent(drag("dragend", data)));
    await settle();
  }
  return hint;
}

describe("adding a task", () => {
  test("the primary button opens the composer at the top of To do, and Enter adds a note with that status", async () => {
    const { page, seen } = host();
    await mount(page);
    expect(strip(one("folder-add-task-primary").textContent)).toBe("+ Add task");
    await press(one("folder-add-task-primary"));
    expect(strip(one("quick-add").textContent)).toContain("New task in To do");
    await type("quick-add-title", "Order the coffee beans");
    await enter("quick-add-title");
    expect(seen.calls).toEqual([`create ${CAFE}/Order the coffee beans.md\n---\nstatus: to do\n---\n\n# Order the coffee beans\n`]);
    // On the page at once, in its group, before any sync has brought it.
    expect(row("Order the coffee beans")).toBeDefined();
    expect(seen.refreshed).toContain(CAFE);
    expect(seen.remembered).toEqual([[[`${CAFE}/Order the coffee beans.md`], []]]);
    expect(seen.toasts.map((toast) => toast.message)).toEqual(["Added “Order the coffee beans”."]);
    // The composer stays open, empty, for the next.
    expect((one("quick-add-title") as HTMLInputElement).value).toBe("");
    await act(async () => seen.toasts[0]!.undo!());
    await settle();
    expect(seen.calls.at(-1)).toBe(`remove ${CAFE}/Order the coffee beans.md`);
    expect(all("folder-item").some((node) => strip(node.textContent).includes("Order the coffee beans"))).toBe(false);
  });

  test("the line at the end of a group adds a task in that group's first status", async () => {
    const { page, seen } = host();
    await mount(page);
    const lines = all("folder-add-task");
    const inProgress = lines.find((node) => node.closest('[data-testid="folder-group"]')?.textContent?.includes("In progress"))!;
    await press(inProgress);
    await type("quick-add-title", "Hire two baristas");
    await enter("quick-add-title");
    expect(seen.calls[0]).toContain("status: in progress");
  });

  test("+ Subtask on a one-note task makes it a folder first, and the composer follows it there", async () => {
    const { page, seen } = host();
    await mount(page);
    await press(one("task-add-subtask", row("Take photos for the menu")));
    expect(all("quick-add-compact")).toHaveLength(1);
    await type("quick-add-title", "Book the photographer");
    await enter("quick-add-title");
    expect(seen.calls.map((call) => call.split("\n")[0])).toEqual([
      `move ${CAFE}/photos.md -> ${CAFE}/photos/overview.md`,
      `create ${CAFE}/photos/Book the photographer.md`,
    ]);
    // One row for the task, now a folder holding its first subtask, still open for the next.
    expect(all("folder-item").filter((node) => strip(node.textContent).includes("Take photos"))).toHaveLength(1);
    expect(all("folder-subtask").map((node) => strip(node.textContent))).toContainEqual(expect.stringContaining("Book the photographer"));
    expect(all("quick-add-compact")).toHaveLength(1);
    expect(seen.toasts.at(-1)!.message).toBe("Added “Book the photographer” to “Take photos for the menu”.");
    await act(async () => seen.toasts.at(-1)!.undo!());
    await settle();
    expect(seen.calls.slice(2)).toEqual([`remove ${CAFE}/photos/Book the photographer.md`, `move ${CAFE}/photos/overview.md -> ${CAFE}/photos.md`]);
  });

  test("an opened task ends with + Add subtask; a subtask has no + Subtask of its own", async () => {
    const { page } = host();
    await mount(page);
    await press(one("folder-expand", row("kitchen")));
    expect(all("task-add-subtask-line")).toHaveLength(1);
    expect(all("task-add-subtask", one("folder-task-open"))).toHaveLength(0);
  });
});

describe("the right-click menu", () => {
  test("is the approved list, and Priority › High writes the one line, undone to what it was", async () => {
    const { page, seen } = host();
    await mount(page);
    const event = await rightClick(frameOf(row("Sign the lease")));
    expect(event.defaultPrevented).toBe(true);
    const labels = strip(one("menu-root").textContent);
    for (const words of ["Status", "Priority", "Owners", "Tags", "Due date", "Add a subtask", "Make it a subtask of…", "Move to Backlog", "Move to another project…", "Open", "Copy link", "Archive"]) {
      expect(labels).toContain(words);
    }
    // Seyi owns it already: nothing to assign to them.
    expect(labels).not.toContain("Assign to me");
    await press(one("menu-item-priority"));
    await press(one("menu-item-priority:p1"));
    expect(seen.calls).toEqual([`set ${CAFE}/lease.md priority="p1"`]);
    expect(seen.toasts.at(-1)!.message).toBe("“Sign the lease” is High now.");
    const undo = seen.toasts.at(-1)!.undo!;
    await act(async () => undo());
    await settle();
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/lease.md priority="p0"`);
    // A second press of the same Undo takes nothing back twice.
    const before = seen.calls.length;
    await act(async () => undo());
    await settle();
    expect(seen.calls).toHaveLength(before);
  });

  test("Assign to me writes the viewer's handle; Move to Backlog parks it", async () => {
    const { page, seen } = host();
    await mount(page);
    await rightClick(frameOf(row("Take photos")));
    await press(one("menu-item-me"));
    expect(seen.calls).toEqual([`set ${CAFE}/photos.md owner="@seyi"`]);
    await rightClick(frameOf(row("Take photos")));
    await press(one("menu-item-park"));
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/photos.md status="backlog"`);
    expect(seen.toasts.at(-1)!.message).toBe("Moved “Take photos for the menu” to Backlog.");
  });

  test("Make it a subtask of… moves it under the task picked; another project moves it there", async () => {
    const { page, seen } = host();
    await mount(page);
    await rightClick(frameOf(row("Take photos")));
    await press(one("menu-item-nest"));
    await press(one(`menu-item-nest:${CAFE}/kitchen`));
    expect(seen.calls).toEqual([`move ${CAFE}/photos.md -> ${CAFE}/kitchen/photos.md`]);
    await rightClick(frameOf(row("Sign the lease")));
    await press(one("menu-item-project"));
    await press(one("menu-item-project:1-projects/menu"));
    expect(seen.calls.at(-1)).toBe(`move ${CAFE}/lease.md -> 1-projects/menu/lease.md`);
    expect(seen.toasts.at(-1)!.message).toBe("Moved “Sign the lease” to “Summer menu”.");
  });

  test("a project whose list has no Backlog offers no Move to Backlog", async () => {
    const { page } = host({ statuses: { "statuses-not-started": ["to do"] } });
    await mount(page);
    await rightClick(frameOf(row("Take photos")));
    expect(strip(one("menu-root").textContent)).not.toContain("Move to Backlog");
  });

  test("a plain note is offered Make it a task, Open, Copy link, Archive; Archive is the console's dialog", async () => {
    const { page, seen } = host();
    await mount(page);
    await rightClick(frameOf(one("folder-note")));
    expect(strip(one("menu-root").textContent)).toBe("Make it a taskOpenCopy linkArchive");
    await press(one("menu-item-archive"));
    expect(seen.archived).toEqual([[`${CAFE}/budget.md`]]);
  });
});

describe("several at once", () => {
  test("Shift-click picks rows; the bar sets them all as one change with one undo", async () => {
    const { page, seen } = host();
    await mount(page);
    await press(row("Sign the lease"), { shiftKey: true });
    await press(row("Take photos"), { metaKey: true });
    expect(strip(one("task-selection-count").textContent)).toBe("2 selected");
    expect(all("task-pick").filter((node) => node.getAttribute("aria-checked") === "true")).toHaveLength(2);
    await press(one("task-selection-park"));
    expect(seen.calls).toEqual([`set ${CAFE}/lease.md status="backlog"`, `set ${CAFE}/photos.md status="backlog"`]);
    expect(seen.toasts.at(-1)!.message).toBe("Moved 2 tasks to Backlog.");
    expect(all("task-selection-bar")).toHaveLength(0);
    await act(async () => seen.toasts.at(-1)!.undo!());
    await settle();
    expect(seen.calls.slice(2)).toEqual([`set ${CAFE}/photos.md status="to do"`, `set ${CAFE}/lease.md status="to do"`]);
  });

  test("the checkbox picks too, and ✕ lets go of them all", async () => {
    const { page } = host();
    await mount(page);
    await press(one("task-pick", row("Sign the lease")));
    expect(strip(one("task-selection-count").textContent)).toBe("1 selected");
    await press(one("task-selection-clear"));
    expect(all("task-selection-bar")).toHaveLength(0);
  });
});

describe("dragging", () => {
  test("onto a task's middle makes it a subtask, said before it is let go, with an undo after", async () => {
    const { page, seen } = host();
    await mount(page);
    const hint = await dragOnto(frameOf(row("Take photos")), frameOf(row("kitchen")), 20);
    expect(hint).toBe("Make it a subtask of “Get the kitchen ready”");
    expect(seen.calls).toEqual([`move ${CAFE}/photos.md -> ${CAFE}/kitchen/photos.md`]);
    expect(seen.toasts.at(-1)!.message).toBe("Made “Take photos for the menu” a subtask of “Get the kitchen ready”.");
    expect(seen.toasts.at(-1)!.undo).toBeDefined();
  });

  test("onto a subtask is refused, visibly, and nothing moves", async () => {
    const { page, seen } = host();
    await mount(page);
    await press(one("folder-expand", row("kitchen")));
    const oven = all("folder-subtask").find((node) => strip(node.textContent).includes("Order the oven"))!;
    const hint = await dragOnto(frameOf(row("Take photos")), frameOf(oven), 20);
    expect(hint).toBe("“Order the oven” is already a subtask, and a subtask can’t have subtasks of its own.");
    expect(seen.calls).toEqual([]);
    expect(strip(one("folder-problem").textContent)).toContain("can’t have subtasks of its own");
  });

  test("between rows takes that row's status; on the folded Backlog band it parks", async () => {
    const { page, seen } = host();
    await mount(page);
    await dragOnto(frameOf(row("Take photos")), frameOf(row("kitchen")), 2);
    expect(seen.calls).toEqual([`set ${CAFE}/photos.md status="in progress"`]);
    const band = all("folder-band")[0]!.parentElement!;
    const hint = await dragOnto(frameOf(row("Sign the lease")), band, 5);
    expect(hint).toBe("Drop here to move to Backlog");
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/lease.md status="backlog"`);
    expect(seen.toasts.at(-1)!.undo).toBeDefined();
  });
});

describe("who may", () => {
  test("a member gets no add, no checkbox, no drag and no menu", async () => {
    const { page } = host({ member: true });
    await mount(page);
    expect(all("folder-add-task-primary")).toHaveLength(0);
    expect(all("folder-add-task")).toHaveLength(0);
    expect(all("task-pick")).toHaveLength(0);
    expect(all("task-add-subtask")).toHaveLength(0);
    expect(frameOf(row("Sign the lease")).getAttribute("draggable")).toBe("false");
    const event = await rightClick(frameOf(row("Sign the lease")));
    expect(event.defaultPrevented).toBe(false);
    expect(all("menu-root")).toHaveLength(0);
  });

  test("nobody reads a file name, a scale code or a format", async () => {
    const { page } = host();
    const view = await mount(page);
    await press(one("folder-add-task-primary"));
    await rightClick(frameOf(row("Sign the lease")));
    await press(one("menu-item-priority"));
    const text = strip(document.body.textContent) + strip(view.textContent);
    expect(text).not.toMatch(/\bp[0-3]\b|frontmatter|markdown|\.md\b|overview/i);
  });
});
