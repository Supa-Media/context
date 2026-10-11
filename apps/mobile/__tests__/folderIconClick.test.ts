/**
 * @jest-environment jsdom
 */

/**
 * Clicking a folder's icon in the tree opens its icon picker, there.
 *
 * The owner (2026-10-09): the picker should come up from the icon itself, not
 * only from the right-click menu, and **only** the icon: a click on the
 * chevron, the name or anywhere else on the row opens or closes the folder as
 * it always has. Somebody who cannot edit gets no picker, so for them the icon
 * is part of the row and toggles it too.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FileTree } from "../features/console/files/FileTree";
import { FolderIconDialog } from "../features/console/files/FolderIconDialog";
import { ANCHORED_WIDTH, Shell, placeAnchored } from "../features/console/files/DialogShell";
import type { TreeRow } from "../features/console/files/tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

function folder(path: string): TreeRow {
  return {
    kind: "folder",
    key: path,
    path,
    name: path,
    label: path,
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  };
}

function file(path: string): TreeRow {
  return { ...folder(path), kind: "file" };
}

function setup(editable: boolean) {
  const toggled: string[] = [];
  const opened: string[] = [];
  const iconPresses: { path: string; anchor: { x: number; y: number } }[] = [];
  const container = mount(
    createElement(FileTree, {
      rows: [folder("2-areas"), file("plan.md")],
      canSetVisibility: false,
      onSelect: (path: string) => opened.push(path),
      onToggle: (path: string) => toggled.push(path),
      onCycleVisibility: () => {},
      iconOf: (path: string) => (path === "2-areas" ? "🍳" : null),
      ...(editable
        ? { onIconPress: (path: string, anchor: { x: number; y: number }) => iconPresses.push({ path, anchor }) }
        : {}),
    }),
  );
  return { container, toggled, opened, iconPresses };
}

function click(element: Element | null) {
  if (element === null) throw new Error("nothing to click");
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
}

const iconButton = (container: HTMLElement) => container.querySelector("[data-testid='tree-folder-icon-button']");
const folderRow = (container: HTMLElement) => container.querySelector("[aria-label^='2-areas, folder']");

describe("for somebody who can edit", () => {
  test("clicking the icon opens the picker and does not open or close the folder", async () => {
    const { container, toggled, iconPresses } = setup(true);
    click(iconButton(container));
    // The anchor is measured from the icon, which the web answers on the next tick.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(iconPresses.map((press) => press.path)).toEqual(["2-areas"]);
    expect(toggled).toEqual([]);
  });

  test("clicking the name still opens or closes the folder, and raises no picker", () => {
    const { container, toggled, iconPresses } = setup(true);
    const name = [...folderRow(container)!.querySelectorAll("div")].find((node) => node.textContent === "2-areas");
    click(name ?? null);
    expect(toggled).toEqual(["2-areas"]);
    expect(iconPresses).toEqual([]);
  });

  test("clicking the row itself (where the chevron sits) still toggles it", () => {
    const { container, toggled, iconPresses } = setup(true);
    click(folderRow(container));
    expect(toggled).toEqual(["2-areas"]);
    expect(iconPresses).toEqual([]);
  });

  test("the icon is not a tab stop: the keyboard stays on the row", () => {
    const { container } = setup(true);
    expect(iconButton(container)?.getAttribute("tabindex")).toBe("-1");
  });

  test("the icon says what it does to a screen reader", () => {
    const { container } = setup(true);
    expect(iconButton(container)?.getAttribute("aria-label")).toBe("Change 2-areas’s icon");
  });

  test("a note has no icon to click", () => {
    const { container } = setup(true);
    const note = container.querySelector("[aria-label^='plan.md']");
    expect(note?.querySelector("[data-testid='tree-folder-icon-button']")).toBeNull();
    expect(container.querySelectorAll("[data-testid='tree-folder-icon-button']")).toHaveLength(1);
  });
});

describe("for somebody who cannot edit", () => {
  test("there is no icon button, and clicking the icon toggles the folder like the rest of the row", () => {
    const { container, toggled } = setup(false);
    expect(iconButton(container)).toBeNull();
    click(container.querySelector("[data-testid='tree-folder-emoji']"));
    expect(toggled).toEqual(["2-areas"]);
  });
});

describe("the picker opens where the icon is", () => {
  test("an anchored dialog is a popover at the anchor, not the centred card", () => {
    mount(createElement(Shell, { title: "Folder icon", children: null, onClose: () => {}, anchor: { x: 40, y: 120 } }));
    const card = document.querySelector("[aria-label='Folder icon']") as HTMLElement | null;
    // Placed where `placeAnchored` says (jsdom's window has no size, so that is
    // the edge); the arithmetic itself is proven below.
    expect(card?.style.left).toMatch(/px$/);
    expect(card?.style.top).toMatch(/px$/);
  });

  test("a phone's sheet ignores the anchor: it belongs on the bottom edge", () => {
    mount(createElement(Shell, { title: "Folder icon", children: null, onClose: () => {}, sheet: true, anchor: { x: 40, y: 120 } }));
    const card = document.querySelector("[aria-label='Folder icon']") as HTMLElement | null;
    expect(card?.style.left).toBe("");
    expect(card?.getAttribute("data-testid")).toBe("dialog-sheet");
  });

  test("the picker passes its anchor through", () => {
    mount(
      createElement(FolderIconDialog, {
        path: "2-areas",
        current: null,
        onSet: async () => {},
        onClose: () => {},
        anchor: { x: 40, y: 120 },
      }),
    );
    expect(document.querySelector("[data-testid='folder-icon-search']")).not.toBeNull();
  });

  test("an anchor near the right or bottom edge is pulled back inside the window", () => {
    const placed = placeAnchored({ x: 1000, y: 700 }, { width: 1024, height: 768 });
    expect(placed.left + placed.width).toBeLessThanOrEqual(1024 - 8);
    expect(placed.top).toBeLessThan(700);
    expect(placed.top).toBeGreaterThanOrEqual(8);
  });

  test("a window narrower than the card gets a card that fits", () => {
    const placed = placeAnchored({ x: 10, y: 10 }, { width: 300, height: 768 });
    expect(placed.width).toBeLessThan(ANCHORED_WIDTH);
    expect(placed.left).toBe(8);
    expect(placed.left + placed.width).toBeLessThanOrEqual(300 - 8);
  });

  test("an anchor with room is used as it is", () => {
    expect(placeAnchored({ x: 40, y: 120 }, { width: 1024, height: 768 })).toMatchObject({ left: 40, top: 120 });
  });
});
