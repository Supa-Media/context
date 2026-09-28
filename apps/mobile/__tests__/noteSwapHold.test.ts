/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
/** Every call, in order, so a test can assert on absence as well as presence. */
const calls: { name: string; args: unknown }[] = [];

/**
 * `useAction` and `useMutation` both record; `useQuery` returns undefined.
 *
 * The hook reads `listShares` through `useQuery` as of the share work, and a
 * query that never resolves is the honest stand-in here — every assertion below
 * is about what the console *sends*, and `undefined` is what a real console
 * shows before the subscription lands.
 */
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
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { shownEntry } from "../features/console/panes/browsePane/useShownEntry";

const NOTE = "1-projects/note.md";
const FOLDER = "1-projects";
const PRIVACY = "privacy.md";

function entry(path: string, kind: "file" | "folder", readOnly = false) {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly,
  };
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [entry(NOTE, "file"), entry(FOLDER, "folder"), entry(PRIVACY, "file", true)],
  truncated: false,
  manifestUsable: true,
};

function openNote(path: string, readOnly: boolean): OpenNote {
  return {
    path,
    text: "# original\n",
    etag: "etag-1",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly,
  };
}

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

function mount(options: { canEdit: boolean; isOwner?: boolean }): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", ...options });
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}


/**
 * **The page on screen stays until the next one is ready** (owner,
 * 2026-09-28: switching notes flashed a blank page with the editor's
 * placeholder in it before the note arrived).
 *
 * Two halves. `shownEntry` decides what the region draws while an open is in
 * flight; `select` keeps the note in the editor until a folder it is leaving
 * for has a listing to draw, so there is a note to hold.
 */

describe("shownEntry", () => {
  const A = entry("1-projects/a.md", "file");
  const B = entry("1-projects/b.md", "file");
  const F = entry("2-areas", "folder");

  test("while the next note is being read, the note on screen stays", () => {
    expect(shownEntry({ target: B, held: A, selectedPath: B.path, opening: B.path, editorPath: A.path })).toBe(A);
  });

  test("…even when no listing names the next note yet (a link, a phone)", () => {
    expect(shownEntry({ target: null, held: A, selectedPath: B.path, opening: B.path, editorPath: A.path })).toBe(A);
  });

  test("a folder page stays while a note from it is read", () => {
    expect(shownEntry({ target: B, held: F, selectedPath: B.path, opening: B.path, editorPath: null })).toBe(F);
  });

  test("the swap happens the moment the read lands", () => {
    expect(shownEntry({ target: B, held: A, selectedPath: B.path, opening: null, editorPath: B.path })).toBe(B);
    // An instant copy already in the editor is ready, whatever `opening` says.
    expect(shownEntry({ target: B, held: A, selectedPath: B.path, opening: B.path, editorPath: B.path })).toBe(B);
  });

  test("a failed read moves on to the selection and its notice", () => {
    expect(shownEntry({ target: B, held: A, selectedPath: B.path, opening: null, editorPath: null })).toBe(B);
  });

  test("a held note the editor no longer has is not drawn empty", () => {
    expect(shownEntry({ target: B, held: A, selectedPath: B.path, opening: B.path, editorPath: null })).toBe(B);
  });

  test("with nothing on screen before, nothing is held", () => {
    expect(shownEntry({ target: null, held: null, selectedPath: B.path, opening: B.path, editorPath: null })).toBeNull();
  });
});

describe("select, leaving a note for a folder", () => {
  let unmount: (() => void) | null = null;
  const OTHER = "2-areas";

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async () => ROOT;
    actions[name("readNote")] = async (args: never) => openNote((args as { path: string }).path, false);
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("the note stays in the editor until the folder's listing lands", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    expect(browser.editor.path).toBe(NOTE);

    let answer: (listing: FolderListing) => void = () => {};
    actions[name("listFiles")] = () => new Promise<FolderListing>((resolve) => (answer = resolve));
    await act(async () => {
      browser.select(OTHER);
    });
    await settle();
    expect(browser.opening).toBe(OTHER);
    expect(browser.editor.path).toBe(NOTE);

    await act(async () => {
      answer({ path: OTHER, folderDefault: "private", entries: [], truncated: false, manifestUsable: true });
    });
    await settle();
    expect(browser.opening).toBeNull();
    expect(browser.editor.path).toBeNull();
  });

  test("a note still being read does not open over the folder chosen after it", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    let answer: (note: OpenNote) => void = () => {};
    actions[name("readNote")] = () => new Promise<OpenNote>((resolve) => (answer = resolve));
    await act(async () => {
      browser.select(NOTE);
    });
    await act(async () => {
      browser.select(FOLDER);
    });
    await settle();
    await act(async () => {
      answer(openNote(NOTE, false));
    });
    await settle();
    expect(browser.selectedPath).toBe(FOLDER);
    expect(browser.editor.path).toBeNull();
  });
});
