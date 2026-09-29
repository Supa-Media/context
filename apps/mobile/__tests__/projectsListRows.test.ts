/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S ROW, AND THE BACKLOG FOLDER, ON THE MOUNTED PAGE.
 *
 * Reported by the owner on 2026-09-28: the List's names were squeezed to
 * nothing ("I cant even read the tasks"), the Backlog folder was a project
 * of its own instead of a place to drag things into, and "I also cant inline
 * edit the priority anymore?". So, on the real `FolderView`:
 *
 *  - a row's name grows and keeps `NAME_MIN`, and its progress never wraps
 *    (the widths themselves take a browser: `e2e/webkit/projectsList.spec.ts`);
 *  - the priority mark is a button for a writer, opening the five priorities,
 *    written the row's own way with an Undo; a member sees the mark alone;
 *  - status and owner are still changed on the row;
 *  - `backlog/` is the Backlog band — a drop moves the row in, with Undo — and
 *    a writer has the band even while it is empty.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { NAME_MIN } from "../features/console/files/folderPage/rowCells";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import {
  CAFE,
  LISTING,
  all,
  entry,
  host,
  mount,
  note,
  one,
  press,
  strip,
  unmountAll,
  windowOf,
  type Toast,
  type Write,
} from "./projectPage/fixtures";

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
const frameOf = (node: HTMLElement) => node.closest<HTMLElement>('[data-testid="task-row-frame"]')!;
const settle = async () => {
  await act(async () => {});
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
};

describe("the row gives its name the room", () => {
  test("the name grows and keeps its least width, and the progress stays one line beside it", async () => {
    await mount(host([], { files: [] }));
    const name = getComputedStyle(one("folder-item-name", row("Get the kitchen ready")));
    expect(name.flexGrow).toBe("1");
    expect(name.minWidth).toBe(`${NAME_MIN}px`);
    const progress = one("folder-item-progress", row("Get the kitchen ready"));
    expect(strip(progress.textContent)).toMatch(/^\d+\/\d+$/);
    expect(getComputedStyle(one("progress-track", progress)).width).toBe("40px");
    // A column of its own after the name, the same width on every row, so the bars line up.
    expect(one("folder-item-name", row("Get the kitchen ready")).contains(progress)).toBe(false);
    expect(getComputedStyle(progress.parentElement!).width).toBe("88px");
    expect(getComputedStyle(progress).flexShrink).toBe("0");
    expect(getComputedStyle(progress).whiteSpace).toBe("nowrap");
  });

  test("the hover tools lie over the name rather than taking a column of their own", async () => {
    await mount(host([], { files: [] }));
    const tools = one("folder-row-tools", row("Sign the lease"));
    expect(getComputedStyle(tools).position).toBe("absolute");
    expect(one("folder-item-name", row("Sign the lease")).contains(tools)).toBe(true);
  });

  test("a keyboard's focus on a tool shows it (the room it then takes needs a browser's layout)", async () => {
    await mount(host([], { files: [] }));
    const peek = one("folder-row-peek", row("Sign the lease"));
    expect(getComputedStyle(peek).opacity).toBe("0");
    // jsdom has no `:focus-visible`, so every focus here counts as the keyboard's (`keyboardFocus`).
    await act(async () => peek.focus());
    await settle();
    expect(getComputedStyle(one("folder-row-peek", row("Sign the lease"))).opacity).not.toBe("0");
  });
});

describe("priority, status and owner are changed on the row", () => {
  test("a writer presses the priority mark, picks from the five, and it is written with an Undo", async () => {
    const writes: Write[] = [];
    const toasts: Toast[] = [];
    await mount(host(writes, { files: [], toasts }));
    const mark = one("folder-item-priority", row("Take photos"));
    expect(mark.getAttribute("role")).toBe("button");
    expect(mark.getAttribute("aria-label")).toBe("Change priority, Medium");
    await press(mark);
    const labels = [...document.querySelectorAll('[data-testid^="menu-label-"]')].map((item) => strip(item.textContent));
    expect(labels).toEqual(["Urgent", "High", "Medium", "Low", "No priority"]);
    await press(one("menu-item-p0"));
    await settle();
    expect(writes).toEqual([[`${CAFE}/photos.md`, "priority", "p0", undefined]]);
    expect(toasts.at(-1)!.message).toContain("Urgent");
    await act(async () => void (await toasts.at(-1)!.undo!()));
    expect(writes.at(-1)).toEqual([`${CAFE}/photos.md`, "priority", "p2", undefined]);
  });

  test("No priority takes it away", async () => {
    const writes: Write[] = [];
    await mount(host(writes, { files: [] }));
    await press(one("folder-item-priority", row("Sign the lease")));
    await press(one("menu-item-none"));
    await settle();
    expect(writes).toEqual([[`${CAFE}/lease.md`, "priority", null, undefined]]);
  });

  test("a member sees the mark and cannot press it", async () => {
    await mount(host(null));
    expect(all("folder-item-priority")).toHaveLength(0);
    expect(all("priority-urgent", row("Sign the lease")).length).toBeGreaterThan(0);
  });

  test("status and owner are still buttons on a writer's row", async () => {
    await mount(host([], { files: [] }));
    expect(one("folder-item-status", row("Sign the lease")).getAttribute("role")).toBe("button");
    expect(one("folder-item-owner", row("Sign the lease")).getAttribute("role")).toBe("button");
  });
});

