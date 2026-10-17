/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import { emptyEditor } from "../features/console/files/editor";
import { narrowTree } from "../features/console/files/treeFilter";

/**
 * THE FILE TREE'S HEADER IS THE SAME HEADER WHETHER OR NOT A POINTER IS NEAR.
 *
 * It used to draw on approach: entering the column faded `Notes` out, gave an
 * invisible filter field under it a box, and faded in new-folder and sort. The
 * owner asked for it to stay the same (2026-09-26) and chose the design this
 * file holds: `Notes`, then New and View, drawn once, as menus. The filter
 * magnifier went when search became one bar (leadership weekly, 2026-10-17):
 * ⌘K's Tab narrows the tree, and the label's place then says so, with Clear.
 *
 * jsdom lays nothing out and has no `PointerEvent`, so what is asserted here is
 * structure and behaviour on press. That the header does not change when the
 * pointer enters the column is measured in a real engine in
 * `e2e/webkit/explorerChrome.spec.ts`; the structural half is here — nothing in
 * the header is drawn at opacity 0 waiting for a pointer, and the column has
 * no pointer-enter handler left to drive one.
 */

const METRICS =
  initialWindowMetrics ??
  ({
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
  } as never);

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const noop = () => {};

/**
 * The least `FileBrowser` the header reads.
 *
 * `canEdit` decides whether New is offered at all, so it is `true` unless a
 * case says otherwise — a header with nothing in it would make the cases below
 * pass by finding nothing.
 */
function browser(calls: string[] = []): FileBrowser {
  return {
    createUntitled: (folder: string, kind: string) => calls.push(`createUntitled ${folder}|${kind}`),
    collapseAll: () => calls.push("collapseAll"),
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "note" as const,
            path: "index.md",
            name: "index.md",
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: noop,
    selectedPath: null,
    select: noop,
    deselect: () => true,
    editor: emptyEditor,
    setDraft: noop,
    save: noop,
    useTheirs: noop,
    keepMine: noop,
    conflict: null,
    resolveWith: noop,
    discard: noop,
    notice: null,
    dismissNotice: noop,
    toasts: [],
    dismissToast: noop,
    clipboard: null,
    copy: noop,
    cut: noop,
    paste: noop,
    createNote: noop,
    createFolder: noop,
    rename: noop,
    move: noop,
    duplicate: noop,
    archive: noop,
    destroy: noop,
    setVisibility: noop,
  } as unknown as FileBrowser;
}

function mount(calls: string[] = [], canEdit = true): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(
        SafeAreaProvider,
        { initialMetrics: METRICS },
        createElement(Explorer, {
          files: { ...browser(calls), canEdit },
          contextLabel: "@somebody",
        }),
      ),
    );
  });
  return container;
}

/** The resolved value react-native-web actually gave this node. */
function styleOf(node: Element, property: string): string {
  return window.getComputedStyle(node).getPropertyValue(property);
}

const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function press(node: Element | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function pressLabelled(label: string): void {
  press(
    [...document.body.querySelectorAll("*")].find(
      (node) => node.textContent?.trim() === label && node.children.length === 0,
    ) ?? null,
  );
}

/* -------------------------------------------------------------------------- */

describe("the tree's header", () => {
  test("is the column's name and two buttons, and nothing waits for a pointer", () => {
    const container = mount();
    const header = byId("explorer-header")!;

    expect(header.textContent).toContain("Notes");
    for (const id of ["explorer-new", "explorer-view"]) {
      expect(header.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    // One search bar: the tree has no field and no magnifier of its own.
    expect(byId("explorer-filter-toggle")).toBeNull();
    expect(header.querySelector("input")).toBeNull();
    // The reversal guard for the approach fade. Every node in the header is
    // drawn at rest; a group parked at opacity 0 for a pointer to light is
    // exactly what the owner asked to be rid of.
    for (const node of [header, ...header.querySelectorAll("*")]) {
      expect(styleOf(node, "opacity")).not.toBe("0");
    }
    // And the two controls that only ever arrived on approach are gone from
    // the header rather than faded: they are menu rows now.
    expect(container.querySelector('[data-testid="explorer-new-folder"]')).toBeNull();
    expect(container.querySelector('[data-testid="explorer-sort"]')).toBeNull();
  });

  test("a reader gets View, and no New", () => {
    mount([], false);
    expect(byId("explorer-new")).toBeNull();
    expect(byId("explorer-view")).not.toBeNull();
  });
});

describe("⌘K's Tab narrows the tree", () => {
  test("the label's place says what it shows, and Clear puts the whole tree back", () => {
    const container = mount();
    expect(byId("explorer-narrowed")).toBeNull();

    act(() => narrowTree("plan"));
    expect(byId("explorer-narrowed")!.textContent).toContain("Names with “plan”");
    // The tree is narrowed to names with the words: index.md is not one.
    expect(container.textContent).not.toContain("index");

    press(byId("explorer-filter-clear"));
    expect(byId("explorer-narrowed")).toBeNull();
    expect(container.textContent).toContain("Notes");
    expect(container.textContent).toContain("index");
  });

  test("with no tree mounted, asking narrows nothing and throws nothing", () => {
    expect(() => narrowTree("plan")).not.toThrow();
  });
});

describe("New and View are menus", () => {
  test("New offers a note, a folder and a drawing, and a note is made where it says", () => {
    const calls: string[] = [];
    mount(calls);

    press(byId("explorer-new"));
    for (const label of ["New note", "New folder", "New drawing"]) {
      expect(document.body.textContent).toContain(label);
    }
    pressLabelled("New note");
    expect(calls).toEqual(["createUntitled |note"]);
  });

  test("View holds sort order and collapse-all", () => {
    const calls: string[] = [];
    mount(calls);

    press(byId("explorer-view"));
    expect(document.body.textContent).toContain("Sort A to Z");
    expect(document.body.textContent).toContain("Sort Z to A");
    pressLabelled("Collapse all folders");
    expect(calls).toEqual(["collapseAll"]);
  });
});
