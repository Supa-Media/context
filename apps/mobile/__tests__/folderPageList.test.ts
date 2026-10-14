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
 * Since 2026-10-14 there is no Notes beside it: the owner merged the two
 * ("they are very similar"), so the switch is List · Board. And for somebody
 * who may write, the dot and the face are the controls: the dot opens the
 * status menu, the face (or an empty dashed one on a task nobody owns) the
 * owner picker.
 *
 * The properties with teeth: a note (no status) gets no dot but keeps the
 * dot's room; pressing a dot or a face changes that task and never opens the
 * row; and a member is shown no control at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { act } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { rowExtras } from "../features/console/files/folderPage/rowExtras";
import { OWNER_SEARCH_DELAY_MS } from "../features/console/files/folderPage/OwnerPicker";
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
  test("is the listing's rows, and nothing else, under a List · Board switch", async () => {
    await mount(host([]));
    expect(one("folder-view-list").getAttribute("aria-selected")).toBe("true");
    expect(all("folder-view-files")).toHaveLength(0);
    expect(strip(one("folder-view-switch").textContent)).toBe("List·Board");
    expect(names().length).toBeGreaterThan(0);
    // None of the old List's furniture.
    for (const gone of ["folder-groups", "folder-show-bar", "folder-search", "folder-band-backlog", "folder-add-task", "folder-item", "folder-note"]) {
      expect(all(gone)).toHaveLength(0);
    }
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
    // A task with no parts has no count, and a task nobody owns shows a writer an empty face to fill.
    expect(within(row("photos"), "folder-row-progress")).toHaveLength(0);
    expect(within(row("photos"), "owner-face-placeholder")).toHaveLength(1);
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

  test("a member reads the same List, with nothing on it to press", async () => {
    await mount(host(null));
    expect(dotOf(row("kitchen"))).toBe("status-dot-in-progress");
    expect(all("folder-add-task")).toHaveLength(0);
    expect(all("folder-row-status")).toHaveLength(0);
    expect(all("folder-row-owner")).toHaveLength(0);
    // Nobody owns it and they could not change that, so there is no empty face either.
    expect(within(row("photos"), "folder-row-extras")).toHaveLength(0);
  });

  test("on a phone, the rows are the card's, each with its icon and then its dot", async () => {
    windowOf(390, 844);
    await mount(host([]));
    expect(dotOf(row("kitchen"))).toBe("status-dot-in-progress");
    expect(strip(within(row("kitchen"), "folder-row-progress")[0]?.textContent)).toBe("2/3");
    expect(all("folder-add-bar")).toHaveLength(0);
    // No pointer to show a note's faint ring under, so a note's room is only room.
    expect(within(row("budget"), "folder-row-status")).toHaveLength(0);
    expect(within(row("lease"), "folder-row-status")).toHaveLength(1);
  });
});

describe("changing a task from its row", () => {
  test("its dot opens the folder's statuses, and a choice writes that task without opening it", async () => {
    const writes: Write[] = [];
    const { selected } = await mount(host(writes));
    const dot = within(row("lease"), "folder-row-status")[0] as HTMLElement;
    expect(dot.getAttribute("aria-label")).toBe("Change status, to do");
    // Not a <button> inside the row's own.
    expect(dot.tagName).not.toBe("BUTTON");
    await press(dot);
    expect(strip(one("menu-root").textContent)).toMatch(/Not started.*In progress.*Done.*finished/);
    await press(all("menu-item-choice:4")[0]!);
    expect(writes).toEqual([[`${CAFE}/lease.md`, "status", "finished", undefined]]);
    expect(selected).toEqual([]);
  });

  test("a note's empty room is a quiet way to give it a status", async () => {
    const writes: Write[] = [];
    await mount(host(writes));
    const room = within(row("budget"), "folder-row-status")[0] as HTMLElement;
    expect(room.getAttribute("aria-label")).toBe("Set status");
    expect(within(room, "folder-row-status-empty")).toHaveLength(1);
    await press(room);
    await press(all("menu-item-choice:2")[0]!);
    expect(writes).toEqual([[`${CAFE}/budget.md`, "status", "to do", undefined]]);
  });

  test("an empty face opens the owner picker, and a pick writes that task's owner", async () => {
    const writes: Write[] = [];
    const { selected } = await mount(host(writes));
    const face = within(row("photos"), "folder-row-owner")[0] as HTMLElement;
    expect(face.getAttribute("aria-label")).toBe("Set owner");
    await press(face);
    // Opening measures the face first, then the picker searches after its own short pause.
    await act(() => new Promise((resolve) => setTimeout(resolve, OWNER_SEARCH_DELAY_MS + 30)));
    for (let tries = 0; tries < 100 && !all("owner-picker-option").some((node) => strip(node.textContent).startsWith("@sayo")); tries += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    expect(all("owner-picker")).toHaveLength(1);
    await press(all("owner-picker-option").find((node) => strip(node.textContent).startsWith("@sayo"))!);
    expect(writes).toEqual([[`${CAFE}/photos.md`, "owner", "@sayo", undefined]]);
    expect(selected).toEqual([]);
  });

  test("a task with one owner changes it from that face; one with several keeps its faces as they are", async () => {
    await mount(host([]));
    expect(within(row("lease"), "folder-row-owner")[0]?.getAttribute("aria-label")).toBe("Change owner, @seyi");
    expect(within(row("kitchen"), "folder-row-owner")).toHaveLength(0);
    expect(within(row("kitchen"), "owner-face-person")).toHaveLength(2);
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
    expect(extras.get("p/empty")).toMatchObject({ tone: "not-started", progress: null, faces: [] });
    expect(extras.get("p/note.md")).toMatchObject({ tone: null, progress: null, faces: [] });
    expect(extras.get("p/one")!.progress).toEqual({ done: 1, total: 4 });
    expect(extras.get("p/one")!.faces).toHaveLength(1);
  });
});
