/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useCallback, useState } from "react";
import { ConvexError } from "convex/values";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Real browser, tabs and URL hooks against a controlled storage boundary. */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => actions[name]!(args);
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined, useQueries: () => ({}), useConvex: () => ({ query: async () => null }) };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useTabs } from "../features/console/files/useTabs";
import { useNoteAddress } from "../features/console/useNoteAddress";

const FOLDER = "1-projects";
const FROM = `${FOLDER}/draft.md`;
const OTHER = `${FOLDER}/other.md`;
const TO = `${FOLDER}/Launch plan.md`;

function fn(name: string): string {
  return `functions/files:${name}`;
}

let files: Map<string, string>;

function listing(path: string): FolderListing {
  const prefix = path === "" ? "" : `${path}/`;
  const entries = [...files.keys()]
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .map((key) => ({
      kind: "file" as const,
      path: key,
      name: key.slice(prefix.length),
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    }));
  const folders =
    path === ""
      ? [
          {
            kind: "folder" as unknown as "file",
            path: FOLDER,
            name: FOLDER,
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ]
      : [];
  return { path, folderDefault: "private", truncated: false, manifestUsable: true, entries: [...entries, ...folders] };
}

function read(path: string): OpenNote {
  const text = files.get(path);
  if (text === undefined) throw new ConvexError({code: "FILE_NOT_FOUND", message: "That file does not exist."});
  return {
    path,
    text,
    etag: `etag:${path}`,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

let browser: FileBrowser;
let tabs: ReturnType<typeof useTabs>;
/** The editor's path on every render, so a close-and-reopen cannot hide. */
let seen: (string | null)[];
let reads: { workspaceId: string; path: string }[];
let urlNote: string | null;
let addressWrites: { note: string | null; mode: "push" | "replace" }[];
let switchWorkspace: (workspaceId: string) => void;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    const [workspaceId, setWorkspaceId] = useState("w1");
    const [note, setNote] = useState<string | null>(null);
    switchWorkspace = (next) => { setNote(null); setWorkspaceId(next); };
    const address = useCallback((next: string | null, mode: "push" | "replace") => {
      addressWrites.push({ note: next, mode });
      setNote(next);
    }, []);
    browser = useFileBrowser({ workspaceId, tier: "private", canEdit: true });
    tabs = useTabs(browser, workspaceId);
    useNoteAddress(browser, { contextId: workspaceId, note }, workspaceId, address);
    urlNote = note;
    seen.push(browser.editor.path);
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
    for (let n = 0; n < 12; n += 1) await Promise.resolve();
  });
}

async function open(path: string) {
  await act(async () => {
    browser.toggleFolder(FOLDER);
  });
  await settle();
  await act(async () => {
    browser.select(path);
  });
  await settle();
}

