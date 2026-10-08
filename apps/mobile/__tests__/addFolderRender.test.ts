/**
 * @jest-environment jsdom
 */

/**
 * "Add a folder", drawn: the row at the end of the workspace's top level (the
 * desktop tree and phone Home), shown to an editor and to nobody else, and the
 * sheet it opens, which makes a built-in folder and shows the server's refusal.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexError } from "convex/values";
import { AddFolderSheet } from "../features/console/files/AddFolderSheet";
import { ExplorerTree } from "../features/console/files/explorer/ExplorerTree";
import { PhoneHome } from "../features/console/home/PhoneHome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
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

const at = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** The part of a FileBrowser the tree and the sheet read. */
function treeFiles(over: Record<string, unknown> = {}) {
  return {
    loading: false,
    titleEdit: undefined,
    selectedPath: null,
    contextId: "ws-1",
    iconOf: () => null,
    select: () => {},
    toggleFolder: () => {},
    listings: {},
    ...over,
  };
}

function tree(over: { files?: Record<string, unknown>; matches?: unknown; onAddFolder?: () => void }) {
  return createElement(ExplorerTree, {
    files: treeFiles(over.files),
    query: "",
    contextLabel: "@seyi",
    matches: over.matches ?? null,
    rows: [],
    select: () => {},
    setPicked: () => {},
    openMenu: () => {},
    onPick: () => {},
    dragHandlers: undefined,
    dropTarget: null,
    markedPaths: undefined,
    agentMarks: undefined,
    background: { ref: createRef() },
    ...(over.onAddFolder === undefined ? {} : { onAddFolder: over.onAddFolder }),
  } as never);
}

describe("the desktop tree's Add a folder row", () => {
  test("an editor sees it after the last root row, and tapping it asks for the add", () => {
    let asked = 0;
    mount(tree({ onAddFolder: () => (asked += 1) }));
    const row = at("explorer-add-folder");
    expect(row?.textContent).toContain("Add a folder");
    act(() => row!.click());
    expect(asked).toBe(1);
  });

  test("somebody who cannot edit is given no row at all", () => {
    mount(tree({}));
    expect(at("explorer-add-folder")).toBeNull();
  });

  test("it is not drawn while the tree is loading", () => {
    mount(tree({ files: { loading: true }, onAddFolder: () => {} }));
    expect(at("explorer-add-folder")).toBeNull();
  });

  test("it is not drawn while a filter has replaced the tree", () => {
    mount(tree({ matches: [], onAddFolder: () => {} }));
    expect(at("explorer-add-folder")).toBeNull();
  });
});

describe("phone Home's Add a folder line", () => {
  const source = { notes: [], folders: ["2-areas"], shared: new Set<string>() };
  function home(onAddFolder?: () => void) {
    return createElement(PhoneHome, {
      title: "Seyi",
      source,
      pins: [],
      opened: [],
      recents: null,
      onOpen: () => {},
      onTogglePin: null,
      ...(onAddFolder === undefined ? {} : { onAddFolder }),
    } as never);
  }

  test("an editor sees it as the last line of All folders, and tapping it asks for the add", () => {
    let asked = 0;
    mount(home(() => (asked += 1)));
    const line = at("phone-home-add-folder");
    expect(line?.textContent).toContain("Add a folder");
    act(() => line!.click());
    expect(asked).toBe(1);
  });

  test("it is absent where nobody may make a folder", () => {
    mount(home());
    expect(at("phone-home-add-folder")).toBeNull();
  });
});

describe("the Add a folder sheet", () => {
  const names = ["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"];

  function sheet(files: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return createElement(AddFolderSheet, {
      files,
      names,
      folders: [],
      rootLabel: "Seyi",
      compact: false,
      onClose: () => {},
      ...extra,
    } as never);
  }

  test("lists what the workspace is missing and makes the one chosen", async () => {
    const calls: string[] = [];
    const closed = jest.fn();
    const added = jest.fn();
    mount(
      sheet(
        { addBuiltInFolder: async (role: string) => (calls.push(role), `4-${role}`) },
        { onClose: closed, onAdded: added },
      ),
    );
    expect(at("add-folder-choice-resources")).toBeNull();
    expect(at("add-folder-choice-archive")).toBeNull();
    expect(at("add-folder-choice-clients")?.textContent).toContain("Clients");
    await act(async () => at("add-folder-choice-clients")!.click());
    expect(calls).toEqual(["clients"]);
    expect(added).toHaveBeenCalledWith("4-clients");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  test("the server's refusal is shown in the sheet, and the sheet stays open", async () => {
    const closed = jest.fn();
    mount(
      sheet(
        {
          addBuiltInFolder: async () => {
            throw new ConvexError({ code: "DESTINATION_EXISTS", message: "A folder called Clients is already here." });
          },
        },
        { onClose: closed },
      ),
    );
    await act(async () => at("add-folder-choice-clients")!.click());
    expect(at("add-folder-error")?.textContent).toBe("A folder called Clients is already here.");
    expect(closed).not.toHaveBeenCalled();
  });

  test("the choices are disabled while the add is in flight", async () => {
    let finish!: (path: string) => void;
    mount(sheet({ addBuiltInFolder: () => new Promise<string>((resolve) => (finish = resolve)) }));
    act(() => at("add-folder-choice-clients")!.click());
    expect(at("add-folder-choice-teams")?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => finish("4-clients"));
  });

  test("'A folder of your own…' turns the sheet into the New folder form", () => {
    mount(sheet({ addBuiltInFolder: async () => "" }));
    act(() => at("add-folder-own")!.click());
    expect(at("add-folder-choice-clients")).toBeNull();
    expect(document.body.textContent).toContain("New folder");
  });
});
