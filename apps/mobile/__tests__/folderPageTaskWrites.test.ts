/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S TASK WRITES, FROM THE BOARD.
 *
 * Every write the page makes for somebody who may write is the console's own
 * road — a frontmatter line — and is said in a toast with an Undo that takes
 * it back exactly. A member gets none of it, and nobody reads a file name or
 * "P0".
 *
 * The List once added, nested, picked and moved tasks itself ("+ Add task",
 * "+ Subtask", a right-click menu, a selection bar, dragging one task onto
 * another). The owner, 2026-10-10, made the List the Notes rows with a dot, a
 * count and faces, and nothing on it writes (`folderPageList.test.ts`), so
 * those went with it. What still writes on this page is a Board card's status
 * (and its drag, `folderBoard.test.ts`), tested here through the same task
 * host.
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
  localStorage.setItem(["context.folderView", "ws_test", CAFE].join("\u001f"), "board");
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
async function press(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

const card = (name: string) => all("folder-card").find((node) => strip(node.textContent).includes(name))!;
const column = (label: string) => all("folder-board-column").find((node) => node.getAttribute("aria-label")?.startsWith(`${label},`))!;

describe("a card's status", () => {
  test("picked from its menu, writes the one line, said with an Undo that takes it back", async () => {
    const { page, seen } = host();
    await mount(page);
    await press(one("folder-card-status", card("Take photos for the menu")));
    await press(all("menu-item-choice:3")[0]!);
    expect(seen.calls).toEqual([`set ${CAFE}/photos.md status="in progress"`]);
    expect(strip(column("In progress").textContent)).toContain("Take photos for the menu");
    expect(seen.toasts.at(-1)!.undo).toBeDefined();
    const undo = seen.toasts.at(-1)!.undo!;
    await act(async () => undo());
    await settle();
    expect(seen.calls.at(-1)).toBe(`set ${CAFE}/photos.md status="to do"`);
    // A second press of the same Undo takes nothing back twice.
    const before = seen.calls.length;
    await act(async () => undo());
    await settle();
    expect(seen.calls).toHaveLength(before);
  });
});

describe("who may", () => {
  test("a member gets no status button and no drag on a card", async () => {
    const { page } = host({ member: true });
    await mount(page);
    expect(all("folder-card").length).toBeGreaterThan(0);
    expect(all("folder-card-status")).toHaveLength(0);
    expect(all("folder-card-drag").every((node) => node.getAttribute("draggable") === "false")).toBe(true);
  });

  test("nobody reads a file name, a scale code or a format", async () => {
    const { page } = host();
    const view = await mount(page);
    await press(one("folder-card-status", card("Sign the lease")));
    expect(all("menu-root")).toHaveLength(1);
    // Not even the about note's: it shows as words under the title, not as a file (2026-10-09).
    const text = strip(document.body.textContent) + strip(view.textContent);
    expect(text).not.toMatch(/\bp[0-3]\b|frontmatter|markdown|\.md\b|overview/i);
  });
});
