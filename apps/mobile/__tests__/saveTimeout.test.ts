/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import { SAVE_TIMEOUT_MS, saveButton } from "../features/console/files/editor";
import type { FolderListing, OpenNote, SaveResult } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A save that never comes back must not lock the editor.
 *
 * ## The trap
 *
 * `writeNote` is a Convex **action**, and `ConvexReactClient.action()` has no
 * client-side timeout. Drop the connection mid-save and that promise stays
 * pending for the life of the page. The editor then sits in `saving`, where:
 *
 *  - `saveButton` reports `{ label: "Saving…", disabled: true }`;
 *  - `NoteEditor` renders Discard only for `dirty` and `error`, so it is absent;
 *  - `guardLeaving` refuses to open another note, because the draft is unsaved.
 *
 * There is no control left on the screen. The only way out is a reload, which
 * throws the draft away — the one outcome an editor over somebody's own notes
 * cannot afford.
 *
 * ## Why this mounts the hook
 *
 * The timer lives in `useFileBrowser`, between the dispatch and the action, so
 * a reducer test cannot reach it: `editorReducer` is happy to handle
 * `saveTimedOut` whether or not anything ever sends one. This mounts the real
 * hook against a `writeNote` that never resolves, runs the clock forward, and
 * asserts on the controls the pane would actually render.
 *
 * Verified to fail with the fix reverted: without the timer the editor is still
 * `saving` after 30s and Save is still disabled.
 */

/** `useAction` returns a stable function per query reference; the mock must too. */
const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
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

const NOTE_PATH = "1-projects/note.md";
const OTHER_PATH = "1-projects/other.md";

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
  text: "# note\n\noriginal\n",
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
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("a note save that never comes back", () => {
  let unmount: () => void;
  /** Resolvers for the save in flight, so a test can decide what happens. */
  let pending: { resolve: (r: SaveResult) => void; reject: (e: unknown) => void } | null;

  beforeEach(async () => {
    jest.useFakeTimers();
    pending = null;
    actions[name("listFiles")] = async () => ROOT_LISTING;
    actions[name("readNote")] = async () => OPEN_NOTE;
    actions[name("writeNote")] = () =>
      new Promise<unknown>((resolve, reject) => {
        pending = { resolve: resolve as (r: SaveResult) => void, reject };
      });

    unmount = mount();
    await settle();

    // Open the note and type into it, so there is a draft worth protecting.
    await act(async () => {
      browser.select(NOTE_PATH);
    });
    await settle();
    act(() => browser.setDraft("# note\n\nsomething I just wrote\n"));
    expect(browser.editor.status).toBe("dirty");
  });

  afterEach(() => {
    unmount();
    jest.useRealTimers();
  });

  test("leaves no control on the screen while it is in flight — which is the bug", async () => {
    act(() => browser.save());
    expect(browser.editor.status).toBe("saving");
    // Every escape is shut: Save disabled, Discard not rendered for `saving`,
    // and another note refused. This is the state that must not be permanent.
    expect(saveButton(browser.editor).disabled).toBe(true);
    await act(async () => {
      browser.select(OTHER_PATH);
    });
    expect(browser.selectedPath).toBe(NOTE_PATH);
    expect(browser.notice).toMatch(/unsaved changes/);
  });

  test("times out into a state that offers a way forward", () => {
    act(() => browser.save());
    act(() => {
      jest.advanceTimersByTime(SAVE_TIMEOUT_MS);
    });

    expect(browser.editor.status).toBe("error");
    // Save is pressable again…
    expect(saveButton(browser.editor)).toEqual({ label: "Save", disabled: false });
    // …Discard is rendered (`NoteEditor` draws it for `dirty | error`)…
    expect(["dirty", "error"]).toContain(browser.editor.status);
    // …and the draft is untouched, which is the whole point.
    expect(browser.editor.draft).toBe("# note\n\nsomething I just wrote\n");
    // The message is honest about not knowing whether the write landed.
    expect(browser.editor.message).toMatch(/don't know whether that save landed/);
  });

  test("discarding after a timeout really does let go of the draft", async () => {
    act(() => browser.save());
    act(() => {
      jest.advanceTimersByTime(SAVE_TIMEOUT_MS);
    });
    // `NoteEditor` renders Discard for `dirty | error` only, so the button this
    // test presses does not exist unless the timeout landed us in `error`.
    expect(browser.editor.status).toBe("error");
    act(() => browser.discard());
    expect(browser.editor.status).toBe("clean");
    expect(browser.editor.draft).toBe(OPEN_NOTE.text);
    // And now the person can open something else, which they could not before.
    await act(async () => {
      browser.select(OTHER_PATH);
    });
    expect(browser.selectedPath).toBe(OTHER_PATH);
  });

  test("a write that lands after we stopped waiting cannot mark the draft saved", async () => {
    act(() => browser.save());
    act(() => {
      jest.advanceTimersByTime(SAVE_TIMEOUT_MS);
    });
    // Meanwhile the person keeps typing.
    act(() => browser.setDraft("# note\n\nand then some more\n"));

    // The original write finally completes, half a minute late.
    act(() => pending!.resolve({ path: NOTE_PATH, etag: "etag-2", conflictCheck: "conditional" }));
    await settle();

    // It must not be allowed to say "Saved" about text it never carried. That
    // would set `baseline` to the newer draft and lose it silently on the next
    // navigation — the failure this whole file exists to prevent, arriving by
    // the back door.
    expect(browser.editor.status).not.toBe("saved");
    expect(browser.editor.draft).toBe("# note\n\nand then some more\n");
  });

  test("a save that answers in time is unaffected", async () => {
    act(() => browser.save());
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    act(() => pending!.resolve({ path: NOTE_PATH, etag: "etag-2", conflictCheck: "conditional" }));
    await settle();

    expect(browser.editor.status).toBe("saved");
    expect(browser.editor.etag).toBe("etag-2");

    // And the timer it cancelled cannot fire later and drag it into an error.
    act(() => {
      jest.advanceTimersByTime(SAVE_TIMEOUT_MS * 2);
    });
    expect(browser.editor.status).toBe("saved");
  });
});
