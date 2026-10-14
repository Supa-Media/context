/**
 * @jest-environment jsdom
 */

/**
 * The other ways the open note reaches the trash keep it on screen as a
 * trashed note too (design A, `fileBrowser/useTrashedNote.ts`): a bulk delete
 * that picks it or a folder holding it, and a reload on `?note=` that finds
 * it in the trash rather than nowhere. (A delete waiting in this device's
 * queue: `trashedNoteQueued.test.ts`.)
 *
 * Sabotage:
 *  - put back `closeIfWithin(paths)` for every bulk delete and the first case
 *    finds the editor closed;
 *  - settle with `result.to` alone and the folder case reads the folder's key
 *    rather than the note's inside it;
 *  - drop the `drawn` clear and a refused bulk delete leaves the note trashed;
 *  - drop `restoredInPlace` from the step's undo and Undo leaves it trashed;
 *  - drop the `shownTrashed` ask in `openNote` and the reload says "That file
 *    does not exist";
 *  - drop the `markTrashed` in `showTrashedInstead` and the reload opens with
 *    no trashed state, so no Restore;
 *  - return `files.editor.path` from `roomPathOf`, or pass `editor.path` to
 *    `useNoteRoom` in the route again, and a trashed note joins its room
 *    ("Reconnecting" under the reloaded note, Dev2 2026-10-14).
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
const calls: { name: string; args: unknown }[] = [];
const mockTrashed: { answer: unknown } = { answer: null };

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
    useConvex: () => ({
      query: async (ref: never) => (getFunctionName(ref) === "functions/trashedNotes:trashedNote" ? mockTrashed.answer : null),
    }),
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useTabs } from "../features/console/files/useTabs";
import { TRASHED_TEXT_UNAVAILABLE } from "../features/console/files/fileBrowser/useTrashedNote";
import { roomPathOf } from "../features/console/files/noteEditor/trashed";

const NOTE = "1-projects/offsite-plan.md";
const OTHER = "2-areas/hiring-plan.md";
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

let notes: string[];
const listing = (path: string): FolderListing => ({
  path,
  folderDefault: "private",
  entries:
    path === ""
      ? ["1-projects", "2-areas"].filter((folder) => notes.some((note) => note.startsWith(`${folder}/`))).map((folder) => entry(folder, "folder"))
      : notes.filter((note) => note.startsWith(`${path}/`)).map((note) => entry(note, "file")),
  truncated: false,
  manifestUsable: true,
});

let browser: FileBrowser;
let tabs: ReturnType<typeof useTabs>;
let unmount: (() => void) | null = null;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true, isOwner: true });
    tabs = useTabs(browser, "w1");
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
const missing = () => new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });

beforeEach(() => {
  calls.length = 0;
  mockTrashed.answer = null;
  notes = [NOTE, OTHER];
  actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
  actions[fn("readNote")] = async (args: never) => {
    const path = (args as { path: string }).path;
    if (!notes.includes(path)) throw missing();
    return { path, text: "Three days in Lisbon.\n", etag: "e1", visibility: "private", inherited: "private", exception: false, readOnly: false };
  };
  actions[fn("writeNote")] = async () => ({ etag: "e2" });
  actions[fn("trashEntry")] = async (args: never) => {
    const path = (args as { path: string }).path;
    notes = notes.filter((note) => note !== path && !note.startsWith(`${path}/`));
    return { path, to: `.context/trash/stamp/${path}` };
  };
  actions[fn("restoreTrashEntry")] = async (args: never) => {
    const { from, to } = args as { from: string; to: string };
    notes = [...notes, ...(from.endsWith(".md") ? [to] : [NOTE])];
    return { path: to };
  };
  actions["functions/trashedNotes:readTrashedNote"] = async (args: never) => ({
    path: (args as { path: string }).path,
    text: "Three days in Lisbon.\n",
    encrypted: false,
  });
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
}

describe("a bulk delete that takes the open note", () => {
  test("keeps it open, in the trash, and the toast is for the batch", async () => {
    await openNote();
    act(() => browser.destroyMany([NOTE, OTHER]));
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: null, byYou: true });
    await settle();

    expect(browser.editor.path).toBe(NOTE);
    expect(browser.selectedPath).toBe(NOTE);
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: TRASH });
    expect(browser.toasts.map((toast) => toast.message)).toEqual(["Moved 2 items to trash."]);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([NOTE]);
    // Its room is left: nobody types in a note in the trash.
    expect(roomPathOf(browser)).toBeNull();
  });

  test("a folder holding it settles at the note's own key inside the folder's trash", async () => {
    await openNote();
    act(() => browser.destroyMany(["1-projects", "2-areas"]));
    await settle();

    expect(browser.editor.path).toBe(NOTE);
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: `.context/trash/stamp/1-projects/offsite-plan.md` });
  });

  test("refused, it leaves the note an ordinary one", async () => {
    actions[fn("trashEntry")] = async () => {
      throw new Error("nope");
    };
    await openNote();
    act(() => browser.destroyMany([NOTE, OTHER]));
    await settle();

    expect(browser.trashed).toBeNull();
    expect(browser.editor.path).toBe(NOTE);
  });

  test("its Undo brings the open note back in place", async () => {
    await openNote();
    act(() => browser.destroyMany([NOTE, OTHER]));
    await settle();
    act(() => browser.toasts[0]!.undo!());
    await settle();
    await settle();

    expect(named("restoreTrashEntry")).toContainEqual({ workspaceId: "w1", from: TRASH, to: NOTE });
    expect(browser.trashed).toBeNull();
    expect(browser.editor.path).toBe(NOTE);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([NOTE]);
  });
});

describe("opening a note by an address that outlived it", () => {
  test("in the trash, it opens there with its text and Restore, not as missing", async () => {
    notes = [OTHER];
    mockTrashed.answer = { trash: TRASH, at: 1_700_000_000_000, byYou: false, byName: "@ana" };
    mount();
    await settle();
    act(() => void browser.select(NOTE));
    await settle();
    await settle();

    expect(browser.editor.path).toBe(NOTE);
    expect(browser.editor.draft).toBe("Three days in Lisbon.\n");
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: TRASH, byName: "@ana" });
    expect(browser.notice).toBeNull();
    expect(calls.filter((call) => call.name === "functions/trashedNotes:readTrashedNote").map((call) => call.args)).toEqual([
      { workspaceId: "w1", path: NOTE },
    ]);
    // Read-only and trashed: no room, so no "Reconnecting" and no replay over the trash's text.
    expect(roomPathOf(browser)).toBeNull();

    act(() => browser.restoreTrashed!());
    await settle();
    await settle();
    expect(named("restoreTrashEntry")).toEqual([{ workspaceId: "w1", from: TRASH, to: NOTE }]);
    expect(browser.trashed).toBeNull();
    expect(browser.editor.path).toBe(NOTE);
    expect(roomPathOf(browser)).toBe(NOTE);
  });

  test("its text unavailable, it opens empty and says so quietly", async () => {
    notes = [OTHER];
    mockTrashed.answer = { trash: TRASH, at: 1_700_000_000_000, byYou: true, byName: null };
    actions["functions/trashedNotes:readTrashedNote"] = async () => {
      throw missing();
    };
    mount();
    await settle();
    act(() => void browser.select(NOTE));
    await settle();
    await settle();

    expect(browser.editor.path).toBe(NOTE);
    expect(browser.editor.draft).toBe("");
    expect(browser.trashed).toMatchObject({ path: NOTE, trash: TRASH });
    expect(browser.notice).toBe(TRASHED_TEXT_UNAVAILABLE);
  });

  test("not in the trash, it is missing, as before", async () => {
    notes = [OTHER];
    mount();
    await settle();
    act(() => void browser.select(NOTE));
    await settle();
    await settle();

    expect(browser.editor.path).toBeNull();
    expect(browser.trashed).toBeNull();
    expect(browser.notice).toBe("That file does not exist.");
  });
});

describe("the route's room", () => {
  test("is joined for the path `roomPathOf` gives, not the editor's own", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const route = readFileSync(join(__dirname, "../app/(app)/console/[slug]/index.tsx"), "utf8");
    expect(route).toContain("notePath: roomPathOf(data.files),");
  });
});
