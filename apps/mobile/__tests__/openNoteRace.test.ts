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
 * **A read still in flight must answer the request that made it, or nobody.**
 *
 * `useFileBrowser` is one instance for the whole console, and `openNote`
 * closes over `workspaceId` with no generation token of its own. A note read
 * still in flight when somebody switches context — or opens a second note
 * before the first one lands — used to resolve into whatever `dispatch` and
 * `setNotice` happened to mean by the time it got an answer: one context's
 * note body under another's chrome, or the second note's request answered
 * with the first note's text.
 *
 * Three shapes of the same bug:
 *
 *  1. A read for the *old* context lands after the person has switched to a
 *     new one — the "note A under B's chrome" case.
 *  2. Two reads for the *same* context, the slower one for the note somebody
 *     opened first — the "note B answered by note A's body" case.
 *  3. A read for a note that was `deselect`-ed before it landed — the closed
 *     editor must not spring back open with content nobody asked for any
 *     more (the interplay with #267's `deselect`).
 *
 * None of these touch `selectedPath` from inside the stale resolution — only
 * `select`/`deselect` ever write it — which is also why the URL mirror
 * (`useNoteAddress`, driven entirely by `files.selectedPath` per
 * `noteAddress.ts`) cannot be re-addressed by a stale `opened`: there is no
 * channel from `openNote`'s dispatch to the address bar that does not pass
 * through `selectedPath`. The assertions below pin `selectedPath` staying
 * exactly what the last real `select`/`deselect` call set, throughout every
 * stale resolution, as the direct proof of that.
 */

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

function name(fn: string): string {
  return `functions/files:${fn}`;
}

function note(path: string, text: string): OpenNote {
  return {
    path,
    text,
    etag: `etag-${path}`,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

const EMPTY_ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [],
  truncated: false,
  manifestUsable: true,
};

/** One outstanding `readNote` call, held open until the test resolves it. */
interface Pending {
  path: string;
  resolve: (note: OpenNote) => void;
}

let pending: Pending[] = [];

/** Resolve the oldest still-outstanding read for `path`, in call order. */
function resolveRead(path: string, result: OpenNote) {
  const index = pending.findIndex((p) => p.path === path);
  if (index === -1) throw new Error(`no pending readNote for ${path}`);
  const [found] = pending.splice(index, 1);
  found.resolve(result);
}

let browser: FileBrowser;

function mount(): {
  rerender: (workspaceId: string) => void;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe({ workspaceId }: { workspaceId: string }) {
    browser = useFileBrowser({ workspaceId, canEdit: true, tier: "private" });
    return null;
  }

  act(() => {
    root.render(createElement(Probe, { workspaceId: "wsA" }));
  });
  return {
    rerender: (workspaceId: string) => {
      act(() => root.render(createElement(Probe, { workspaceId })));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let handle: { rerender: (workspaceId: string) => void; unmount: () => void } | null = null;

beforeEach(() => {
  window.localStorage.clear();
  pending = [];
  actions[name("listFiles")] = async () => EMPTY_ROOT;
  actions[name("readNote")] = (args: never) =>
    new Promise<OpenNote>((resolve) => {
      pending.push({ path: (args as { path: string }).path, resolve });
    });
});

afterEach(() => {
  handle?.unmount();
  handle = null;
});

describe("a stale read answering after the console has moved on", () => {
  test("does not land a switched-from context's note in the new one", async () => {
    handle = mount();
    await settle();
    expect(browser.contextId).toBe("wsA");

    act(() => browser.select("old/context-a.md"));
    expect(pending.map((p) => p.path)).toEqual(["old/context-a.md"]);

    // Switch context before A's read lands.
    handle.rerender("wsB");
    await settle();
    expect(browser.contextId).toBe("wsB");
    expect(browser.selectedPath).toBeNull();

    act(() => browser.select("new/context-b.md"));
    expect(browser.selectedPath).toBe("new/context-b.md");
    expect(pending.map((p) => p.path)).toEqual(["old/context-a.md", "new/context-b.md"]);

    // The stale read for the *old* context's note lands now, after B's read
    // has already been asked for. It must not touch the editor at all: B's
    // context is on screen and B's read has not answered yet.
    await act(async () => {
      resolveRead("old/context-a.md", note("old/context-a.md", "OLD CONTEXT BODY"));
      await Promise.resolve();
    });
    await settle();

    expect(browser.editor.path).not.toBe("old/context-a.md");
    expect(browser.editor.draft).not.toBe("OLD CONTEXT BODY");
    // Nothing has answered B's request yet, so the editor is still empty —
    // not silently populated with A's stale text under B's chrome.
    expect(browser.editor.path).toBeNull();
    // The address mirror's only input, untouched by the stale resolution.
    expect(browser.selectedPath).toBe("new/context-b.md");
    expect(browser.contextId).toBe("wsB");

    // B's own read lands, and it — and only it — reaches the editor.
    await act(async () => {
      resolveRead("new/context-b.md", note("new/context-b.md", "NEW CONTEXT BODY"));
      await Promise.resolve();
    });
    await settle();

    expect(browser.editor.path).toBe("new/context-b.md");
    expect(browser.editor.draft).toBe("NEW CONTEXT BODY");
  });

  test("a second note opened before the first lands wins, not the slower reply", async () => {
    handle = mount();
    await settle();

    act(() => browser.select("first.md"));
    expect(browser.selectedPath).toBe("first.md");

    // A second, quicker open before the first read answers.
    act(() => browser.select("second.md"));
    expect(browser.selectedPath).toBe("second.md");
    expect(pending.map((p) => p.path)).toEqual(["first.md", "second.md"]);

    // The *first* note's read answers last. It must be dropped: the person
    // is looking at "second.md" now, and a stale reply must not overwrite it.
    await act(async () => {
      resolveRead("first.md", note("first.md", "FIRST NOTE BODY"));
      await Promise.resolve();
    });
    await settle();

    expect(browser.editor.path).not.toBe("first.md");
    expect(browser.editor.draft).not.toBe("FIRST NOTE BODY");
    expect(browser.editor.path).toBeNull();
    expect(browser.selectedPath).toBe("second.md");

    await act(async () => {
      resolveRead("second.md", note("second.md", "SECOND NOTE BODY"));
      await Promise.resolve();
    });
    await settle();

    expect(browser.editor.path).toBe("second.md");
    expect(browser.editor.draft).toBe("SECOND NOTE BODY");
  });

  test("a read answering after deselect does not reopen the editor", async () => {
    handle = mount();
    await settle();

    act(() => browser.select("closed-before-it-loaded.md"));
    expect(browser.opening).toBe("closed-before-it-loaded.md");

    act(() => {
      const closed = browser.deselect();
      expect(closed).toBe(true);
    });
    expect(browser.selectedPath).toBeNull();
    expect(browser.editor.path).toBeNull();
    expect(browser.opening).toBeNull();

    // The read that was in flight when `deselect` ran answers now. Nothing on
    // screen asked for it any more, and it must not spring the editor back
    // open — or re-address the URL, which is driven by `selectedPath` alone.
    await act(async () => {
      resolveRead("closed-before-it-loaded.md", note("closed-before-it-loaded.md", "STALE BODY"));
      await Promise.resolve();
    });
    await settle();

    expect(browser.editor.path).toBeNull();
    expect(browser.editor.draft).not.toBe("STALE BODY");
    expect(browser.selectedPath).toBeNull();
    expect(browser.notice).toBeNull();
  });
});