describe("file lifecycle across storage, tree, editor, tabs and URL", () => {
  let unmount: (() => void) | null = null;
  let releaseMove: (() => void) | null = null;
  beforeEach(() => {
    seen = [];
    reads = [];
    addressWrites = [];
    urlNote = null;
    releaseMove = null;
    files = new Map([["index.md", "# index\n"], [FROM, "# draft\n\nbody\n"], [OTHER, "# other\n"]]);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => {
      const input = args as { workspaceId: string; path: string };
      reads.push(input);
      return read(input.path);
    };
    actions[fn("writeNote")] = async (args: never) => {
      const {path, text} = args as {path: string; text: string};
      files.set(path, text);
      return {etag: `etag:${path}`};
    };
    actions[fn("duplicateEntry")] = async () => {
      const to = `${FOLDER}/other copy.md`;
      files.set(to, files.get(OTHER)!);
      return { to };
    };
    actions[fn("moveEntry")] = (args: never) => new Promise(resolve => {
      const {from, to} = args as {from: string; to: string};
      releaseMove = () => {
        const text = files.get(from)!;
        files.delete(from);
        files.set(to, text);
        resolve({from, to, paths: [to]});
      };
    });
  });
  afterEach(() => { unmount?.(); unmount = null; jest.useRealTimers(); });
  async function ready() { unmount = mount(); await settle(); await open(FROM); }
  async function startRename() {
    await act(async () => browser.rename(FROM, "Launch plan")); await settle();
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(TO);
  }
  function expectOpen(path: string) {
    expect(browser.editor.path).toBe(path);
    expect(browser.selectedPath).toBe(path);
    expect(tabs.state.activePath).toBe(path);
    expect(urlNote).toBe(path);
  }
  test("clicking the pending destination keeps the editor open until commit", async () => {
    await ready(); seen = []; await startRename();
    await act(async () => { browser.select(TO); }); await settle();
    expect(browser.editor.path).not.toBeNull();
    expect(reads.some(read => read.path === TO)).toBe(false);
    expect(browser.notice).not.toBe("That file does not exist.");
    await act(async () => releaseMove!()); await settle();
    expect(files.has(TO)).toBe(true);
    expectOpen(TO);
    expect(seen).not.toContain(null);
  });
  test("a refresh during rename preserves the pending destination row", async () => {
    await ready(); await startRename();
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    const paths = browser.listings[FOLDER]?.entries.map(e => e.path);
    expect(paths).toContain(TO); expect(paths).not.toContain(FROM);
    expect(tabs.state.activePath).toBe(TO);
    await act(async () => releaseMove!()); await settle();
    expectOpen(TO);
  });
  test("an overlapping duplicate cannot suppress the first rename's editor follow", async () => {
    await ready(); await startRename();
    await act(async () => browser.duplicate(OTHER)); await settle();
    await act(async () => releaseMove!()); await settle();
    expect(files.has(FROM)).toBe(false); expect(files.has(TO)).toBe(true);
    expect(files.has(`${FOLDER}/other copy.md`)).toBe(true);
    expectOpen(TO);
  });
  test("a committed rename follows immediately while confirmation listings hang", async () => {
    await ready(); jest.useFakeTimers(); await startRename();
    actions[fn("listFiles")] = () => new Promise(() => {});
    await act(async () => releaseMove!()); await settle();
    expect(files.has(TO)).toBe(true);
    expectOpen(TO);
    await act(async () => { jest.advanceTimersByTime(60_000); }); await settle();
    expect(browser.busy).toBe(false);
    expectOpen(TO);
  });
  test("a successful rename arriving after timeout reconciles all surfaces", async () => {
    await ready(); jest.useFakeTimers(); await startRename();
    await act(async () => { jest.advanceTimersByTime(45_001); }); await settle();
    expect(browser.busy).toBe(false);
    await act(async () => releaseMove!()); await settle();
    expect(files.has(TO)).toBe(true); expect(files.has(FROM)).toBe(false);
    expectOpen(TO);
  });
  test("the initial root response cannot overwrite a newer successful create", async () => {
    const staleRoot = listing("");
    let releaseRoot!: () => void;
    let first = true;
    actions[fn("listFiles")] = async (args: never) => {
      const path = (args as {path: string}).path;
      if (path === "" && first) {
        first = false;
        return await new Promise(resolve => { releaseRoot = () => resolve(staleRoot); });
      }
      return listing(path);
    };
    unmount = mount(); await settle();
    await act(async () => browser.createNote("", "created")); await settle();
    expect(browser.editor.path).toBe("created.md");
    expect(browser.listings[""]?.entries.map(e => e.path)).toContain("created.md");
    await act(async () => releaseRoot()); await settle();
    expect(files.has("created.md")).toBe(true);
    expect(browser.listings[""]?.entries.map(e => e.path)).toContain("created.md");
    expectOpen("created.md");
  });
  test("a slow create preserves subsequent navigation to another note", async () => {
    await ready();
    let releaseCreate!: () => void;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const {path, text} = args as {path: string; text: string};
      releaseCreate = () => { files.set(path, text); resolve({etag: `etag:${path}`}); };
    });
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    await act(async () => browser.select(OTHER)); await settle();
    expect(browser.editor.path).toBe(OTHER);
    await act(async () => releaseCreate()); await settle();
    expect(files.has(`${FOLDER}/created.md`)).toBe(true);
    expectOpen(OTHER);
  });

  test.each([false, true])("a failed rename restores all surfaces (after timeout: %s)", async (afterTimeout) => {
    await ready();
    if (afterTimeout) jest.useFakeTimers();
    let rejectMove!: (reason: Error) => void;
    actions[fn("moveEntry")] = () => new Promise((_resolve, reject) => { rejectMove = reject; });
    await startRename();
    if (afterTimeout) {
      await act(async () => { jest.advanceTimersByTime(45_001); }); await settle();
    }
    await act(async () => rejectMove(new Error("Move denied"))); await settle();
    expect(files.has(FROM)).toBe(true);
    expect(files.has(TO)).toBe(false);
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(FROM);
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).not.toContain(TO);
    expectOpen(FROM);
    expect(browser.busy).toBe(false);
  });

  test("a rename completing from the old workspace cannot reopen its note in the new one", async () => {
    await ready(); await startRename();
    await act(async () => switchWorkspace("w2")); await settle();
    expect(browser.contextId).toBe("w2");
    expect(browser.editor.path).toBeNull();
    await act(async () => releaseMove!()); await settle();
    expect(files.has(TO)).toBe(true);
    expect(browser.editor.path).toBeNull();
    expect(browser.selectedPath).toBeNull();
    expect(tabs.state.tabs).toEqual([]);
    expect(urlNote).toBeNull();
    expect(reads.filter(read => read.workspaceId === "w2")).toEqual([]);
  });

  test("rename replaces the URL so browser history does not retain the vanished source", async () => {
    await ready(); addressWrites = [];
    await startRename();
    await act(async () => releaseMove!()); await settle();
    expectOpen(TO);
    expect(addressWrites.filter(write => write.note === TO)).toEqual([{ note: TO, mode: "replace" }]);
  });
  test("a late successful rename preserves navigation made after its timeout", async () => {
    await ready(); jest.useFakeTimers(); await startRename();
    await act(async () => { jest.advanceTimersByTime(45_001); }); await settle();
    await act(async () => { browser.select(OTHER); }); await settle();
    expectOpen(OTHER);
    await act(async () => releaseMove!()); await settle();
    expect(files.has(TO)).toBe(true);
    expectOpen(OTHER);
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(TO);
  });
  test("a stale refresh started in the same millisecond cannot undo a confirmed create", async () => {
    await ready(); jest.useFakeTimers();
    const stale = listing(FOLDER);
    let releaseStale!: () => void;
    let first = true;
    actions[fn("listFiles")] = async (args: never) => {
      const path = (args as {path: string}).path;
      if (path === FOLDER && first) {
        first = false;
        return await new Promise(resolve => { releaseStale = () => resolve(stale); });
      }
      return listing(path);
    };
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    expectOpen(`${FOLDER}/created.md`);
    await act(async () => releaseStale()); await settle();
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(`${FOLDER}/created.md`);
    expectOpen(`${FOLDER}/created.md`);
  });
  test("overlapping renames each carry the held draft to their own destination", async () => {
    await ready(); jest.useFakeTimers();
    const releases = new Map<string, () => void>();
    actions[fn("moveEntry")] = (args: never) => new Promise(resolve => {
      const { from, to } = args as { from: string; to: string };
      releases.set(from, () => {
        files.set(to, files.get(from)!); files.delete(from);
        resolve({ from, to, paths: [to] });
      });
    });
    await act(async () => browser.rename(FROM, "Launch plan")); await settle();
    await act(async () => browser.setDraft("# draft\n\nHeld draft A\n")); await settle();
    await act(async () => { browser.select(OTHER); }); await settle();
    expectOpen(OTHER);
    await act(async () => browser.rename(OTHER, "Other renamed")); await settle();
    await act(async () => browser.setDraft("# other\n\nHeld draft B\n")); await settle();
    await act(async () => releases.get(FROM)!()); await settle();
    expect(files.get(TO)).toContain("Held draft A");
    expect(files.has(FROM)).toBe(false);
    await act(async () => releases.get(OTHER)!()); await settle();
    await act(async () => { jest.advanceTimersByTime(2_001); }); await settle();
    expect(files.get(`${FOLDER}/Other renamed.md`)).toContain("Held draft B");
    expect(files.has(OTHER)).toBe(false);
    expectOpen(`${FOLDER}/Other renamed.md`);
  });

  test.each([false, true])("hanging rename reads release the draft hold after bounded waits (all reads hang: %s)", async (allHang) => {
    await ready(); jest.useFakeTimers(); await startRename();
    let readsAtDestination = 0;
    actions[fn("readNote")] = async (args: never) => {
      const { path } = args as { path: string };
      if (path === TO && (++readsAtDestination === 1 || allHang)) return await new Promise<OpenNote>(() => {});
      return read(path);
    };
    await act(async () => releaseMove!()); await settle();
    await act(async () => browser.setDraft("# draft\n\nTyped during confirmation\n")); await settle();
    await act(async () => { jest.advanceTimersByTime(10_001); }); await settle();
    await act(async () => { jest.advanceTimersByTime(10_001); }); await settle();
    await act(async () => { jest.advanceTimersByTime(2_001); }); await settle();
    expect(files.get(TO)).toContain("Typed during confirmation");
    expect(files.has(FROM)).toBe(false);
    expectOpen(TO);
  });
  test("a pending create cannot be renamed before its storage write exists", async () => {
    await ready();
    let releaseCreate!: () => void;
    let moveRequests = 0;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const { path, text } = args as { path: string; text: string };
      releaseCreate = () => { files.set(path, text); resolve({ etag: `etag:${path}` }); };
    });
    actions[fn("moveEntry")] = async () => { moveRequests += 1; throw new Error("Missing source"); };
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    await act(async () => browser.rename(`${FOLDER}/created.md`, "Created renamed")); await settle();
    expect(moveRequests).toBe(0);
    expect(browser.notice).toMatch(/still being created/i);
    await act(async () => releaseCreate()); await settle();
    expectOpen(`${FOLDER}/created.md`);
    expect(files.has(`${FOLDER}/Created renamed.md`)).toBe(false);
  });
});
