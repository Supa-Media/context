/**
 * @jest-environment jsdom
 */

/**
 * A phone's folder page, drawn the way Home draws its lists (board 07 of the
 * Home artboards, approved by the owner on 2026-09-30): a Folders card and a
 * Notes card, a subfolder saying what it holds, a note saying when it changed
 * and its first line, pinned rows on top, and a chevron only on a folder.
 * A pointer layout keeps the tree's own rows.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `FolderView` not passing `phone` to its rows.         → "a note row says when it changed and its first line"
 *  2. `groupsOf` ignoring `phoneRows` (one unlabelled card). → "folders and notes are two headed cards, folders first"
 *  3. The trailing chevron drawn on every card row again.    → "only a folder row has a chevron"
 *  4. `FolderPage` passing `large={false}`.                  → "big on a phone, the note's own size on a pointer layout"
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
const { FolderView } =
  require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");
const { phoneRows } =
  require("../features/console/home/folderRows") as typeof import("../features/console/home/folderRows");

type FileEntry = import("../features/console/files/types").FileEntry;

const NOW = new Date(2026, 8, 30, 15, 0).getTime();

const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

const ROWS = [
  entry("file", "clients/rate-card.md"),
  entry("folder", "clients/acme"),
  entry("file", "clients/brief.md"),
  entry("folder", "clients/bloom"),
];

const META = phoneRows({
  notes: [
    { path: "clients/brief.md", title: "Brief", lede: "Agreed rate for the pilot", tags: [], updatedAt: new Date(2026, 8, 30, 10, 12).getTime() },
    { path: "clients/rate-card.md", title: "Rate card", lede: null, tags: [] },
    { path: "clients/acme/a.md", title: "A", lede: null, tags: [] },
  ],
  folders: ["clients", "clients/acme", "clients/bloom"],
  pins: [{ path: "clients/brief.md", kind: "note" }],
  now: NOW,
});

const live: (() => void)[] = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

function mount(width: number, withRows = true) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  window.dispatchEvent(new Event("resize"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(ThemeProvider, {
        scheme: "light",
        children: createElement(FolderView, {
          entry: entry("folder", "clients"),
          listing: { path: "clients", folderDefault: "team", entries: ROWS, truncated: false, manifestUsable: true },
          canSetVisibility: true,
          contextLabel: "@someone",
          onSelect: () => {},
          ...(withRows ? { phoneRows: META } : {}),
        }),
      }),
    ),
  );
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="folder-row"]'));
  const labels = () => rows().map((row) => row.getAttribute("aria-label"));
  return { rows, labels, text: () => document.body.textContent ?? "" };
}

const chevrons = (row: HTMLElement) => row.querySelectorAll('[data-icon="chevronRight"]').length;

describe("a phone's folder page reads like Home", () => {
  test("folders and notes are two headed cards, folders first, pinned on top", () => {
    const page = mount(390);
    const headers = Array.from(document.querySelectorAll('[role="heading"]')).map((node) => node.textContent);
    expect(headers).toEqual(expect.arrayContaining(["Folders", "Notes"]));
    expect(page.labels()).toEqual([
      "acme, folder, 1 note",
      "bloom, folder, Empty",
      "brief, pinned, Agreed rate for the pilot, 10:12",
      "rate-card",
    ]);
  });

  test("a note row says when it changed and its first line", () => {
    const page = mount(390);
    const brief = page.rows().find((row) => row.getAttribute("aria-label")!.startsWith("brief"))!;
    expect(brief.querySelector('[data-testid="folder-row-sub"]')!.textContent).toBe("Agreed rate for the pilot");
    expect(brief.querySelector('[data-testid="folder-row-meta"]')!.textContent).toBe("10:12");
    expect(brief.querySelector('[data-icon="pin"]')).not.toBeNull();
  });

  test("only a folder row has a chevron", () => {
    const page = mount(390);
    expect(page.rows().map(chevrons)).toEqual([1, 1, 0, 0]);
  });

  test("a pointer layout keeps the tree's rows: no sections, no dates", () => {
    const page = mount(1280);
    expect(page.text()).not.toMatch(/Folders|10:12/);
    expect(page.rows()).toHaveLength(4);
  });
});

describe("a phone's folder page has Home's title", () => {
  const titleSize = () => {
    const heading = Array.from(document.querySelectorAll<HTMLElement>('[role="heading"]')).find(
      (node) => node.textContent === "clients",
    )!;
    return parseFloat(getComputedStyle(heading).fontSize);
  };

  test("big on a phone, the note's own size on a pointer layout", () => {
    const { touchType } = require("../features/design/tokens") as typeof import("../features/design/tokens");
    mount(390);
    expect(titleSize()).toBe(touchType.title);
    live.pop()?.();
    mount(1280);
    expect(titleSize()).toBeLessThan(touchType.title);
  });
});