/** A projects folder: two projects, and a `Backlog` folder holding one. */
const P = "1-projects";
const PROJECTS_NOTES: ListNote[] = [
  { path: `${P}/cafe/overview.md`, properties: { status: "in progress" }, updatedAt: 1, heading: "Café opening" },
  { path: `${P}/menu/overview.md`, properties: { status: "to do" }, updatedAt: 1, heading: "Summer menu" },
  { path: `${P}/Backlog/overview.md`, properties: {}, updatedAt: 1, heading: "Backlog" },
  { path: `${P}/Backlog/podcast/overview.md`, properties: { status: "idea" }, updatedAt: 1, heading: "Podcast" },
];
const PROJECTS = { ...LISTING, path: P, entries: [entry("folder", `${P}/cafe`), entry("folder", `${P}/menu`), entry("folder", `${P}/Backlog`)] };

function dragEvent(type: string, data: Map<string, string>, clientY = 5): Event {
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

async function dropOn(from: HTMLElement, onto: HTMLElement) {
  const data = new Map<string, string>();
  onto.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
  await act(async () => void from.dispatchEvent(dragEvent("dragstart", data)));
  for (const type of ["dragenter", "dragover", "drop"]) await act(async () => void onto.dispatchEvent(dragEvent(type, data)));
  await act(async () => void from.dispatchEvent(dragEvent("dragend", data)));
  await settle();
}

describe("the Backlog folder on the page", () => {
  test("is the Backlog band, first, counting what it holds, and not a project of its own", async () => {
    await mount(host([], { files: [], notes: PROJECTS_NOTES }), PROJECTS);
    const band = all("folder-band")[0]!;
    expect(strip(band.textContent)).toMatch(/^Backlog\s*1/);
    expect(all("folder-item").map((node) => strip(node.textContent))).not.toContainEqual(expect.stringMatching(/^Backlog/));
    await press(band);
    expect(row("Podcast")).toBeDefined();
  });

  test("a row dropped on the band moves into the folder, and Undo moves it back", async () => {
    const files: string[] = [];
    const toasts: Toast[] = [];
    await mount(host([], { files, toasts, notes: PROJECTS_NOTES }), PROJECTS);
    await dropOn(frameOf(row("Summer menu")), all("folder-band")[0]!.parentElement!);
    expect(files).toEqual([`move ${P}/menu -> ${P}/Backlog/menu`]);
    expect(toasts.at(-1)!.message).toBe("Moved “Summer menu” to Backlog.");
    await act(async () => void (await toasts.at(-1)!.undo!()));
    expect(files.at(-1)).toBe(`move ${P}/Backlog/menu -> ${P}/menu`);
  });

  test("an empty folder is still a band a writer can drop on, and nothing to a member", async () => {
    const empty = PROJECTS_NOTES.filter((each) => !each.path.startsWith(`${P}/Backlog/podcast`));
    await mount(host([], { files: [], notes: empty }), PROJECTS);
    expect(strip(all("folder-band")[0]!.textContent)).toContain("Drop here to park");
    unmountAll();
    await mount(host(null, { notes: empty }), PROJECTS);
    expect(all("folder-band").map((node) => strip(node.textContent))).not.toContainEqual(expect.stringContaining("Backlog"));
  });

  test("without a folder, a writer's page with the backlog word keeps its band and parks by status", async () => {
    const writes: Write[] = [];
    const toasts: Toast[] = [];
    const notes = [note("lease.md", { status: "to do" }, 1, "Sign the lease"), note("photos.md", { status: "to do" }, 1, "Take photos")];
    const listing = { ...LISTING, entries: [entry("file", `${CAFE}/lease.md`), entry("file", `${CAFE}/photos.md`)] };
    await mount(host(writes, { files: [], toasts, notes }), listing);
    expect(strip(all("folder-band")[0]!.textContent)).toContain("Backlog");
    await dropOn(frameOf(row("Sign the lease")), all("folder-band")[0]!.parentElement!);
    expect(writes.at(-1)).toEqual([`${CAFE}/lease.md`, "status", "backlog", undefined]);
  });
});
