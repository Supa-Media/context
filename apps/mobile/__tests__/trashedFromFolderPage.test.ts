/**
 * @jest-environment jsdom
 */

/**
 * Deleting a note from a folder page leaves the folder page on screen
 * (Dev2, 2026-10-14: "I was in a folder and deleted a file and then it threw
 * me into this screen, instead of just keeping me in the folder").
 *
 * The cause was the tab strip, not the delete. A note opened earlier keeps its
 * tab when the person goes on to a folder page (a folder opens no tab), and
 * that tab stays the strip's active one. Deleting the note from the folder's
 * rows drops it from the listing, `useTabs` removes its tab, and the two
 * "closing a tab moves the editor" rules then acted on a note that was not on
 * screen: the last tab gone → `deselect()` → the workspace root, its address
 * replaced over the folder's; or the active tab gone → `select(neighbour)`,
 * a note nobody asked for, pushed into history. Pressing Back from the root
 * then went to the deleted note's own address, which opens it as trashed.
 *
 * Sabotage:
 *  - drop the `editorPath` membership check from `useTabs`' last-tab rule and
 *    the single-tab and several-at-once cases land on the workspace root (the
 *    reported bug), the folder's address replaced by the root's;
 *  - drop the `wentAway` check from `useTabs`' active-tab rule and the
 *    two-tab case opens the neighbouring note over the folder;
 *  - make either rule ignore `files.editor.path` (never deselect, or never
 *    follow a tab that went) and the "note on screen" cases below fail:
 *    closing the open note's tab must still move or close the editor;
 *  - key the last-tab rule on `state.tabs.length` again and its remembered
 *    strip goes stale when a preview tab is replaced, so closing the last tab
 *    leaves the note in the editor.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => actions[name]!(args);
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
import { useNoteAddress } from "../features/console/useNoteAddress";

const FOLDER = "2-areas/kings";
const KINGS_9 = `${FOLDER}/kings-9.md`;
const KINGS_8 = `${FOLDER}/kings-8.md`;
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

let notes: string[];
const listing = (path: string): FolderListing => ({
  path,
  folderDefault: "private",
  entries:
    path === ""
      ? [entry("2-areas", "folder")]
      : path === "2-areas"
        ? [entry(FOLDER, "folder")]
        : notes.filter((note) => note.startsWith(`${path}/`)).map((note) => entry(note, "file")),
  truncated: false,
  manifestUsable: true,
});

let browser: FileBrowser;
let tabs: ReturnType<typeof useTabs>;
/** Every address write, in order: what the browser's history would hold. */
let history: { note: string | null; mode: "push" | "replace" }[];
let url: string | null;
let unmount: (() => void) | null = null;

/** The console's shape: the browser, the strip, and the URL mirror with its pushes and replaces. */
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Route({ files, note, onAddress }: {
    files: FileBrowser;
    note: string | null;
    onAddress: (next: string | null, mode: "push" | "replace") => void;
  }): ReactNode {
    useNoteAddress(files, { contextId: "w1", note }, "w1", onAddress);
    return null;
  }
  function Layout(): ReactNode {
    const [inUrl, setInUrl] = useState<string | null>(null);
    url = inUrl;
    browser = useFileBrowser({ workspaceId: "w1" as never, tier: "private", canEdit: true, isOwner: true });
    tabs = useTabs(browser, "w1");
    return createElement(Route, {
      files: browser,
      note: inUrl,
      onAddress: (next, mode) => {
        history.push({ note: next, mode });
        setInUrl(next);
      },
    });
  }
  act(() => root.render(createElement(Layout)));
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

beforeEach(() => {
  history = [];
  url = null;
  notes = [KINGS_8, KINGS_9];
  actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
  actions[fn("readNote")] = async (args: never) => {
    const path = (args as { path: string }).path;
    return { path, text: "Elijah on Carmel.\n", etag: "e1", visibility: "private", inherited: "private", exception: false, readOnly: false };
  };
  actions[fn("trashEntry")] = async (args: never) => {
    const path = (args as { path: string }).path;
    notes = notes.filter((note) => note !== path);
    return { path, to: `.context/trash/stamp/${path}` };
  };
});

