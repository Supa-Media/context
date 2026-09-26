/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **RENAMING THE NOTE YOU ARE READING KEEPS IT OPEN.**
 *
 * The owner, on staging: "when you rename, the page you are on disappears and
 * it says the file doesn't exist." `useRowCommands.rename` already kept the
 * *editor* on the note — it moves the listing on the press and `select`s the
 * new path once the bucket says yes — and its own tests passed, because they
 * mount the file browser alone. The console mounts it with the tab strip, and
 * the strip is what closed the note:
 *
 *  1. the listing is redrawn at the new name on the press;
 *  2. `useTabs`' "a note that stopped existing cannot stay open" effect
 *     compares its tabs against that listing, finds the old path gone, and
 *     removes the tab — `tabs.ts` has a `renamed` action for exactly this, and
 *     nothing ever dispatched it;
 *  3. with no tab left, the last-tab rule `deselect`s the editor, and the page
 *     is empty — or, with other tabs open, the strip activates a neighbour
 *     and the editor leaves the note it was renaming.
 *
 * So this mounts both hooks the way `console/_layout.tsx` does, and asserts on
 * every render in between — the complaint is about what was on screen while
 * the rename was in flight, and a check of the final state alone would pass on
 * a console that closed the note and opened it again.
 */

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
  if (text === undefined) throw new Error("That file does not exist.");
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

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    tabs = useTabs(browser, "w1");
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

describe("renaming the open note", () => {
  let unmount: (() => void) | null = null;
  /** Lets a test hold the move in flight and look at the screen meanwhile. */
  let releaseMove: (() => void) | null;

  beforeEach(() => {
    seen = [];
    releaseMove = null;
    files = new Map([
      ["index.md", "# index\n"],
      [FROM, "# draft\n\nbody\n"],
      [OTHER, "# other\n"],
    ]);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => read((args as { path: string }).path);
    actions[fn("moveEntry")] = (args: never) =>
      new Promise((resolve) => {
        const { from, to } = args as { from: string; to: string };
        releaseMove = () => {
          const text = files.get(from)!;
          files.delete(from);
          files.set(to, text);
          resolve({ path: to });
        };
      });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  async function renameAndLand() {
    seen = [];
    await act(async () => {
      browser.rename(FROM, "Launch plan");
    });
    await settle();
    // In flight: the row already reads the new name.
    expect(browser.editor.path).toBe(FROM);
    expect(tabs.state.tabs.map((tab) => tab.path)).toContain(TO);
    await act(async () => {
      releaseMove!();
    });
    await settle();
  }

  test("as the only tab: the page never closes, and ends on the new name", async () => {
    unmount = mount();
    await settle();
    await open(FROM);
    expect(browser.editor.path).toBe(FROM);

    await renameAndLand();

    expect(seen).not.toContain(null);
    expect(browser.editor.path).toBe(TO);
    expect(browser.editor.draft).toBe("# draft\n\nbody\n");
    expect(browser.notice).toBeNull();
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([TO]);
    expect(tabs.state.activePath).toBe(TO);
  });

  test("beside another tab: the editor does not jump to the neighbour", async () => {
    unmount = mount();
    await settle();
    await open(OTHER);
    await act(async () => {
      tabs.pin(OTHER);
    });
    await open(FROM);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([OTHER, FROM]);

    await renameAndLand();

    expect(seen).not.toContain(OTHER);
    expect(seen).not.toContain(null);
    expect(browser.editor.path).toBe(TO);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([OTHER, TO]);
    expect(tabs.state.activePath).toBe(TO);
  });

  test("undo takes the tab and the page back to the old name, without closing either", async () => {
    unmount = mount();
    await settle();
    await open(FROM);
    await renameAndLand();
    const toast = browser.toasts[0];
    expect(toast?.undo).toBeDefined();

    seen = [];
    await act(async () => {
      toast!.undo!();
    });
    await settle();
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([FROM]);
    await act(async () => {
      releaseMove!();
    });
    await settle();

    expect(seen).not.toContain(null);
    expect(browser.editor.path).toBe(FROM);
    expect(tabs.state.activePath).toBe(FROM);
  });

  test("a rename the bucket refuses puts the tab back on the old name", async () => {
    unmount = mount();
    await settle();
    await open(FROM);
    actions[fn("moveEntry")] = async () => {
      throw new Error("refused");
    };
    seen = [];
    await act(async () => {
      browser.rename(FROM, "Launch plan");
    });
    await settle();

    expect(seen).not.toContain(null);
    expect(browser.editor.path).toBe(FROM);
    expect(tabs.state.tabs.map((tab) => tab.path)).toEqual([FROM]);
  });
});
