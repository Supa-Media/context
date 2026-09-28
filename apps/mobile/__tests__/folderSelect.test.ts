/**
 * @jest-environment jsdom
 */

/**
 * A FOLDER PAGE ON A PHONE CAN PICK SEVERAL ROWS AND ACT ON THEM AS ONE.
 *
 * The owner's phone artboards (2026-09-27, screen 7): a "Select" button in the
 * folder page's header enters a multi-select mode, a long press on a row is the
 * shortcut into it, and what the picked rows can do is exactly what the file
 * tree's multi-selection already offers — the same `menu.ts` items through the
 * same `runMenuAction`, reached through `FolderMenu.onSelection`. Nothing here
 * invents an operation.
 *
 * What is pinned:
 *  - the button is on a phone and nowhere else, and only where there is a menu
 *    to act through (a read-only console has none);
 *  - in select mode a press picks rather than opens;
 *  - the long press enters the mode with that row picked, instead of the row
 *    menu, on a phone — and is still the row menu on a pointer;
 *  - "Actions" hands the picked rows, in listing order, to `onSelection`;
 *  - every target here is a real 44pt box, because `hitSlop` does nothing on
 *    react-native-web.
 *
 * SABOTAGE: `onHold` not passed to `FolderRow` → "a long press enters it"
 * fails; the row's `onPress` left as `onSelect` in select mode → "a press
 * picks" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { layout } from "../features/design/tokens";
import { PressRow } from "../features/design/components/Button";
import { FolderView, type FolderMenu } from "../features/console/files/FolderView";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const FOLDER = "1-projects";

const entry = (name: string, kind: "file" | "folder" = "file"): FileEntry => ({
  kind,
  path: name === "" ? FOLDER : `${FOLDER}/${name}`,
  name: name === "" ? FOLDER : name,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

const listing = (entries: FileEntry[]): FolderListing => ({
  path: FOLDER,
  folderDefault: "team",
  entries,
  truncated: false,
  manifestUsable: true,
});

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

interface Mounted {
  opened: string[];
  rowMenus: string[];
  selections: string[][];
  find: (testID: string) => HTMLElement | null;
  rows: () => HTMLElement[];
  press: (node: Element | null) => void;
  hold: (node: Element | null) => void;
  /** Show another folder in the same page, as opening one from it does. */
  open: (folder: string) => void;
}