afterEach(() => {
  unmount?.();
  unmount = null;
  document.body.innerHTML = "";
});

/** Open each note in turn (pinned, so each keeps a tab), then go up to their folder's page. */
async function notesThenFolder(opened: string[]) {
  mount();
  await settle();
  act(() => void browser.select("2-areas"));
  await settle();
  for (const path of opened) {
    act(() => void browser.select(path));
    await settle();
    act(() => tabs.pin(path));
    await settle();
  }
  act(() => void browser.select(FOLDER));
  await settle();
  expect(browser.selectedPath).toBe(FOLDER);
  expect(browser.editor.path).toBeNull();
  expect(url).toBe(FOLDER);
  history.length = 0;
}

describe("a note deleted from a folder page", () => {
  test("its only tab going does not take the folder page with it", async () => {
    await notesThenFolder([KINGS_9]);
    act(() => browser.destroy(KINGS_9));
    await settle();

    expect(tabs.state.tabs).toEqual([]);
    expect(browser.selectedPath).toBe(FOLDER);
    expect(browser.editor.path).toBeNull();
    expect(browser.trashed).toBeNull();
    expect(url).toBe(FOLDER);
    expect(history).toEqual([]);
    expect(browser.toasts.map((toast) => toast.message)).toEqual(["Moved kings-9.md to trash."]);
  });

  test("the active tab going opens no neighbour and pushes nothing", async () => {
    await notesThenFolder([KINGS_8, KINGS_9]);
    expect(tabs.state.activePath).toBe(KINGS_9);
    act(() => browser.destroy(KINGS_9));
    await settle();

    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([KINGS_8]);
    expect(browser.selectedPath).toBe(FOLDER);
    expect(browser.editor.path).toBeNull();
    expect(url).toBe(FOLDER);
    expect(history).toEqual([]);
  });

  test("several at once leave it too", async () => {
    await notesThenFolder([KINGS_8, KINGS_9]);
    act(() => browser.destroyMany([KINGS_8, KINGS_9]));
    await settle();

    expect(tabs.state.tabs).toEqual([]);
    expect(browser.selectedPath).toBe(FOLDER);
    expect(url).toBe(FOLDER);
    expect(history).toEqual([]);
  });
});

describe("the note on screen is still followed", () => {
  test("closing its last tab closes it, and the address goes to the root", async () => {
    mount();
    await settle();
    act(() => void browser.select("2-areas"));
    await settle();
    act(() => void browser.select(KINGS_9));
    await settle();
    act(() => tabs.close(KINGS_9));
    await settle();

    expect(browser.selectedPath).toBeNull();
    expect(browser.editor.path).toBeNull();
    expect(url).toBeNull();
  });

  test("closing its last tab closes it after a preview tab was replaced under it", async () => {
    mount();
    await settle();
    act(() => void browser.select("2-areas"));
    await settle();
    act(() => void browser.select(KINGS_8));
    await settle();
    act(() => void browser.select(KINGS_9));
    await settle();
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([KINGS_9]);
    act(() => tabs.close(KINGS_9));
    await settle();

    expect(browser.editor.path).toBeNull();
    expect(url).toBeNull();
  });

  test("closing its tab moves the editor to the neighbour", async () => {
    mount();
    await settle();
    act(() => void browser.select("2-areas"));
    await settle();
    for (const path of [KINGS_8, KINGS_9]) {
      act(() => void browser.select(path));
      await settle();
      act(() => tabs.pin(path));
      await settle();
    }
    act(() => tabs.close(KINGS_9));
    await settle();

    expect(browser.editor.path).toBe(KINGS_8);
    expect(url).toBe(KINGS_8);
  });
});
