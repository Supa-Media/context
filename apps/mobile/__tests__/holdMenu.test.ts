/**
 * @jest-environment jsdom
 */

/**
 * PRESS AND HOLD ON A PHONE ROW IS APPLE NOTES' LIFTED PREVIEW AND SHORT MENU.
 *
 * The owner's board of 2026-10-16: the held note or folder lifts as a card,
 * and a menu sits under it with Share, Move and Delete across the top, the
 * everyday verbs in a list, Select on its own, and More for the rest.
 *
 * What is pinned:
 *  - the arrangement takes `menu.ts`'s own items and invents none: every item
 *    the row menu offers is either placed or behind More, and Open is the
 *    card itself;
 *  - Delete is the trash (with Undo) in the top row, and an archived row's
 *    Restore heads the list;
 *  - a built-in folder's dimmed Archive and Delete stay explanations under
 *    More, never live keys, while its Move and Rename are live;
 *  - a phone row may be shared, a folder included, where the pointer tree
 *    still offers a folder no Share;
 *  - the drawn menu: the card opens, the keys run their ids, Select and More
 *    appear only when given.
 *
 * SABOTAGE: drop the `more` loop in `holdLayout` → "nothing the row menu
 * offers is lost" fails; take `restore` out of the list → "an archived
 * note" fails.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { holdLayout, holdPreview, type HoldLayout } from "../features/console/files/holdLayout";
import { HoldMenu } from "../features/console/files/HoldMenu";
import { itemsFor, type MenuContext, type MenuItem } from "../features/console/files/menu";
import type { TreeRow } from "../features/console/files/tree";
import type { HomeNote } from "../features/console/home/homeModel";

function row(path: string, kind: "file" | "folder"): TreeRow {
  return {
    key: path,
    path,
    name: path.split("/").pop()!,
    label: path.split("/").pop()!.replace(/\.md$/, ""),
    kind,
    depth: 0,
    expanded: false,
    selected: false,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  } as unknown as TreeRow;
}

function items(target: TreeRow, overrides: Partial<MenuContext> = {}): MenuItem[] {
  return itemsFor({
    target: { kind: "row", row: target },
    canEdit: true,
    canSetVisibility: true,
    canShare: true,
    canDownload: true,
    clipboard: null,
    platform: "touch",
    topLevelFolders: ["0-inbox", "1-projects"],
    pinned: () => false,
    ...overrides,
  });
}

const ids = (list: readonly MenuItem[]) => list.map((item) => item.id);

describe("the hold menu's arrangement", () => {
  test("a note: Share, Move, Delete across the top, the everyday verbs under them", () => {
    const layout = holdLayout(items(row("1-projects/kings/kings-12.md", "file")));
    expect(layout.top.map((item) => item.label)).toEqual(["Share", "Move", "Delete"]);
    expect(layout.top.find((item) => item.id === "delete")!.danger).toBe(true);
    expect(layout.main.map((item) => item.label)).toEqual(["Pin to Home", "Rename", "Duplicate", "Icon"]);
  });

  test("nothing the row menu offers is lost: each item is placed or behind More, and Open is the card", () => {
    const offered = items(row("1-projects/kings/kings-12.md", "file"));
    const layout = holdLayout(offered);
    const shown = new Set([...ids(layout.top), ...ids(layout.main), ...ids(layout.more)]);
    for (const id of ids(offered)) {
      if (id === "open") continue;
      expect({ id, shown: shown.has(id) }).toEqual({ id, shown: true });
    }
    expect(shown.has("open")).toBe(false);
    expect(ids(layout.more)).toEqual(expect.arrayContaining(["copyPath", "download", "archive"]));
    expect(layout.more[0]!.separatorBefore).toBeUndefined();
  });

  test("a folder: Share too on a phone, and New note here in the list", () => {
    const layout = holdLayout(items(row("1-projects/kings", "folder")));
    expect(layout.top.map((item) => item.label)).toEqual(["Share", "Move", "Delete"]);
    expect(ids(layout.main)).toEqual(["pin", "rename", "duplicate", "newNote", "setIcon"]);
  });

  test("a pointer's row menu still offers a folder no Share", () => {
    expect(ids(items(row("1-projects/kings", "folder"), { platform: "web" }))).not.toContain("share");
    expect(ids(items(row("1-projects/kings/kings-12.md", "file"), { platform: "web" }))).toContain("share");
  });

  test("a built-in folder: Move and Rename live, no live Delete, and the explanations are under More", () => {
    const layout = holdLayout(items(row("1-projects", "folder")));
    expect(ids(layout.top)).toEqual(["share", "moveTo"]);
    expect(ids(layout.main)).toContain("rename");
    expect(layout.more.filter((item) => item.disabled === true).map((item) => item.id)).toEqual(["archive", "delete"]);
  });

  test("an archived note: Restore heads the list", () => {
    const layout = holdLayout(items(row("9-archive/2026-10-01T00-00-00-000Z/1-projects/old.md", "file")));
    expect(layout.main[0]!.label).toBe("Restore");
    expect(ids(layout.more)).not.toContain("restore");
  });

  test("someone who cannot edit: no top row of writes, Pin and the reads remain", () => {
    const layout = holdLayout(items(row("1-projects/kings/kings-12.md", "file"), { canEdit: false, canShare: false }));
    expect(layout.top).toEqual([]);
    expect(ids(layout.main)).toEqual(["pin"]);
    expect(ids(layout.more)).toEqual(["copyPath", "copyAtPath", "download"]);
  });
});

describe("the lifted preview", () => {
  const NOW = new Date(2026, 9, 16, 12, 0).getTime();
  const notes: HomeNote[] = [
    { path: "kings/kings-12.md", title: "kings-12", lede: "Joash is king in Judah.", tags: [], updatedAt: NOW - 86_400_000 * 3 },
    { path: "kings/kings-20.md", title: "kings-20", lede: "Hezekiah is sick.", tags: [], updatedAt: NOW - 3_600_000 },
    { path: "kings/old/kings-1.md", title: "kings-1", lede: null, tags: [], updatedAt: NOW - 86_400_000 * 20 },
    { path: "kings/kings-15.md", title: "kings-15", lede: "Speed running.", tags: [], updatedAt: NOW - 86_400_000 },
    { path: "other.md", title: "other", lede: null, tags: [] },
  ];

  test("a note shows its title, its folder and its opening", () => {
    const preview = holdPreview({ kind: "file", path: "kings/kings-12.md", name: "kings-12.md" }, notes, [], NOW);
    expect(preview).toMatchObject({ kind: "note", title: "kings-12", text: "Joash is king in Judah." });
    expect(preview.kind === "note" && preview.meta?.startsWith("kings · ")).toBe(true);
  });

  test("a note this device knows nothing of still lifts, with its name", () => {
    expect(holdPreview({ kind: "file", path: "x/new-one.md", name: "new-one.md" }, [], [], NOW)).toMatchObject({
      kind: "note",
      title: "new-one",
      text: null,
    });
  });

  test("a folder shows its count and its three newest notes, nested ones included", () => {
    const preview = holdPreview({ kind: "folder", path: "kings", name: "kings" }, notes, ["kings", "kings/old"], NOW);
    expect(preview.kind).toBe("folder");
    if (preview.kind !== "folder") return;
    expect(preview.meta.startsWith("4 notes · 1 folder")).toBe(true);
    expect(preview.notes.map((note) => note.title)).toEqual(["kings-20", "kings-15", "kings-12"]);
  });
});

describe("the drawn hold menu", () => {
  const roots: (() => void)[] = [];
  afterEach(() => {
    while (roots.length > 0) roots.pop()!();
    document.body.innerHTML = "";
  });

  function draw(layout: HoldLayout, extra: { select?: boolean; more?: boolean } = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    const log: string[] = [];
    act(() =>
      root.render(
        createElement(
          SafeAreaProvider,
          { initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } } },
          createElement(HoldMenu, {
          preview: { kind: "note", title: "kings-12", meta: "kings · Mon", text: "Joash is king." },
          layout,
          onOpen: () => log.push("open"),
          onRun: (id) => log.push(`run:${id}`),
          onDismiss: () => log.push("dismiss"),
          ...(extra.select === true ? { onSelectMany: () => log.push("select") } : {}),
          ...(extra.more === true ? { onMore: () => log.push("more") } : {}),
          }),
        ),
      ),
    );
    const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const press = (id: string) =>
      act(() => {
        const node = find(id);
        if (node === null) throw new Error(`no ${id}`);
        for (const type of ["mousedown", "mouseup", "click"]) node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      });
    return { log, find, press };
  }

  const LAYOUT = holdLayout(items(row("1-projects/kings/kings-12.md", "file")));

  test("the card shows the note and opens it", () => {
    const menu = draw(LAYOUT);
    expect(menu.find("hold-menu-preview")!.textContent).toContain("Joash is king.");
    menu.press("hold-menu-preview");
    expect(menu.log).toEqual(["dismiss", "open"]);
  });

  test("a key closes the menu and runs its own id", () => {
    const menu = draw(LAYOUT);
    menu.press("hold-menu-delete");
    menu.press("hold-menu-pin");
    expect(menu.log).toEqual(["dismiss", "run:delete", "dismiss", "run:pin"]);
  });

  test("Select and More are drawn only when there is something behind them", () => {
    const bare = draw(LAYOUT);
    expect(bare.find("hold-menu-select")).toBeNull();
    expect(bare.find("hold-menu-more")).toBeNull();
    const full = draw(LAYOUT, { select: true, more: true });
    full.press("hold-menu-select");
    full.press("hold-menu-more");
    expect(full.log).toEqual(["dismiss", "select", "more"]);
  });
});
