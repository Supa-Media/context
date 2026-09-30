/**
 * @jest-environment jsdom
 */

/**
 * "Created Hiring in Team · Undo" (board 05c of the phone Home artboards,
 * approved by the owner on 2026-09-30): making a folder says where it went,
 * can open it straight away, and Undo takes it back while it is still empty.
 *
 * The emptiness rule is the server's (`removeNewFolder`, which refuses with
 * `FOLDER_NOT_EMPTY`); this pins the wiring: the toast, the call, the folder
 * leaving the tree on Undo, the page going back to where the folder was put,
 * and a refusal reaching the person as a sentence rather than a vanished row.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `createFolder` returning no `undo`.                → "the toast says where it went and offers Undo"
 *  2. The undo not calling `undoNewFolder`.              → "Undo takes it back and goes to where it was put"
 *  3. `open` ignored.                                     → "opens the new folder when asked to, and stays put otherwise"
 *  4. The undo's refusal not restoring the folder.       → "a folder with something in it is kept, and says so"
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const WORKSPACE = "w1";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/* -------------------------------------------------------------------------- */
/*                            the bucket, as fixtures                          */
/* -------------------------------------------------------------------------- */

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

/**
 * `1-projects/foo/deep/b.md`, every folder of it listable.
 *
 * Deep on purpose: two levels under the folder being moved is what makes
 * "the subtree travels" a different statement from "the row moved".
 */
const BUCKET: Record<string, FolderListing> = {
  "": listingOf("", [
    ["1-projects", "folder"],
    ["2-areas", "folder"],
  ]),
  "1-projects": listingOf("1-projects", [["1-projects/foo", "folder"]]),
  "2-areas": listingOf("2-areas", []),
  "1-projects/foo": listingOf("1-projects/foo", [
    ["1-projects/foo/deep", "folder"],
    ["1-projects/foo/a.md", "file"],
  ]),
  "1-projects/foo/deep": listingOf("1-projects/foo/deep", [["1-projects/foo/deep/b.md", "file"]]),
};

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
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

const pathsIn = (listing: FolderListing | undefined): string[] =>
  (listing?.entries ?? []).map((one) => one.path);

/** Open the whole fixture, so there is a subtree to lose. */
async function openTree() {
  for (const folder of ["1-projects", "1-projects/foo", "1-projects/foo/deep"]) {
    await act(async () => {
      browser.toggleFolder(folder);
    });
    await settle();
  }
}

let unmount: (() => void) | null = null;

beforeEach(async () => {
  window.localStorage.clear();
  actions[name("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    const page = BUCKET[path];
    if (page === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "Gone." });
    return page;
  };
  actions[name("moveEntry")] = async () => ({});
});

afterEach(() => {
  unmount?.();
  unmount = null;
});


const undoName = "functions/folders:undoNewFolder";

async function made(open?: boolean) {
  unmount = mount();
  await settle();
  await act(async () => {
    browser.toggleFolder("1-projects");
  });
  await settle();
  actions[name("createDirectory")] = async () => ({ kind: "folderCreated", path: "1-projects/hiring", readme: "1-projects/hiring/README.md" });
  BUCKET["1-projects/hiring"] = listingOf("1-projects/hiring", []);
  await act(async () => {
    browser.createFolder("1-projects", "hiring", open === undefined ? undefined : { open });
  });
  await settle();
}

afterEach(() => {
  delete BUCKET["1-projects/hiring"];
  delete actions[undoName];
});

describe("a new folder, made", () => {
  test("the toast says where it went and offers Undo", async () => {
    await made();
    const toast = browser.toasts.at(-1);
    expect(toast?.message).toBe("Created hiring in projects.");
    expect(toast?.undo).toBeInstanceOf(Function);
  });

  test("opens the new folder when asked to, and stays put otherwise", async () => {
    await made(true);
    expect(browser.selectedPath).toBe("1-projects/hiring");
    unmount?.();
    unmount = null;
    await made();
    expect(browser.selectedPath).not.toBe("1-projects/hiring");
  });

  test("Undo takes it back and goes to where it was put", async () => {
    await made(true);
    const asked: unknown[] = [];
    actions[undoName] = async (args: never) => {
      asked.push(args);
      return { kind: "deleted", paths: ["1-projects/hiring/README.md"] };
    };
    await act(async () => {
      browser.toasts.at(-1)!.undo!();
    });
    await settle();
    expect(asked).toEqual([{ workspaceId: WORKSPACE, path: "1-projects/hiring" }]);
    expect(pathsIn(browser.listings["1-projects"])).not.toContain("1-projects/hiring");
    expect(browser.selectedPath).toBe("1-projects");
  });

  test("a folder with something in it is kept, and says so", async () => {
    await made(true);
    actions[undoName] = async () => {
      throw new ConvexError({ code: "FOLDER_NOT_EMPTY", message: "hiring has something in it now, so it was kept." });
    };
    await act(async () => {
      browser.toasts.at(-1)!.undo!();
    });
    await settle();
    expect(pathsIn(browser.listings["1-projects"])).toContain("1-projects/hiring");
    expect(browser.notice).toBe("hiring has something in it now, so it was kept.");
  });
});
