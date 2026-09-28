/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S LIST, AS SOMEBODY READS IT.
 *
 * The approved "Projects for everyone" list (owner, 2026-09-28): Backlog
 * folded first, the tasks by status, Finished folded last, then the notes
 * that are not tasks. Each task row leads with its priority and ends with
 * whose it is — a face, never "P0" or "AI" in letters — and a task folder
 * opens in place onto its subtasks and its notes. "Show" narrows the list to
 * whose tasks, per viewer, without writing anything.
 *
 * The properties with teeth: a member gets the same list with nothing to
 * press that would write; a filter is never written to a note; and the one
 * write this adds, "Make it a task", goes the ordinary road.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];

function windowOf(width: number, height: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  windowOf(1280, 800);
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
const note = (name: string, properties: ListNote["properties"], updatedAt = 1, heading?: string): ListNote => ({
  path: `${CAFE}/${name}`,
  properties,
  updatedAt,
  ...(heading === undefined ? {} : { heading }),
});
const NOTES: ListNote[] = [
  note("overview.md", { status: "in progress" }, 1, "Café opening"),
  note("lease.md", { status: "to do", priority: "p0", owner: "@seyi", tags: ["Setup"], due: "2020-10-02" }, 5, "Sign the lease"),
  note("photos.md", { status: "to do", priority: "p2" }, 9, "Take photos for the menu"),
  note("post.md", { status: "to do", priority: "p3", owner: "Claude", tags: ["Writing"] }, 7, "Write the opening-day post"),
  note("later.md", { status: "backlog" }, 3, "Loyalty cards"),
  note("kitchen/overview.md", { status: "in progress", priority: "p1", owner: ["@sayo", "@seyi"], tags: ["Kitchen"] }, 6, "Get the kitchen ready"),
  note("kitchen/oven.md", { status: "finished", owner: "@sayo" }, 6, "Order the oven"),
  note("kitchen/fridge.md", { status: "finished", owner: "@shay's Claude" }, 6, "Compare fridge prices"),
  note("kitchen/inspection.md", { status: "to do" }, 6, "Book the health inspection"),
  note("kitchen/layout.md", {}, 6, "Kitchen layout sketch"),
  note("opened.md", { status: "finished" }, 2, "Open the doors"),
  note("budget.md", {}, 8, "Opening budget"),
];
const LISTING: FolderListing = {
  path: CAFE,
  folderDefault: "team",
  entries: ["overview.md", "lease.md", "photos.md", "post.md", "later.md", "opened.md", "budget.md"]
    .map((name) => entry("file", `${CAFE}/${name}`))
    .concat([entry("folder", `${CAFE}/kitchen`)]),
  truncated: false,
  manifestUsable: true,
};

type Write = [path: string, key: string, value: string | null, options: { create?: boolean } | undefined];

function host(writes: Write[] | null): FolderPageHost {
  return {
    workspaceId: "ws_test",
    people: ["Seyi", "Sayo"],
    me: ["Seyi", "seyi@example.com"],
    source: {
      load: async () => ({ notes: NOTES, complete: true }),
      // The viewer's address names their handle, as the control plane answers it.
      resolveOwners: async (words: readonly string[]) =>
        words.includes("seyi@example.com") ? [{ word: "seyi@example.com", value: "@seyi" }] : [],
      ...(writes === null
        ? {}
        : {
            setProperty: async (path: string, key: string, value: string | null, options?: { create?: boolean }) => {
              writes.push([path, key, value, options]);
              return null;
            },
          }),
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
  await act(async () => {
    root.render(
      createElement(SafeAreaProvider, {
        initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
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
  await act(async () => {});
  await act(async () => {});
  return container;
}

const all = (testID: string, within: ParentNode = document): HTMLElement[] => [
  ...within.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`),
];
const one = (testID: string, within: ParentNode = document): HTMLElement => {
  const found = all(testID, within)[0];
  if (found === undefined) throw new Error(`no ${testID}`);
  return found;
};
const heads = () => all("folder-group").map((group) => strip(group.firstElementChild?.textContent));
const row = (name: string) => all("folder-item").find((node) => strip(node.textContent).includes(name))!;

async function press(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the list", () => {
  test("folds Backlog first and Finished last, with the tasks between and the notes after", async () => {
    await mount(host([]));
    expect(heads()).toEqual(["Backlog1Ideas and later work, out of the way", "To do3", "In progress1", "Finished1"]);
    // Folded: the band is there, its rows are not, until it is pressed.
    expect(all("folder-item").map((node) => strip(node.textContent))).not.toContainEqual(expect.stringContaining("Loyalty cards"));
    await press(all("folder-band")[0]);
    expect(all("folder-band")[0].getAttribute("aria-expanded")).toBe("true");
    expect(row("Loyalty cards")).toBeDefined();
    await press(all("folder-band")[1]);
    expect(row("Open the doors")).toBeDefined();
    expect(all("folder-note").map((node) => strip(node.textContent))).toEqual([expect.stringContaining("Opening budget")]);
  });

  test("leads each row with its priority in words for a reader, never p0, and runs by it", async () => {
    const page = await mount(host([]));
    const names = all("folder-item").map((node) => strip(node.textContent));
    expect(names.slice(0, 3)).toEqual([
      expect.stringContaining("Sign the lease"),
      expect.stringContaining("Take photos"),
      expect.stringContaining("opening-day post"),
    ]);
    expect(one("priority-urgent", row("Sign the lease")).getAttribute("aria-label")).toBe("Urgent");
    expect(one("priority-bars-3", row("kitchen")).getAttribute("aria-label")).toBe("High");
    expect(one("priority-bars-2", row("Take photos")).getAttribute("aria-label")).toBe("Medium");
    expect(one("priority-bars-1", row("opening-day post")).getAttribute("aria-label")).toBe("Low");
    expect(strip(page.textContent)).not.toMatch(/\bp[0-3]\b/i);
  });

  test("ends each row with whose it is: a face and a name, a robot for an AI helper, and nobody as No owner", async () => {
    await mount(host([]));
    expect(strip(one("folder-item-owner", row("Sign the lease")).textContent)).toBe("SE@seyi");
    expect(all("owner-face-agent", row("opening-day post"))).toHaveLength(1);
    expect(strip(one("folder-item-owner", row("opening-day post")).textContent)).toBe("Claude");
    expect(all("owner-face-nobody", row("Take photos"))).toHaveLength(1);
    expect(strip(one("folder-item-owner", row("Take photos")).textContent)).toBe("?No owner");
    // Several owners: the first, and how many more.
    expect(strip(one("folder-item-more-owners", row("kitchen")).textContent)).toBe("+1");
  });

  test("an owner line naming several is shown, never offered as one choice", async () => {
    await mount(host([]));
    expect(one("folder-item-owner", row("kitchen")).getAttribute("role")).not.toBe("button");
    expect(one("folder-item-owner", row("Sign the lease")).getAttribute("role")).toBe("button");
  });

  test("draws tags as chips and a due date short", async () => {
    await mount(host([]));
    expect(strip(one("folder-item-tags", row("Sign the lease")).textContent)).toBe("Setup");
    expect(strip(one("folder-item-due", row("Sign the lease")).textContent)).toBe("Oct 2, 2020");
  });

  test("a task opens onto its subtasks, then the notes in it; only a task with any has the chevron", async () => {
    await mount(host([]));
    const kitchen = row("kitchen");
    expect(strip(one("folder-item-progress", kitchen).textContent)).toBe("2 of 3 done");
    expect(all("folder-expand", row("Sign the lease"))).toHaveLength(0);
    expect(all("folder-subtask")).toHaveLength(0);
    await press(one("folder-expand", kitchen));
    const open = one("folder-task-open");
    const parts = [...open.children].map((node) => strip(node.textContent));
    expect(parts[parts.length - 2]).toBe("NOTES IN THIS TASK");
    expect(parts[parts.length - 1]).toContain("Kitchen layout sketch");
    // No priority among them, saved together: they keep the order they were found in.
    expect(all("folder-subtask").map((node) => strip(node.textContent))).toEqual([
      expect.stringContaining("Order the oven"),
      expect.stringContaining("Compare fridge prices"),
      expect.stringContaining("Book the health inspection"),
    ]);
    expect(all("status-dot-done")).toHaveLength(2);
  });

  test("Make it a task gives a note the folder's first To do status, in the note itself", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    const button = one("folder-make-task", all("folder-note")[0]);
    expect(strip(button.textContent)).toBe("Make it a task");
    await press(button);
    expect(writes).toEqual([[`${CAFE}/budget.md`, "status", "to do", undefined]]);
  });

  test("a member reads the same list with nothing that would write", async () => {
    const page = await mount(host(null));
    expect(heads()).toEqual(["Backlog1Ideas and later work, out of the way", "To do3", "In progress1", "Finished1"]);
    expect(all("folder-make-task")).toHaveLength(0);
    expect(all("folder-item-status")).toHaveLength(0);
    expect(all("folder-item-owner").every((node) => node.getAttribute("role") !== "button")).toBe(true);
    // Looking is not writing: the Show bar is theirs too.
    expect(all("folder-show-bar")).toHaveLength(1);
    expect(strip(page.textContent)).not.toContain("Set status");
  });
});

describe("Show", () => {
  test("counts every task, subtasks included, and No owner narrows to them with 'of' counts", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    expect(strip(one("folder-show-no-owner").textContent)).toBe("No owner · 4");
    expect(strip(one("folder-show-urgent").textContent)).toBe("Urgent · 1");
    await press(one("folder-show-no-owner"));
    expect(heads()).toEqual(["Backlog1 of 1Ideas and later work, out of the way", "To do1 of 3", "In progress1 of 1", "Finished1 of 1"]);
    // The kitchen stays, dimmed and open, for its one unowned subtask; its notes and the page's notes are not tasks.
    expect(all("folder-subtask").map((node) => strip(node.textContent))).toEqual([expect.stringContaining("Book the health inspection")]);
    expect(all("folder-task-notes-label")).toHaveLength(0);
    expect(all("folder-notes")).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  test("Mine is the viewer's, by the handle their address names, and it is remembered here", async () => {
    await mount(host([]));
    await press(one("folder-show-mine"));
    expect(all("folder-item").map((node) => strip(node.textContent))).toEqual([
      expect.stringContaining("Sign the lease"),
      expect.stringContaining("Get the kitchen ready"),
    ]);
    roots.pop()!();
    await mount(host([]));
    expect(one("folder-show-mine").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(["context.folderView", "ws_test", CAFE, "filter"].join("\u001f"))).toBe("mine");
  });

  test("Owner opens a searchable list of no owner, me, the people and the AI helpers, with counts", async () => {
    await mount(host([]));
    await press(one("folder-show-owner"));
    const menu = one("folder-owner-filter");
    const text = strip(menu.textContent);
    expect(text).toMatch(/No owner4.*Me \(Seyi\)2.*PEOPLE.*@sayo2.*AI HELPERS.*Claude1.*@shay's Claude1/);
    await act(async () => {
      const field = one("folder-owner-filter-field") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "sha");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(all("folder-owner-filter-option").map((node) => strip(node.textContent))).toEqual(["@shay's Claude1"]);
    await press(all("folder-owner-filter-option")[0]);
    expect(strip(one("folder-show-owner").textContent)).toBe("@shay's Claude ▾");
    expect(heads()).toEqual(["In progress1 of 1"]);
  });
});
