/**
 * @jest-environment jsdom
 */

/**
 * A built-in folder's drawn icon, drawn: in the tree, on a listing row, on
 * Home's folder line and at the top of its page (boards 8 and 9 of the system
 * folders set). Every one of them gets it through the folder's icon
 * (`jobIconMarker`), so this proves the marker turns into the drawing and is
 * never shown as text, that the tree's glyph is not a button for one (a
 * built-in folder cannot take another icon), and that the page says which
 * built-in folder a renamed one is.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { FileTree } from "../features/console/files/FileTree";
import { FolderRow } from "../features/console/files/FolderRow";
import { FolderHead } from "../features/console/files/folderPage/Head";
import { jobIconMarker } from "../features/console/files/jobIcons/marker";
import type { TreeRow } from "../features/console/files/tree";
import { FolderLine } from "../features/console/home/homeRows";

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

const INBOX = jobIconMarker("inbox");

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

describe("the tree", () => {
  const tree = (onIconPress?: () => void) =>
    createElement(FileTree, {
      rows: [folder("Capture"), folder("Recipes")],
      onSelect: () => {},
      onToggle: () => {},
      workspaceId: "ws-1",
      iconOf: (path: string) => (path === "Capture" ? INBOX : "🍳"),
      ...(onIconPress === undefined ? {} : { onIconPress }),
    });

  test("a renamed Inbox draws the tray, never its marker as text", () => {
    const container = mount(tree());
    const glyph = container.querySelector("[aria-label^='Capture, folder'] [data-testid='tree-folder-job']");
    expect(glyph).not.toBeNull();
    expect(glyph!.tagName.toLowerCase()).toBe("svg");
    expect(glyph!.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("context:job");
  });

  test("its glyph is not a button to the picker, where an own folder's is", () => {
    const container = mount(tree(() => {}));
    expect(container.querySelector("[aria-label='Change Capture’s icon']")).toBeNull();
    expect(container.querySelector("[aria-label='Change Recipes’s icon']")).not.toBeNull();
  });
});

describe("a listing row and Home's folder line", () => {
  test("a listing row draws the drawing in the emoji's place", () => {
    const row = {
      kind: "folder" as const,
      path: "Capture",
      name: "Capture",
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    };
    const container = mount(createElement(FolderRow, { row, onSelect: () => {}, card: true, folderIcon: INBOX }));
    expect(container.querySelector("[data-testid='folder-row-emoji']")?.tagName.toLowerCase()).toBe("svg");
    expect(container.textContent).not.toContain("context:job");
  });

  test("Home's folder line too", () => {
    const home = { kind: "folder" as const, path: "Capture", title: "Capture", notes: 3, folders: 0, shared: false };
    const container = mount(createElement(FolderLine, { folder: home, icon: INBOX, onPress: () => {} }));
    expect(container.querySelector("[data-testid='phone-home-folder-emoji']")?.tagName.toLowerCase()).toBe("svg");
  });
});

describe("the folder page's head", () => {
  test("a renamed Inbox: the tray on its paper tile, and a line saying it is the built-in Inbox", () => {
    const container = mount(createElement(FolderHead, { title: "Capture", icon: INBOX, switcher: null, large: true }));
    const tile = container.querySelector("[data-testid='folder-head-job']");
    expect(tile).not.toBeNull();
    expect(tile!.querySelector("svg")).not.toBeNull();
    // The dry pass shows at a phone's heading size: two paths per stroke.
    expect(tile!.querySelectorAll("path").length).toBe(4);
    // Beside the pointer layout's smaller title the drawing is at list size: no grain.
    const small = mount(createElement(FolderHead, { title: "Capture", icon: INBOX, switcher: null }));
    expect(small.querySelectorAll("[data-testid='folder-head-job'] path").length).toBe(2);
    expect(container.querySelector("[data-testid='folder-head-built-in']")?.textContent).toMatch(
      /^Built-in Inbox\. Unfiled captures\./,
    );
  });

  test("an Inbox still called Inbox needs no line", () => {
    const container = mount(createElement(FolderHead, { title: "Inbox", icon: INBOX, switcher: null }));
    expect(container.querySelector("[data-testid='folder-head-job']")).not.toBeNull();
    expect(container.querySelector("[data-testid='folder-head-built-in']")).toBeNull();
  });

  test("an own folder's emoji is drawn as before, with no line", () => {
    const container = mount(createElement(FolderHead, { title: "Recipes", icon: "🍳", switcher: null }));
    expect(container.querySelector("[data-testid='folder-head-icon']")?.textContent).toBe("🍳");
    expect(container.querySelector("[data-testid='folder-head-built-in']")).toBeNull();
  });
});
