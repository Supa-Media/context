/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A refused reload that nobody awaited still has to reach a person.**
 *
 * `refresh` is fired with `void` from four places — expanding a folder,
 * selecting one, reloading a parent after a save, and opening the tree down to
 * a selection — and `run` is the only caller that awaits it. So a refusal at
 * any of those four was an unhandled rejection and a folder that stayed empty:
 * no listing, no notice, and no way for the person to tell a context they have
 * been removed from apart from a folder that happens to have nothing in it.
 *
 * `cachedAfterRefusal.test.ts` names this and steps around it — "`toggleFolder`
 * fires it with `void`, so a rejection there has nowhere to go, which is true
 * of this hook before this change" — and that was fair when it was written,
 * because `refresh` only threw for a folder with *nothing* cached. It now
 * throws on every server refusal, deliberately: repainting a listing after a
 * refusal discloses exactly the note names the refusal withheld. Strengthening
 * that guarantee turned a rare silence into the ordinary one, which is why the
 * catch is part of the same change rather than a follow-up.
 *
 * Each test asserts on `notice` — the copy the pane renders — rather than on a
 * flag, and each seeds a **cached** listing for the folder it refuses, because
 * that is the case that used to be absorbed and is now the case that throws.
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
import * as cache from "../features/offline/cache";
import { openStore } from "../features/offline/store.web";

const WORKSPACE = "w1";
const FOLDER = "1-projects";
const DENIED = "You are not a member of this context.";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

function listing(path: string, entries: FolderListing["entries"] = []): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

const ROOT = listing("", [
  {
    kind: "folder",
    path: FOLDER,
    name: "1-projects",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  },
]);

/** The names on the device, which must not be repainted after a refusal. */
const CACHED_FOLDER = listing(FOLDER, [
  {
    kind: "file",
    path: `${FOLDER}/pay.md`,
    name: "pay.md",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  },
]);

let browser: FileBrowser;
/** Anything the runtime had nowhere to put — the other half of the bug. */
let unhandled: unknown[] = [];

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

function onUnhandled(reason: unknown) {
  unhandled.push(reason);
}

let unmount: (() => void) | null = null;

beforeEach(async () => {
  window.localStorage.clear();
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  actions[name("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    return path === "" ? ROOT : listing(path);
  };
  await cache.putListing(openStore(), "private", WORKSPACE, CACHED_FOLDER, Date.now());
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  unmount?.();
  unmount = null;
});

/** Refuse every listing except the root, which has already loaded. */
function refuseFolders() {
  actions[name("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    if (path === "") return ROOT;
    throw new ConvexError({ code: "NOT_A_MEMBER", message: DENIED });
  };
}

describe("expanding a folder the server refuses", () => {
  test("says so, rather than showing an empty folder", async () => {
    unmount = mount();
    await settle();
    refuseFolders();

    await act(async () => {
      browser.toggleFolder(FOLDER);
    });
    await settle();

    expect(browser.notice).toBe(DENIED);
    // And the refusal is still a refusal: the cached names stay off the screen.
    expect(JSON.stringify(browser.listings)).not.toContain("pay.md");
  });

  test("and nothing is left as an unhandled rejection", async () => {
    /*
      The half a `notice` assertion cannot see. A `void` promise that rejects
      is a process-level warning in node and, in a browser, a red console entry
      on somebody's machine with a bucket path in it.
    */
    unmount = mount();
    await settle();
    refuseFolders();

    await act(async () => {
      browser.toggleFolder(FOLDER);
    });
    await settle();

    expect(unhandled).toEqual([]);
  });
});

describe("selecting a folder the server refuses", () => {
  test("says so", async () => {
    unmount = mount();
    await settle();
    refuseFolders();

    await act(async () => {
      browser.select(FOLDER);
    });
    await settle();

    expect(browser.notice).toBe(DENIED);
    expect(unhandled).toEqual([]);
  });
});

describe("opening the tree down to a selected note", () => {
  test("a refused ancestor listing says so", async () => {
    /*
      The effect that keeps the tree open down to `selectedPath`. It is reached
      on a cold load from a team link — `/console/@seyi?note=1-projects/x.md` —
      where nothing is expanded and the ancestors have to be fetched. Nobody
      awaits that one either.
    */
    unmount = mount();
    await settle();
    refuseFolders();
    /*
      The note itself reads fine. That is what isolates this call site: if the
      read were refused too, `openNote`'s own catch would put the same sentence
      on screen and the assertion would pass whatever the effect did.
    */
    actions[name("readNote")] = async () => ({
      path: `${FOLDER}/pay.md`,
      text: "a body the person is allowed to see",
      etag: "e1",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    });

    await act(async () => {
      browser.select(`${FOLDER}/pay.md`);
    });
    await settle();

    expect(browser.notice).toBe(DENIED);
    expect(unhandled).toEqual([]);
  });
});

describe("a save whose parent listing is then refused", () => {
  test("the save stands, and the refusal is still reported", async () => {
    /*
      The fourth site. `save` reloads the parent folder so a newly created note
      appears in the tree, and fires it with `void` because the save has
      already succeeded and nothing is waiting on the reload. A refusal there
      used to be silent — the note saved, the tree stale, and no sentence
      anywhere. The editor keeps its saved state; only `notice` changes.
    */
    unmount = mount();
    await settle();

    actions[name("readNote")] = async () => ({
      path: `${FOLDER}/pay.md`,
      text: "before",
      etag: "e1",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    });
    await act(async () => {
      browser.select(`${FOLDER}/pay.md`);
    });
    await settle();

    actions[name("writeNote")] = async () => ({ etag: "e2", conflictCheck: "conditional" });
    refuseFolders();
    await act(async () => {
      browser.setDraft("after");
    });
    await act(async () => {
      browser.save();
    });
    await settle();

    expect(browser.editor.status).toBe("saved");
    expect(browser.notice).toBe(DENIED);
    expect(unhandled).toEqual([]);
  });
});

