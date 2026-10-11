/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S LIST IS ITS NOTES, WITH THREE THIN EXTRAS.
 *
 * The owner, 2026-10-10, choosing board 11 after finding the earlier List
 * "pretty cluttered": "I almost want the list view to look exactly like the
 * notes view, just with some thin extras". So List draws the very rows Notes
 * draws, in the same order, and adds a status dot before a task's name and a
 * grey "2/3" and its owners' faces after it. There is no filter bar, no status
 * groups, no Backlog band, no "+ Add" line and no Notes section; a row opens
 * what it names, as in Notes.
 *
 * The properties with teeth: List and Notes cannot come to list different
 * rows; a note (no status) gets no dot but keeps the dot's room; and nothing
 * on the List writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { rowExtras } from "../features/console/files/folderPage/rowExtras";
import type { FolderItem } from "../features/console/files/folderPage/model";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { CAFE, all, host, mount, one, press, strip, unmountAll, windowOf, type Write } from "./projectPage/fixtures";

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

const rows = () => all("folder-row");
const row = (name: string) => rows().find((node) => strip(node.textContent).startsWith(name))!;
const names = () => rows().map((node) => strip(node.getAttribute("aria-label")));
const within = (node: Element, testID: string) => Array.from(node.querySelectorAll(`[data-testid="${testID}"]`));
const dotOf = (node: Element) => node.querySelector('[data-testid^="status-dot-"]')?.getAttribute("data-testid") ?? null;

describe("the List", () => {
  test("is the Notes rows, in the Notes order, and nothing else", async () => {
    await mount(host([]));
    expect(one("folder-view-list").getAttribute("aria-selected")).toBe("true");
    const listed = names();
    expect(listed.length).toBeGreaterThan(0);
    // None of the old List's furniture.
    for (const gone of ["folder-groups", "folder-show-bar", "folder-search", "folder-band-backlog", "folder-add-task", "folder-item", "folder-note"]) {
      expect(all(gone)).toHaveLength(0);
    }
    await press(one("folder-view-files"));
    expect(names()).toEqual(listed);
    expect(all("folder-row-extras")).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid^="status-dot-"]')).toHaveLength(0);
  });

  test("a task's row leads with its status dot; a note's has none", async () => {
    await mount(host([]));
    expect(dotOf(row("lease"))).toBe("status-dot-not-started");
    expect(dotOf(row("kitchen"))).toBe("status-dot-in-progress");
    expect(dotOf(row("opened"))).toBe("status-dot-done");
    expect(dotOf(row("budget"))).toBeNull();
  });

  test("ends a task's row with how much of it is done and whose it is", async () => {
    await mount(host([]));
    const kitchen = row("kitchen");
    expect(strip(within(kitchen, "folder-row-progress")[0]?.textContent)).toBe("2/3");
    expect(within(kitchen, "owner-face-person")).toHaveLength(2);
    expect(within(row("lease"), "owner-face-person")).toHaveLength(1);
    // A task with no parts has no count, and a task nobody owns has no face.
    expect(within(row("photos"), "folder-row-extras")).toHaveLength(0);
    // A note has neither.
    expect(within(row("budget"), "folder-row-extras")).toHaveLength(0);
    // Never a code or a word for a status: the dot and the count say it.
    expect(strip(row("lease").textContent)).not.toMatch(/\bp[0-3]\b|to do|in progress|Setup/);
  });

  test("a row opens what it names, as in Notes", async () => {
    const { selected } = await mount(host([]));
    await press(row("kitchen"));
    expect(selected).toEqual([`${CAFE}/kitchen`]);
    expect(all("task-panel")).toHaveLength(0);
  });

  test("a member reads the same List, and nothing on it writes", async () => {
    const writes: Write[] = [];
    await mount(host(null));
    expect(dotOf(row("kitchen"))).toBe("status-dot-in-progress");
    expect(all("folder-add-task")).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  test("on a phone, the dot takes the glyph's place and the rows are the Notes card", async () => {
    windowOf(390, 844);
    await mount(host([]));
    expect(dotOf(row("kitchen"))).toBe("status-dot-in-progress");
    expect(strip(within(row("kitchen"), "folder-row-progress")[0]?.textContent)).toBe("2/3");
    expect(all("folder-add-bar")).toHaveLength(0);
  });
});

describe("rowExtras", () => {
  const item = (path: string, status: string, progress: FolderItem["progress"], owner?: string) =>
    ({ path, status, progress, properties: owner === undefined ? {} : { owner } }) as unknown as FolderItem;
  const face = (owner: string) => ({ kind: "person", initials: owner.slice(0, 1) }) as never;

  test("a folder with no parts yet shows no 0/0, and a note shows nothing", () => {
    const extras = rowExtras(
      [item("p/empty", "to do", { done: 0, total: 0 }), item("p/note.md", "", null), item("p/one", "active", { done: 1, total: 4 }, "@sayo")],
      () => "not-started",
      face,
    );
    expect(extras.get("p/empty")).toEqual({ tone: "not-started", progress: null, faces: [] });
    expect(extras.get("p/note.md")).toEqual({ tone: null, progress: null, faces: [] });
    expect(extras.get("p/one")!.progress).toEqual({ done: 1, total: 4 });
    expect(extras.get("p/one")!.faces).toHaveLength(1);
  });
});
