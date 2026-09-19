/**
 * @jest-environment jsdom
 */

/**
 * The *screen* changes before the network answers — not just the hook's state.
 *
 * `optimisticFolderMove.test.ts` holds the mutation open and asserts on
 * `browser.listings`, which proves the data moved. That is one step short of
 * the complaint, which was about a screen that did not react: a hook whose
 * state changes and a tree that still draws the old rows are indistinguishable
 * to the person waiting, and an optimistic update is exactly the kind of change
 * that satisfies every state assertion and still lags in the hand.
 *
 * So this mounts the real `FileTree`, fed by a real `useFileBrowser` through
 * the real `buildTreeRows`, in a real reconciler — and reads the rows out of
 * the DOM while `moveEntry` is still unresolved. Nothing here inspects the
 * hook. If the row on screen has not been renamed at that moment, the fix does
 * not exist as far as anybody using it is concerned.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { FileTree } from "../features/console/files/FileTree";
import { buildTreeRows } from "../features/console/files/tree";
import { useFileBrowser } from "../features/console/files/useFileBrowser";

const WORKSPACE = "w1";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

function entryOf(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };
}

function listingOf(path: string, children: readonly [string, "file" | "folder"][]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: children.map(([child, kind]) => entryOf(child, kind)),
    truncated: false,
    manifestUsable: true,
  };
}

const BUCKET: Record<string, FolderListing> = {
  "": listingOf("", [["1-projects", "folder"]]),
  "1-projects": listingOf("1-projects", [["1-projects/foo", "folder"]]),
  "1-projects/foo": listingOf("1-projects/foo", [["1-projects/foo/a.md", "file"]]),
};

let browser: FileBrowser;
let container: HTMLElement;

/** The whole console, near enough: a live browser drawn by the real tree. */
function mountConsole(): () => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Console() {
    const files = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
    browser = files;
    return createElement(FileTree, {
      rows: buildTreeRows({
        listings: files.listings,
        expanded: files.expanded,
        selectedPath: files.selectedPath,
      }),
      canEdit: true,
      onSelect: files.select,
      onToggle: files.toggleFolder,
      onCycleVisibility: () => {},
    } as never);
  }

  act(() => {
    root.render(createElement(Console));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  for (let turn = 0; turn < 6; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Every name the tree is drawing, read out of the DOM and nowhere else. */
function onScreen(): string[] {
  return Array.from(container.querySelectorAll("*"))
    .filter((node) => node.children.length === 0 && (node.textContent ?? "").trim() !== "")
    .map((node) => (node.textContent ?? "").trim());
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  actions[name("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    const page = BUCKET[path];
    if (page === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "Gone." });
    return page;
  };
});

afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

/* -------------------------------------------------------------------------- */

describe("the drawn tree, while moveEntry is still in flight", () => {
  test("the row reads its new name, and the old one is gone from the screen", async () => {
    unmount = mountConsole();
    await settle();
    await act(async () => {
      browser.toggleFolder("1-projects");
    });
    await settle();
    expect(onScreen()).toContain("foo");

    let release = () => {};
    actions[name("moveEntry")] = () => new Promise<never>((resolve) => {
      release = resolve as () => void;
    });

    await act(async () => {
      browser.rename("1-projects/foo", "bar");
    });

    // No `settle()`. The action has not resolved and cannot have.
    expect(onScreen()).toContain("bar");
    expect(onScreen()).not.toContain("foo");

    release();
    await settle();
  });

  test("an open subtree is still drawn, under the new name", async () => {
    unmount = mountConsole();
    await settle();
    await act(async () => {
      browser.toggleFolder("1-projects");
    });
    await settle();
    await act(async () => {
      browser.toggleFolder("1-projects/foo");
    });
    await settle();
    expect(onScreen()).toContain("a");

    let release = () => {};
    actions[name("moveEntry")] = () => new Promise<never>((resolve) => {
      release = resolve as () => void;
    });

    await act(async () => {
      browser.rename("1-projects/foo", "bar");
    });

    // The child is the whole complaint: before this the subtree collapsed and
    // came back one request at a time. It must still be drawn, right now.
    expect(onScreen()).toContain("bar");
    expect(onScreen()).toContain("a");

    release();
    await settle();
  });

  test("a refused move puts the drawn name back", async () => {
    unmount = mountConsole();
    await settle();
    await act(async () => {
      browser.toggleFolder("1-projects");
    });
    await settle();

    actions[name("moveEntry")] = async () => {
      throw new ConvexError({ code: "DESTINATION_EXISTS", message: "Something is already there." });
    };

    await act(async () => {
      browser.rename("1-projects/foo", "bar");
    });
    await settle();

    expect(onScreen()).toContain("foo");
    expect(onScreen()).not.toContain("bar");
  });
});
