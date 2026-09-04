/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **"THE CONTENTS ARE ON THEIR WAY" IS A STATE, AND IT HAD NO NAME.**
 *
 * Filmed on a phone refreshing `/console/@name?note=…`: a quarter of a second
 * of "Choose a note to read or edit it" over a URL that had already chosen
 * one, on every reload. The console had a name for the *first* half of that
 * gap — the URL read, `select` not yet called — and none for the second, which
 * is the longer one: `selectedPath` moves the instant somebody picks a note,
 * and the body is a Convex action away. In between, a path is selected and
 * `entryAt` has nothing to answer with, which is indistinguishable from an
 * empty console unless the browser says so.
 *
 * `opening` is that sentence. Three properties, and the third is the one a
 * lazier test would skip:
 *
 *  1. It is set while the read is in flight.
 *  2. It clears when the note arrives.
 *  3. **It clears when the read fails.** The pane draws nothing while it is
 *     set, so a flag that survived a refusal would leave somebody on a blank
 *     region under an error notice, with nothing telling them what to do next
 *     — a worse screen than the flicker this replaced, and one no render test
 *     of the pane can see, because the pane is not what fails to clear it.
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

const WORKSPACE = "w1";
const NOTE_PATH = "3-resources/mcp/granola.md";

const NOTE: OpenNote = {
  path: NOTE_PATH,
  text: "# Granola",
  etag: "etag-1",
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
};

/**
 * The root listing, and it does **not** contain the note.
 *
 * That is the cold-load shape rather than a convenience: only the root is
 * fetched on arrival, and a link two folders down names something no listing
 * on hand can answer for. It is exactly the case where the pane has to ask the
 * browser rather than infer.
 */
const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [],
  truncated: false,
  manifestUsable: true,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
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
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  actions[name("listFiles")] = async () => ROOT;
  actions[name("readNote")] = async () => NOTE;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("a note whose body has not arrived", () => {
  test("is named while the read is in flight, and stops being named when it lands", async () => {
    let answer: ((note: OpenNote) => void) | null = null;
    actions[name("readNote")] = () =>
      new Promise<OpenNote>((resolve) => {
        answer = resolve;
      });

    unmount = mount();
    await settle();

    act(() => {
      browser.select(NOTE_PATH);
    });
    expect(browser.selectedPath).toBe(NOTE_PATH);
    expect(browser.opening).toBe(NOTE_PATH);

    await act(async () => {
      (answer as unknown as (note: OpenNote) => void)(NOTE);
      await Promise.resolve();
    });
    await settle();

    expect(browser.opening).toBeNull();
    // The negative control for the assertion above: a hook that cleared the
    // flag without ever opening anything would satisfy it and have deleted the
    // feature.
    expect(browser.editor.path).toBe(NOTE_PATH);
    expect(browser.editor.baseline).toBe(NOTE.text);
  });

  test("stops being named when the server refuses it", async () => {
    actions[name("readNote")] = async () => {
      throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
    };

    unmount = mount();
    await settle();

    act(() => {
      browser.select(NOTE_PATH);
    });
    expect(browser.opening).toBe(NOTE_PATH);

    await settle();

    expect(browser.opening).toBeNull();
    // And the failure is on screen rather than swallowed, which is what makes
    // handing the empty state back the right move.
    expect(browser.notice).toBe("That file does not exist.");
  });

  test("is forgotten when the context changes under an outstanding read", async () => {
    /*
      A read for the previous context settling after somebody has switched.
      `select` is what sets the flag and the reset is what clears it, and the
      one that must win is the reset — a context nobody has asked anything of
      has nothing on its way, and a stale flag would hold its Browse pane blank
      until the next selection.
    */
    actions[name("readNote")] = () => new Promise<OpenNote>(() => {});

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    function Probe({ workspaceId }: { workspaceId: string }) {
      browser = useFileBrowser({ workspaceId, canEdit: true, tier: "private" });
      return null;
    }
    act(() => root.render(createElement(Probe, { workspaceId: WORKSPACE })));
    unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    await settle();

    act(() => {
      browser.select(NOTE_PATH);
    });
    expect(browser.opening).toBe(NOTE_PATH);

    act(() => root.render(createElement(Probe, { workspaceId: "w2" })));
    await settle();

    expect(browser.opening).toBeNull();
    expect(browser.selectedPath).toBeNull();
  });
});
