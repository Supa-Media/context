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
  note("lease.md", { status: "to do", priority: "p0", owner: "@seyi", tags: ["Setup"], due: "2020-10-02", estimate: "M" }, 5, "Sign the lease"),
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

async function appears(testID: string): Promise<HTMLElement> {
  for (let tries = 0; tries < 50 && all(testID).length === 0; tries++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  return one(testID);
}

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
    expect(strip(one("folder-item-owner", row("Sign the lease")).textContent)).toBe("@seyi");
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
    const meter = one("folder-item-progress", kitchen);
    expect(strip(meter.textContent)).toBe("2/3");
    expect(meter.getAttribute("aria-label")).toBe("2 of 3 done");
    expect(meter.getAttribute("aria-valuenow")).toBe("2");
    expect(one("progress-fill", meter).style.width).toBe("67%");
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

  test("a note inside a task becomes that task's subtask with the first To do of the list that describes it", async () => {
    const writes: Write[] = [];
    const page = host(writes);
    const own = NOTES.map((each) =>
      each.path === `${CAFE}/kitchen/overview.md` ? { ...each, properties: { ...each.properties, "statuses-not-started": ["prep"] } } : each,
    );
    page.source.load = async () => ({ notes: own, complete: true });
    await mount(page);
    await press(one("folder-expand", row("kitchen")));
    await press(one("folder-make-task", one("folder-task-open")));
    expect(writes).toEqual([[`${CAFE}/kitchen/layout.md`, "status", "prep", undefined]]);
  });

  test("a subtask shows its priority and changes it like its parent does", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    await press(one("folder-expand", row("kitchen")));
    const inspection = all("folder-subtask").find((node) => strip(node.textContent).includes("Book the health inspection"))!;
    const mark = one("folder-item-priority", inspection);
    expect(mark.getAttribute("aria-label")).toBe("Change priority, No priority");
    await press(mark);
    await press(await appears("menu-item-p0"));
    expect(writes).toEqual([[`${CAFE}/kitchen/inspection.md`, "priority", "p0", undefined]]);
  });

  test("a task and a subtask each show their estimate, and a writer picks one of the six sizes", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    const lease = one("folder-item-estimate", row("Sign the lease"));
    expect(strip(lease.textContent)).toBe("M");
    expect(lease.getAttribute("aria-label")).toBe("Change estimate, M");
    await press(one("folder-expand", row("kitchen")));
    const inspection = all("folder-subtask").find((node) => strip(node.textContent).includes("Book the health inspection"))!;
    const unset = one("folder-item-estimate", inspection);
    expect(unset.getAttribute("aria-label")).toBe("Set an estimate");
    await press(unset);
    await appears("menu-item-L");
    expect(strip(one("menu-detail-L").textContent)).toBe("About a week");
    expect(all("menu-item-none")).toHaveLength(1);
    await press(one("menu-item-L"));
    expect(writes).toEqual([[`${CAFE}/kitchen/inspection.md`, "estimate", "L", undefined]]);
  });

  test("No estimate clears the line", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    await press(one("folder-item-estimate", row("Sign the lease")));
    await press(await appears("menu-item-none"));
    expect(writes).toEqual([[`${CAFE}/lease.md`, "estimate", null, undefined]]);
  });

  test("a member reads the same list with nothing that would write", async () => {
    const page = await mount(host(null));
    expect(heads()).toEqual(["Backlog1Ideas and later work, out of the way", "To do3", "In progress1", "Finished1"]);
    expect(all("folder-make-task")).toHaveLength(0);
    expect(all("folder-item-status")).toHaveLength(0);
    expect(all("folder-item-owner").every((node) => node.getAttribute("role") !== "button")).toBe(true);
    const estimate = one("folder-item-estimate", row("Sign the lease"));
    expect([strip(estimate.textContent), estimate.getAttribute("role")]).toEqual(["M", null]);
    expect(all("folder-item-estimate")).toHaveLength(1);
    // Looking is not writing: the filter bar is theirs too.
    expect(all("folder-show-bar")).toHaveLength(1);
    expect(strip(page.textContent)).not.toContain("Set status");
  });
});

