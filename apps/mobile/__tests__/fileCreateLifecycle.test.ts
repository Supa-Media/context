/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { ConvexError } from "convex/values";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Real browser and tab hooks with a controlled storage boundary. */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => actions[name]!(args);
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import { useTabs } from "../features/console/files/useTabs";

const FOLDER = "1-projects";
const FROM = `${FOLDER}/draft.md`;
const OTHER = `${FOLDER}/other.md`;

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
/** The editor's path on every render, so a close-and-reopen cannot hide. */
let seen: (string | null)[];
let switchWorkspace: (id: string) => void;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  let workspaceId = "w1";
  function Probe() {
    browser = useFileBrowser({ workspaceId, tier: "private", canEdit: true });
    useTabs(browser, "w1");
    seen.push(browser.editor.path);
    return null;
  }
  switchWorkspace = (id) => { workspaceId = id; root.render(createElement(Probe)); };
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

describe("create and root lifecycle regressions", () => {
  let unmount: (() => void) | null = null;
  let releaseMove: (() => void) | null = null;
  beforeEach(() => {
    seen = [];
    releaseMove = null;
    files = new Map([["index.md", "# index\n"], [FROM, "# draft\n\nbody\n"], [OTHER, "# other\n"]]);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => read((args as { path: string }).path);
    actions[fn("writeNote")] = async (args: never) => {
      const {path, text} = args as {path: string; text: string};
      files.set(path, text);
      return {etag: `etag:${path}`};
    };
    actions[fn("duplicateEntry")] = async () => ({to: `${FOLDER}/other copy.md`});
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
  afterEach(() => { unmount?.(); unmount = null; jest.useRealTimers(); jest.restoreAllMocks(); });
  async function ready() { unmount = mount(); await settle(); await open(FROM); }
  test("the initial root request preserves a newer successful create", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1_000);
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
    expect(browser.editor.path).toBe("created.md");
  });
  test("a slow create steals selection back after navigating to another note", async () => {
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
    expect(browser.editor.path).toBe(OTHER);
    expect(browser.selectedPath).toBe(OTHER);
    expect(files.has(`${FOLDER}/created.md`)).toBe(true);
  });

  test("a refused initial root clears a newer listing", async () => {
    let refuse!: () => void;
    let first = true;
    actions[fn("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      if (path === "" && first) {
        first = false;
        return await new Promise((_, reject) => {
          refuse = () => reject(new ConvexError({ code: "FORBIDDEN", message: "Access revoked." }));
        });
      }
      return listing(path);
    };
    unmount = mount(); await settle();
    await act(async () => browser.createNote("", "created")); await settle();
    expect(browser.listings[""]).toBeDefined();
    await act(async () => refuse()); await settle();
    expect(browser.listings).toEqual({});
    expect(browser.notice).toBe("Access revoked.");
  });

  test.each(["folder", "closed"])("a slow create preserves navigation to %s", async destination => {
    await ready();
    let release!: () => void;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const { path, text } = args as { path: string; text: string };
      release = () => { files.set(path, text); resolve({ etag: `etag:${path}` }); };
    });
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    await act(async () => {
      if (destination === "closed") browser.deselect();
      else browser.select(FOLDER);
    }); await settle();
    await act(async () => release()); await settle();
    expect(files.has(`${FOLDER}/created.md`)).toBe(true);
    expect(browser.selectedPath).toBe(destination === "closed" ? null : FOLDER);
    expect(browser.editor.path).toBeNull();
  });

  test("navigation during an untitled destination fetch survives its create", async () => {
    unmount = mount(); await settle();
    let release!: () => void;
    let first = true;
    actions[fn("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      if (path === FOLDER && first) {
        first = false;
        return await new Promise(resolve => { release = () => resolve(listing(path)); });
      }
      return listing(path);
    };
    await act(async () => browser.createUntitled(FOLDER, "note")); await settle();
    await act(async () => browser.select("index.md")); await settle();
    await act(async () => release()); await settle();
    expect([...files.keys()].some(path => path.startsWith(`${FOLDER}/untitled-`))).toBe(true);
    expect(browser.selectedPath).toBe("index.md");
    expect(browser.editor.path).toBe("index.md");
  });

  test("a folder refresh from an earlier workspace visit cannot land after switching away and back", async () => {
    unmount = mount(); await settle();
    const stale = listing(FOLDER);
    let release!: () => void;
    let first = true;
    actions[fn("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      if (path === FOLDER && first) {
        first = false;
        return await new Promise(resolve => { release = () => resolve(stale); });
      }
      return listing(path);
    };
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    await act(async () => switchWorkspace("w2")); await settle();
    await act(async () => switchWorkspace("w1")); await settle();
    expect(browser.listings[FOLDER]).toBeUndefined();
    await act(async () => release()); await settle();
    expect(browser.listings[FOLDER]).toBeUndefined();
  });

  test("a refresh begun while creation is pending preserves the new row", async () => {
    await ready();
    let release!: () => void;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const { path, text } = args as { path: string; text: string };
      release = () => { files.set(path, text); resolve({ etag: `etag:${path}` }); };
    });
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(`${FOLDER}/created.md`);
    await act(async () => release()); await settle();
    expect(browser.editor.path).toBe(`${FOLDER}/created.md`);
    expect(browser.notice).toBeNull();
  });

  test("clicking a pending create waits for its write before reading the file", async () => {
    await ready();
    let release!: () => void;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const { path, text } = args as { path: string; text: string };
      release = () => { files.set(path, text); resolve({ etag: `etag:${path}` }); };
    });
    const readAction = actions[fn("readNote")]!;
    const reads: string[] = [];
    actions[fn("readNote")] = async (args: never) => {
      reads.push((args as { path: string }).path);
      return readAction(args);
    };
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    await act(async () => browser.select(`${FOLDER}/created.md`)); await settle();
    expect(reads).not.toContain(`${FOLDER}/created.md`);
    expect(browser.notice).toBeNull();
    await act(async () => release()); await settle();
    expect(browser.editor.path).toBe(`${FOLDER}/created.md`);
    expect(browser.editor.etag).toBe(`etag:${FOLDER}/created.md`);
    expect(browser.notice).toBeNull();
  });

  test("a stale confirmation after create success cannot prune the new editor or row", async () => {
    await ready();
    const stale = listing(FOLDER);
    actions[fn("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      return path === FOLDER ? stale : listing(path);
    };
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(`${FOLDER}/created.md`);
    expect(browser.editor.path).toBe(`${FOLDER}/created.md`);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(`${FOLDER}/created.md`);
    expect(browser.editor.path).toBe(`${FOLDER}/created.md`);
  });

  test("a refused parent refresh removes pending create names from the visible tree", async () => {
    await ready();
    let release!: () => void;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const { path, text } = args as { path: string; text: string };
      release = () => { files.set(path, text); resolve({ etag: `etag:${path}` }); };
    });
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    actions[fn("listFiles")] = async () => {
      throw new ConvexError({ code: "FORBIDDEN", message: "Access revoked." });
    };
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    expect(browser.listings[FOLDER]).toBeUndefined();
    await act(async () => release()); await settle();
    expect(browser.listings[FOLDER]).toBeUndefined();
    expect(browser.editor.path).not.toBe(`${FOLDER}/created.md`);
  });

  test("a create that finishes after timeout still reconciles its row and editor", async () => {
    await ready();
    jest.useFakeTimers();
    let release!: () => void;
    actions[fn("writeNote")] = (args: never) => new Promise(resolve => {
      const { path, text } = args as { path: string; text: string };
      release = () => { files.set(path, text); resolve({ etag: `etag:${path}` }); };
    });
    await act(async () => browser.createNote(FOLDER, "created")); await settle();
    await act(async () => jest.advanceTimersByTime(45_001)); await settle();
    expect(browser.busy).toBe(false);
    await act(async () => browser.ensureListing(FOLDER, true)); await settle();
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(`${FOLDER}/created.md`);
    await act(async () => release()); await settle();
    expect(browser.editor.path).toBe(`${FOLDER}/created.md`);
    expect(browser.listings[FOLDER]?.entries.map(e => e.path)).toContain(`${FOLDER}/created.md`);
    expect(browser.notice).toBeNull();
  });

  test("changing workspace clears busy chrome from a pending rename", async () => {
    await ready();
    await act(async () => browser.rename(FROM, "renamed")); await settle();
    expect(browser.busy).toBe(true);
    await act(async () => switchWorkspace("w2")); await settle();
    expect(browser.busy).toBe(false);
    expect(browser.notice).toBeNull();
    expect(browser.editor.path).toBeNull();
    await act(async () => releaseMove!()); await settle();
    expect(browser.busy).toBe(false);
    expect(browser.editor.path).toBeNull();
  });

  test("clicking a pending renamed folder opens its folder view after commit", async () => {
    await ready();
    await act(async () => browser.select("index.md")); await settle();
    let release!: () => void;
    actions[fn("moveEntry")] = (args: never) => new Promise(resolve => {
      const { from, to } = args as { from: string; to: string };
      release = () => {
        for (const [path, text] of [...files]) {
          if (!path.startsWith(`${from}/`)) continue;
          files.delete(path);
          files.set(`${to}${path.slice(from.length)}`, text);
        }
        resolve({ from, to, paths: [to] });
      };
    });
    const destination = "renamed-projects";
    const readAction = actions[fn("readNote")]!;
    const reads: string[] = [];
    actions[fn("readNote")] = async (args: never) => {
      reads.push((args as { path: string }).path);
      return readAction(args);
    };
    await act(async () => browser.rename(FOLDER, destination)); await settle();
    await act(async () => browser.select(destination)); await settle();
    expect(browser.notice).toBeNull();
    await act(async () => release()); await settle();
    expect(reads).not.toContain(destination);
    expect(browser.selectedPath).toBe(destination);
    expect(browser.editor.path).toBeNull();
    expect(browser.notice).toBeNull();
  });

});