function mount(width: number, options: { menu?: boolean } = {}): Mounted {
  setWidth(width);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const opened: string[] = [];
  const rowMenus: string[] = [];
  const selections: string[][] = [];
  const menu: FolderMenu = {
    onRow: (row) => {
      rowMenus.push(row.path);
      return true;
    },
    onBackground: () => false,
    onSelection: (rows) => {
      selections.push(rows.map((row) => row.path));
      return true;
    },
  };
  const render = (folder: FileEntry) => root.render(
      createElement(FolderView, {
        entry: folder,
        listing: listing([entry("alpha.md"), entry("beta.md"), entry("gamma.md")]),
        canSetVisibility: true,
        contextLabel: "@seyi",
        onSelect: (path: string) => {
          opened.push(path);
        },
        ...(options.menu === false ? {} : { menu }),
      }),
    );
  act(() => render(entry("", "folder")));
  const press = (node: Element | null) => {
    if (node === null) throw new Error("nothing to press");
    act(() => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    });
  };
  /*
    A phone browser raises `contextmenu` on a long press, and that is the
    gesture `rowInteractions.web.ts` binds — so this is the long press as the
    web build receives it.
  */
  const hold = (node: Element | null) => {
    if (node === null) throw new Error("nothing to hold");
    act(() => {
      node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
  };
  return {
    opened,
    rowMenus,
    selections,
    find: (testID) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`),
    rows: () => [...container.querySelectorAll<HTMLElement>('[data-testid="folder-row"]')],
    press,
    hold,
    open: (folder) => act(() => render({ ...entry("", "folder"), path: folder, name: folder })),
  };
}

const box = (node: HTMLElement) => {
  const style = window.getComputedStyle(node);
  return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height), minHeight: Number.parseFloat(style.minHeight) };
};

describe("Select on a phone's folder page", () => {
  test("a phone has a Select button, and a pointer layout does not", () => {
    const phone = mount(390);
    expect(phone.find("folder-select")).not.toBeNull();
    expect(phone.find("folder-select")!.textContent).toContain("Select");
    roots.pop()!();

    const desktop = mount(1440);
    expect(desktop.find("folder-select")).toBeNull();
  });

  test("…and not where there is no menu to act through", () => {
    const readOnly = mount(390, { menu: false });
    expect(readOnly.find("folder-select")).toBeNull();
  });

  test("in select mode a press picks rather than opens", () => {
    const app = mount(390);
    app.press(app.find("folder-select"));
    expect(app.find("folder-select-count")!.textContent).toContain("0 selected");

    app.press(app.rows()[1]!);
    expect(app.opened).toEqual([]);
    expect(app.rows()[1]!.getAttribute("aria-label")).toBe("beta, selected");
    expect(app.find("folder-select-count")!.textContent).toContain("1 selected");

    // A second press un-picks.
    app.press(app.rows()[1]!);
    expect(app.rows()[1]!.getAttribute("aria-label")).toBe("beta");
  });

  test("Actions hands the picked rows, in listing order, to the tree's selection menu", () => {
    const app = mount(390);
    app.press(app.find("folder-select"));
    app.press(app.rows()[2]!);
    app.press(app.rows()[0]!);
    app.press(app.find("folder-select-actions"));
    expect(app.selections).toEqual([["1-projects/alpha.md", "1-projects/gamma.md"]]);
  });

  test("opening another folder leaves select mode", () => {
    const app = mount(390);
    app.press(app.find("folder-select"));
    app.press(app.rows()[0]!);
    expect(app.find("folder-select-count")).not.toBeNull();

    app.open("2-areas");
    expect(app.find("folder-select-count")).toBeNull();
    app.press(app.rows()[1]!);
    expect(app.opened).toEqual(["1-projects/beta.md"]);
  });

  test("Actions is not offered with nothing picked", () => {
    const app = mount(390);
    app.press(app.find("folder-select"));
    expect(app.find("folder-select-actions")).toBeNull();
  });

  test("Done leaves the mode, and a press opens again", () => {
    const app = mount(390);
    app.press(app.find("folder-select"));
    app.press(app.rows()[0]!);
    app.press(app.find("folder-select-done"));
    expect(app.find("folder-select-count")).toBeNull();
    expect(app.rows()[0]!.getAttribute("aria-label")).toBe("alpha");
    app.press(app.rows()[0]!);
    expect(app.opened).toEqual(["1-projects/alpha.md"]);
  });

  test("a long press enters it with that row picked, instead of the row menu", () => {
    const app = mount(390);
    app.hold(app.rows()[1]!.parentElement);
    expect(app.rowMenus).toEqual([]);
    expect(app.find("folder-select-count")!.textContent).toContain("1 selected");
    expect(app.rows()[1]!.getAttribute("aria-label")).toBe("beta, selected");
  });

  test("…and on a pointer layout the same gesture is still the row's menu", () => {
    const app = mount(1440);
    app.hold(app.rows()[1]!.parentElement);
    expect(app.rowMenus).toEqual(["1-projects/beta.md"]);
  });

  test("every target is a real 44pt box, not a hit slop", () => {
    const app = mount(390);
    expect(box(app.find("folder-select")!).minHeight).toBeGreaterThanOrEqual(layout.minTouchTarget);
    app.press(app.find("folder-select"));
    app.press(app.rows()[0]!);
    for (const id of ["folder-select-actions", "folder-select-done"]) {
      expect({ id, tall: box(app.find(id)!).minHeight >= layout.minTouchTarget }).toEqual({
        id,
        tall: true,
      });
    }
    for (const row of app.rows()) {
      expect(box(row).height).toBeGreaterThanOrEqual(layout.minTouchTarget);
    }
  });
});

describe("PressRow forwards a long press", () => {
  /*
    `FolderRow` spreads `useRowInteractions`' `onLongPress` into `PressRow`,
    and `PressRow` used to drop it on the floor — so the native long press on
    a folder row did nothing. This is the pass-through, held.
  */
  test("onLongPress reaches the Pressable", () => {
    jest.useFakeTimers();
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      let held = 0;
      act(() => {
        root.render(
          createElement(
            PressRow,
            {
              accessibilityLabel: "row",
              testID: "row",
              onPress: () => {},
              onLongPress: () => {
                held += 1;
              },
              delayLongPress: 100,
              children: null,
            },
          ),
        );
      });
      const node = container.querySelector('[data-testid="row"]')!;
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      act(() => {
        jest.advanceTimersByTime(600);
      });
      act(() => {
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      expect(held).toBe(1);
      act(() => root.unmount());
      container.remove();
    } finally {
      jest.useRealTimers();
    }
  });
});
