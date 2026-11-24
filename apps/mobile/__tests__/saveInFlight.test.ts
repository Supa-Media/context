/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import { AUTOSAVE_IDLE_MS } from "../features/console/files/autosave";
import type { FolderListing, OpenNote, SaveResult } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Two saves of one note never race each other (Dev, 2026-11-24).
 *
 * A sheet commits each cell as it is left, so a new row and a typed cell are
 * two edits a second apart. The second one's autosave used to go while the
 * first save was still out, against the same etag; the first landed, and the
 * second was refused as "This note also changed in your bucket", showing the
 * person their own previous save as the other side. A save asked for while
 * one is out is now held and sent when it lands, against the etag it landed
 * with.
 */

/** `useAction` returns a stable function per query reference; the mock must too. */
const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useQueries: () => ({}),
    useConvex: () => ({ query: async () => null }),
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      // Memoised by name. A fresh closure per render would make every callback
      // in `useFileBrowser` unstable and re-run its load effect forever.
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    /**
     * Sharing is not what these tests are about, and both hooks are inert here
     * — but `useFileBrowser` calls them unconditionally, so a mock that omits
     * them fails at the call rather than at an assertion. `useQuery` returns
     * `undefined`, which is what a real "skip" returns and what the browser
     * treats as "not loaded".
     */
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import { useFileBrowser } from "../features/console/files/useFileBrowser";

// The bug was reported on a sheet; the save path is the same for every note, and this harness opens Markdown.
const NOTE_PATH = "1-projects/note.md";

const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "file",
      path: NOTE_PATH,
      name: "note.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

const OPEN_NOTE: OpenNote = {
  path: NOTE_PATH,
  text: "name,notes\n",
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

/** Mount the hook and keep the latest `FileBrowser` in `browser`. */
function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
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

/** Let the pending promise callbacks run without advancing the fake clock. */
async function settle() {
  await act(async () => {
    // The save route is read before the write is sent (`useWriteNote`): a few turns of the queue.
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

describe("a second save while the first is still out", () => {
  let unmount: () => void;
  let calls: { args: { path: string; text: string; expectedEtag?: string }; resolve: (r: SaveResult) => void; reject: (e: unknown) => void }[];

  beforeEach(async () => {
    jest.useFakeTimers();
    calls = [];
    actions[name("listFiles")] = async () => ROOT_LISTING;
    actions[name("readNote")] = (async (args: { path: string }) => ({ ...OPEN_NOTE, path: args.path })) as (args: never) => Promise<unknown>;
    actions[name("writeNote")] = ((args: { path: string; text: string; expectedEtag?: string }) =>
      new Promise<unknown>((resolve, reject) => {
        calls.push({ args, resolve: resolve as (r: SaveResult) => void, reject });
      })) as (args: never) => Promise<unknown>;
    unmount = mount();
    await settle();
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  test("is held until the first lands, then sent on the version it made", async () => {
    act(() => browser.setDraft("name,notes\n,\n"));
    act(() => browser.save());
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.expectedEtag).toBe("etag-1");

    // The next edit, and its autosave coming due while the first save is out.
    act(() => browser.setDraft("name,notes\nTest,\n"));
    act(() => {
      jest.advanceTimersByTime(AUTOSAVE_IDLE_MS + 10);
    });
    await settle();
    expect(calls).toHaveLength(1);

    act(() => calls[0]!.resolve({ path: NOTE_PATH, etag: "etag-2", conflictCheck: "conditional" }));
    await settle();
    await settle();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.text).toBe("name,notes\nTest,\n");
    expect(calls[1]!.args.expectedEtag).toBe("etag-2");
    expect(browser.editor.status).toBe("saving");

    act(() => calls[1]!.resolve({ path: NOTE_PATH, etag: "etag-3", conflictCheck: "conditional" }));
    await settle();
    expect(browser.editor.status).toBe("saved");
    expect(browser.editor.etag).toBe("etag-3");
  });

  test("a refused first save drops the held one, and the person decides", async () => {
    act(() => browser.setDraft("name,notes\n,\n"));
    act(() => browser.save());
    await settle();
    act(() => browser.setDraft("name,notes\nTest,\n"));
    act(() => {
      jest.advanceTimersByTime(AUTOSAVE_IDLE_MS + 10);
    });
    await settle();
    act(() => calls[0]!.reject(Object.assign(new Error("That file changed somewhere else while you were editing it."), { data: { code: "CONFLICT" } })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(browser.editor.draft).toBe("name,notes\nTest,\n");
  });
});
