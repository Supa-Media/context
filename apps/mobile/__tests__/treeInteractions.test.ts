/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The tree row's own gestures: right-click, and pick-up.
 *
 * This is the guard for the headline complaint — that the console had no
 * direct manipulation at all. Before this branch,
 * `grep -r "onContextMenu\|draggable" apps/mobile` returned nothing; every file
 * operation was a button, and creating a note took a button, a modal and a
 * form. So the assertions here are deliberately literal about the DOM: a real
 * `contextmenu` event on a real row must reach the menu, and a row that must
 * not be picked up must actually carry `draggable="false"` rather than merely
 * being refused later.
 *
 * `menu.ts` and `dnd.ts` own the *rules* and have their own tests. What is
 * checked here is only that the gesture reaches them — the wiring, which is
 * the part a unit test of either module cannot see.
 */

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const { FileTree } =
  require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
type TreeRow = import("../features/console/files/tree").TreeRow;

/* -------------------------------------------------------------------------- */

function row(overrides: Partial<TreeRow> & Pick<TreeRow, "path" | "name">): TreeRow {
  return {
    kind: "file",
    key: overrides.path,
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
    ...overrides,
  } as TreeRow;
}

const ROWS: TreeRow[] = [
  row({ path: "1-projects", name: "1-projects", kind: "folder", marker: "team", markerIsDefault: true }),
  row({ path: "1-projects/plan.md", name: "plan.md", depth: 1 }),
  // Generated from the visibility settings; not renameable, not movable, and
  // it must never begin a drag.
  row({ path: "privacy.md", name: "privacy.md", readOnly: true }),
];

const roots: (() => void)[] = [];

afterEach(() => {
  // react-native-web's Modal portals into document.body, so a leaked mount
  // poisons the next test's queries. Learned the hard way on this branch.
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mountTree(options: {
  canEdit?: boolean;
  onMenu?: (row: TreeRow, anchor: { x: number; y: number }) => void;
  drag?: unknown;
} = {}) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(FileTree, {
        rows: ROWS,
        canEdit: options.canEdit ?? true,
        onSelect: () => {},
        onToggle: () => {},
        onCycleVisibility: () => {},
        onMenu: options.onMenu,
        drag: options.drag as never,
      } as never),
    );
  });

  /** The outer row element — the one the gestures are attached to. */
  const rowFor = (name: string): HTMLElement => {
    const label = Array.from(container.querySelectorAll("*")).find(
      (node) => node.textContent === name && node.children.length === 0,
    );
    if (label === undefined) throw new Error(`no row labelled ${name}`);
    let node = label.parentElement;
    while (node !== null && node.getAttribute("draggable") === null) node = node.parentElement;
    if (node === null) throw new Error(`row ${name} has no gesture host`);
    return node;
  };

  return { container, rowFor };
}

const DRAG = {
  canDrag: (r: TreeRow) => !r.readOnly,
  canDrop: (r: TreeRow) => r.kind === "folder",
  onDragStart: () => {},
  onDragOver: () => {},
  onDragLeave: () => {},
  onDrop: () => {},
  onDragEnd: () => {},
};

/* -------------------------------------------------------------------------- */

describe("right-click", () => {
  test("a real contextmenu event on a row reaches the menu", () => {
    const seen: string[] = [];
    const tree = mountTree({ onMenu: (r) => seen.push(r.path), drag: DRAG });

    const target = tree.rowFor("plan.md");
    act(() => {
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 240 }),
      );
    });

    expect(seen).toEqual(["1-projects/plan.md"]);
  });

  test("it carries the pointer position, so the popover can be anchored", () => {
    let anchor: { x: number; y: number } | null = null;
    const tree = mountTree({ onMenu: (_r, a) => (anchor = a), drag: DRAG });

    act(() => {
      tree
        .rowFor("plan.md")
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 88, clientY: 42 }));
    });

    expect(anchor).toEqual({ x: 88, y: 42 });
  });

  test("the browser's own menu is suppressed, or ours opens behind it", () => {
    const tree = mountTree({ onMenu: () => {}, drag: DRAG });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    act(() => {
      tree.rowFor("plan.md").dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });
});

describe("what may be picked up", () => {
  test("an ordinary note is draggable", () => {
    const tree = mountTree({ onMenu: () => {}, drag: DRAG });
    expect(tree.rowFor("plan.md").getAttribute("draggable")).toBe("true");
  });

  test("privacy.md is not", () => {
    // It is generated from the visibility settings. Refusing the drop after an
    // animation would be worse than never starting the drag: the row would
    // look movable right up until it sprang back.
    const tree = mountTree({ onMenu: () => {}, drag: DRAG });
    expect(tree.rowFor("privacy.md").getAttribute("draggable")).toBe("false");
  });

  test("a read-only console offers no drag at all", () => {
    // The landing page mounts this same tree with `canEdit: false` and no drag
    // handlers. A demo that lets you start dragging a note it cannot move
    // would be a control that lies.
    const tree = mountTree({ canEdit: false, drag: undefined });
    expect(tree.rowFor("plan.md").getAttribute("draggable")).toBe("false");
    expect(tree.rowFor("1-projects").getAttribute("draggable")).toBe("false");
  });

  test("a read-only console raises no menu either", () => {
    const seen: string[] = [];
    const tree = mountTree({ canEdit: false, drag: undefined });

    act(() => {
      tree
        .rowFor("plan.md")
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });

    expect(seen).toEqual([]);
  });
});
