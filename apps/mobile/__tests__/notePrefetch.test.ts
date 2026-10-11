/**
 * @jest-environment jsdom
 */

/**
 * A NOTE'S READ STARTS WHEN THE POINTER REACHES ITS ROW.
 *
 * Owner, 2026-10-11: "speed is essential, especially for a notetaking app."
 * `notePrefetch.ts` asks for the read on hover or press-in, and the open that
 * follows uses that answer instead of asking again. These hold the rules that
 * keep it the read, early, and never a stale copy: used once, young or
 * nothing, failures forgotten, and never for the note the editor holds.
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
import {
  PREFETCH_FRESH_MS,
  PREFETCH_LIMIT,
  createNotePrefetch,
} from "../features/console/files/fileBrowser/notePrefetch";

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



describe("createNotePrefetch", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000;
  });

  test("an early read is handed to the open that follows, once", async () => {
    const early = createNotePrefetch<string>(now);
    let starts = 0;
    early.prefetch("a", async () => {
      starts += 1;
      return "A";
    });
    early.prefetch("a", async () => {
      starts += 1;
      return "A again";
    });
    expect(starts).toBe(1);
    await expect(early.take("a")).resolves.toBe("A");
    expect(early.take("a")).toBeUndefined();
  });

  test("an early read past its freshness is dropped, not used", () => {
    const early = createNotePrefetch<string>(now);
    early.prefetch("a", async () => "A");
    clock += PREFETCH_FRESH_MS;
    expect(early.take("a")).toBeUndefined();
  });

  test("a stale one is asked again on the next hover", async () => {
    const early = createNotePrefetch<string>(now);
    early.prefetch("a", async () => "old");
    clock += PREFETCH_FRESH_MS + 1;
    early.prefetch("a", async () => "new");
    await expect(early.take("a")).resolves.toBe("new");
  });

  test("a failed early read is forgotten, so the open asks again", async () => {
    const early = createNotePrefetch<string>(now);
    early.prefetch("a", async () => {
      throw new Error("offline");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(early.take("a")).toBeUndefined();
  });

  test("a start that throws is no entry and no crash", () => {
    const early = createNotePrefetch<string>(now);
    early.prefetch("a", () => {
      throw new Error("no client");
    });
    expect(early.take("a")).toBeUndefined();
  });

  test("hovering down a long list keeps only the last few", () => {
    const early = createNotePrefetch<string>(now);
    for (let index = 0; index <= PREFETCH_LIMIT; index += 1) early.prefetch(`n${index}`, async () => `N${index}`);
    expect(early.take("n0")).toBeUndefined();
    expect(early.take(`n${PREFETCH_LIMIT}`)).toBeDefined();
  });
});

describe("FileBrowser.prefetch", () => {
  let unmount: (() => void) | null = null;
  const reads = () => calls.filter((call) => call.name === name("readNote"));

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async () => ROOT;
    actions[name("readNote")] = async (args: never) => openNote((args as { path: string }).path, false);
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("hovering a note and then opening it reads it once", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    act(() => browser.prefetch?.(NOTE));
    expect(reads()).toHaveLength(1);
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    expect(reads()).toHaveLength(1);
    expect(browser.editor.path).toBe(NOTE);
    expect(browser.editor.draft).toBe("# original\n");
  });

  test("opening it again later asks the server again", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    act(() => browser.prefetch?.(NOTE));
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    await act(async () => {
      browser.select(FOLDER);
    });
    await settle();
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    expect(reads()).toHaveLength(2);
  });

  test("the note the editor holds is never read ahead: its answer would predate the typing", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    const before = reads().length;
    act(() => browser.prefetch?.(NOTE));
    expect(reads()).toHaveLength(before);
  });

  test("a folder is never read as a note", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    act(() => browser.prefetch?.(FOLDER));
    expect(reads()).toHaveLength(0);
  });

  test("a failed early read does not fail the open", async () => {
    unmount = mount({ canEdit: true });
    await settle();
    actions[name("readNote")] = async () => {
      throw new Error("network");
    };
    act(() => browser.prefetch?.(NOTE));
    await settle();
    actions[name("readNote")] = async (args: never) => openNote((args as { path: string }).path, false);
    await act(async () => {
      browser.select(NOTE);
    });
    await settle();
    expect(reads()).toHaveLength(2);
    expect(browser.editor.path).toBe(NOTE);
  });
});