async function typeInto(testID: string, text: string) {
  await act(async () => {
    const field = one(testID) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const FILTER_KEY = ["context.folderView", "ws_test", CAFE, "filter"].join("\u001f");
const names = () => all("folder-item").map((node) => strip(one("folder-item-label", node).textContent));

describe("the filter bar", () => {
  test("is a search, Mine, and a menu for each kind, with how many there are", async () => {
    await mount(host([]));
    const bar = one("folder-show-bar");
    expect(one("folder-filter-search", bar).getAttribute("placeholder")).toBe("Search tasks");
    expect(one("folder-show-mine", bar).getAttribute("aria-pressed")).toBe("false");
    expect(["owner", "tag", "priority", "estimate", "due"].map((kind) => strip(one(`folder-filter-add-${kind}`, bar).textContent))).toEqual([
      "Owner",
      "Tag",
      "Priority",
      "Estimate",
      "Due",
    ]);
    expect(strip(one("folder-filter-count").textContent)).toBe("6 tasks");
    expect(all("folder-filter-clear")).toHaveLength(0);
  });

  test("No owner, from Owner, narrows to every unowned task with 'of' counts and becomes a chip", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    await press(one("folder-filter-add-owner"));
    const menu = await appears("folder-filter-menu-owner");
    expect(strip(menu.textContent)).toMatch(/Me2.*PEOPLE.*@sayo2.*AI HELPERS.*Claude1.*@shay's Claude1.*No owner4/);
    await press(all("folder-filter-option").find((node) => strip(node.textContent).includes("No owner"))!);
    expect(heads()).toEqual(["Backlog1 of 1Ideas and later work, out of the way", "To do1 of 3", "In progress1 of 1", "Finished1 of 1"]);
    // The kitchen stays, dimmed and open, for its one unowned subtask; its notes and the page's notes are not tasks.
    expect(all("folder-subtask").map((node) => strip(node.textContent))).toEqual([expect.stringContaining("Book the health inspection")]);
    expect(all("folder-task-notes-label")).toHaveLength(0);
    expect(all("folder-notes")).toHaveLength(0);
    expect(strip(one("folder-filter-chip-owner").textContent)).toBe("Owner is no owner");
    expect(all("folder-filter-add-owner")).toHaveLength(0);
    expect(strip(one("folder-filter-count").textContent)).toBe("4 of 6");
    expect(writes).toEqual([]);
  });

  test("Tag lists the tags in use; ticked ones show tasks with any of them, and x clears it", async () => {
    await mount(host([]));
    await press(one("folder-filter-add-tag"));
    const menu = await appears("folder-filter-menu-tag");
    expect(all("folder-filter-option", menu).map((node) => strip(node.textContent))).toEqual(["Kitchen1", "Setup1", "Writing1"]);
    await press(all("folder-filter-option", menu)[1]!);
    await press(all("folder-filter-option", menu)[2]!);
    expect(names()).toEqual(["Sign the lease", "Write the opening-day post"]);
    expect(strip(one("folder-filter-chip-tag").textContent)).toBe("Tag is Setup or Writing");
    // Mine too: a task must match every chip.
    await press(one("folder-show-mine"));
    expect(names()).toEqual(["Sign the lease"]);
    expect(strip(one("folder-filter-count").textContent)).toBe("1 of 6 · match every filter");
    await press(one("folder-filter-chip-clear", one("folder-filter-chip-tag")));
    expect(names()).toEqual(["Sign the lease", "Get the kitchen ready"]);
    await press(one("folder-filter-clear"));
    expect(names()).toHaveLength(4);
  });

  test("the search keeps names holding what is typed, and nothing matching offers Clear filters", async () => {
    await mount(host([]));
    await typeInto("folder-filter-search", "LEASE");
    expect(names()).toEqual(["Sign the lease"]);
    await typeInto("folder-filter-search", "zebra");
    expect(strip(one("folder-filter-empty").textContent)).toBe("No tasks match. Clear filters");
    await press(one("folder-filter-empty-clear"));
    expect(names()).toHaveLength(4);
    expect((one("folder-filter-search") as HTMLInputElement).value).toBe("");
  });

  test("Mine is the viewer's, by the handle their address names, and it is remembered here", async () => {
    await mount(host([]));
    await press(one("folder-show-mine"));
    expect(names()).toEqual(["Sign the lease", "Get the kitchen ready"]);
    expect(strip(one("folder-filter-chip-owner").textContent)).toBe("Owner is me");
    roots.pop()!();
    await mount(host([]));
    expect(one("folder-show-mine").getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(localStorage.getItem(FILTER_KEY)!)).toMatchObject({ v: 2, owner: [":me"] });
  });

  test("a choice the old Show bar remembered reads as the filter it meant", async () => {
    localStorage.setItem(FILTER_KEY, "urgent");
    await mount(host([]));
    expect(strip(one("folder-filter-chip-priority").textContent)).toBe("Priority is Urgent");
    expect(names()).toEqual(["Sign the lease"]);
  });

  test("a filter remembered from when there were tasks hides nothing once there are none", async () => {
    localStorage.setItem(FILTER_KEY, "urgent");
    localStorage.setItem(["context.folderView", "ws_test", CAFE].join("\u001f"), "list");
    const page = host([]);
    page.source.load = async () => ({ notes: NOTES.map((each) => ({ ...each, properties: {} })), complete: true });
    await mount(page);
    expect(all("folder-show-bar")).toHaveLength(0);
    expect(all("folder-note").length).toBeGreaterThan(0);
    expect(all("folder-filter-empty")).toHaveLength(0);
  });

  test("Owner's list is searchable, and Me and No owner stay offered", async () => {
    await mount(host([]));
    await press(one("folder-filter-add-owner"));
    await appears("folder-filter-menu-owner");
    await typeInto("folder-filter-menu-field", "sha");
    expect(all("folder-filter-option").map((node) => strip(node.textContent))).toEqual(["Me2", "@shay's Claude1", "?No owner4"]);
    await press(all("folder-filter-option")[1]!);
    expect(strip(one("folder-filter-chip-owner").textContent)).toBe("Owner is @shay's Claude");
    expect(heads()).toEqual(["In progress1 of 1"]);
  });
});
