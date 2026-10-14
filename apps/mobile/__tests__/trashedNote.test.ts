/**
 * @jest-environment jsdom
 */

/**
 * Deleting the note that is open keeps it on screen, as a trashed note with
 * Restore in place (design A, `fileBrowser/useTrashedNote.ts`), instead of
 * closing it behind a toast. Deleting any other note is unchanged: a toast with
 * Undo, and the editor left alone.
 *
 * Sabotage:
 *  - put back `setSelectedPath(null); dispatch({ type: "closed" })` for the
 *    open note in `destroy` and the first case fails;
 *  - give the open note's result its message and undo back and "no toast"
 *    fails;
 *  - swap `from` and `to` in `restoreTrashed` and the Restore case fails;
 *  - drop the `trashedRef` check in `useSaving.autosaveNow` and the autosave
 *    case writes to the old name.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      return actions[name]!(args);
    };
    return bound[name];
  };
  return {
    useAction: record,
    useMutation: record,
    useQuery: () => undefined,
    useQueries: () => ({}),
    useConvex: () => ({ query: async () => null }),
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useTabs } from "../features/console/files/useTabs";

const NOTE = "1-projects/offsite-plan.md";
const OTHER = "1-projects/hiring-plan.md";
const TRASH = `.context/trash/stamp/${NOTE}`;
const fn = (name: string) => `functions/files:${name}`;

function entry(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };
}

let projects: string[];
const listing = (path: string): FolderListing => ({
  path,
  folderDefault: "private",
  entries: path === "" ? [entry("1-projects", "folder")] : projects.map((p) => entry(p, "file")),
  truncated: false,
  manifestUsable: true,
});

let browser: FileBrowser;
let tabs: ReturnType<typeof useTabs>;
/** The editor's path on every render, so a close-and-reopen cannot hide. */
let seen: (string | null)[] = [];
let unmount: (() => void) | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true, isOwner: true });
    // Mounted with the tab strip, as the console is: the strip closes a tab whose note its folder no longer lists.
    tabs = useTabs(browser, "w1");
    seen.push(browser.editor.path);
    return null;
  }
  act(() => root.render(createElement(Probe)));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

const named = (name: string) => calls.filter((call) => call.name === fn(name)).map((call) => call.args);

beforeEach(() => {
  calls.length = 0;
  projects = [NOTE, OTHER];
  actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
  actions[fn("readNote")] = async (args: never) => {
    const path = (args as { path: string }).path;
    return { path, text: "Three days in Lisbon.\n", etag: "e1", visibility: "private", inherited: "private", exception: false, readOnly: false };
  };
  actions[fn("writeNote")] = async () => ({ etag: "e2" });
  actions[fn("trashEntry")] = async (args: never) => {
    const path = (args as { path: string }).path;
    projects = projects.filter((p) => p !== path);
    return { path, to: `.context/trash/stamp/${path}` };
  };
  actions[fn("restoreTrashEntry")] = async (args: never) => {
    projects = [...projects, (args as { to: string }).to];
    return { path: (args as { to: string }).to };
  };
});

afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

async function openNote() {
  mount();
  await settle();
  act(() => void browser.select(NOTE));
  await settle();
  expect(browser.editor.path).toBe(NOTE);
  seen = [];
}

describe("deleting the open note", () => {
  test("keeps it open, in the trash, with no toast", async () => {
    await openNote();
    act(() => browser.destroy(NOTE));
    // Already, before the server answers: the tab strip and the follow timer must know.
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: null, byYou: true });
    await settle();

    expect(browser.editor.path).toBe(NOTE);
    expect(browser.selectedPath).toBe(NOTE);
    expect(browser.editor.draft).toBe("Three days in Lisbon.\n");
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: TRASH, byYou: true, byName: null });
    expect(browser.toasts).toEqual([]);
    expect(browser.notice).toBeNull();
    // The listing has dropped it, and its tab, the only one, is still open.
    expect(browser.listings["1-projects"]?.entries.map((e) => e.path)).toEqual([OTHER]);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([NOTE]);
    expect(seen.every((path) => path === NOTE)).toBe(true);
  });

  test("Restore puts it back where it was and the editor goes on at that path", async () => {
    await openNote();
    act(() => browser.destroy(NOTE));
    await settle();

    act(() => browser.restoreTrashed!());
    await settle();
    await settle();

    expect(named("restoreTrashEntry")).toEqual([{ workspaceId: "w1", from: TRASH, to: NOTE }]);
    expect(browser.trashed).toBeNull();
    expect(browser.editor.path).toBe(NOTE);
    expect(browser.selectedPath).toBe(NOTE);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([NOTE]);
    expect(seen.every((path) => path === NOTE)).toBe(true);
  });

  test("a refused delete leaves it an ordinary note", async () => {
    actions[fn("trashEntry")] = async () => {
      throw new Error("nope");
    };
    await openNote();
    act(() => browser.destroy(NOTE));
    await settle();

    expect(browser.trashed).toBeNull();
    expect(browser.editor.path).toBe(NOTE);
    expect(browser.notice).not.toBeNull();
  });

  test("opening another note leaves the trashed state behind", async () => {
    await openNote();
    act(() => browser.destroy(NOTE));
    await settle();

    act(() => void browser.select(OTHER));
    await settle();

    expect(browser.editor.path).toBe(OTHER);
    expect(browser.trashed).toBeNull();
  });

  test("nothing typed before it went is written back to the name it left", async () => {
    await openNote();
    jest.useFakeTimers();
    try {
      act(() => browser.setDraft("Three days in Lisbon, and a fourth.\n"));
      act(() => browser.destroy(NOTE));
      // And a change that reaches the draft after it went (a collaborator's, say).
      act(() => browser.setDraft("Three days in Lisbon, and a fourth, and a fifth.\n"));
      await act(async () => {
        jest.advanceTimersByTime(20_000);
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(named("writeNote")).toEqual([]);
      // And it is still on screen.
      expect(browser.editor.draft).toBe("Three days in Lisbon, and a fourth, and a fifth.\n");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("deleting a note that is not open", () => {
  test("is unchanged: a toast with Undo, and the open note left alone", async () => {
    await openNote();
    act(() => browser.destroy(OTHER));
    await settle();

    expect(browser.trashed).toBeNull();
    expect(browser.editor.path).toBe(NOTE);
    expect(browser.toasts).toHaveLength(1);
    expect(browser.toasts[0]!.message).toBe("Moved hiring-plan.md to trash.");
    expect(browser.toasts[0]!.undo).toBeDefined();
  });
});
