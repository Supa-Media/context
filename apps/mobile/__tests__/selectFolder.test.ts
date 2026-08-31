/**
 * @jest-environment jsdom
 */

/**
 * OPENING A FOLDER THE CONSOLE HAS NEVER LISTED.
 *
 * Reported with a screenshot: following a team link to a folder showed **"That
 * file does not exist"** over an empty page — on the reporter's own context,
 * about a folder that plainly does.
 *
 * `select` decided folder-ness with `findEntry`, which looks a path up in its
 * *parent's* listing. On a cold load — a link opened straight into
 * `/console/@seyi?note=1-projects/pilot`, nothing expanded yet — the parent is
 * absent, so the entry is unknown, so the folder fell through to `readNote` and
 * got `FILE_NOT_FOUND`.
 *
 * The comment above that branch already described this exact failure ("the
 * console would tell somebody their own folder does not exist") and guarded
 * only the case where the listing happened to be loaded. Every test passed,
 * because every test expanded the tree first.
 *
 * So these mount the hook with **nothing loaded**, which is the state a link
 * arrives in.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";

/** Every action call the hook made, so a test can assert what it did *not* do. */
const calls: { name: string; args: unknown }[] = [];
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= async (args: never) => {
        calls.push({ name, args });
        if (name === "functions/files:listFiles") {
          return {
            kind: "listing",
            path: (args as { path: string }).path,
            folderDefault: "team",
            entries: [],
            truncated: false,
            manifestUsable: true,
          };
        }
        // A real `ConvexError`, not a plain one with `.data` bolted on:
        // `toFileError` reads the class, so a hand-rolled shape falls back to
        // "That did not work" and the test would assert against a message the
        // product never shows. This is what the server actually throws, and
        // what the reporter saw on screen.
        const { ConvexError } = require("convex/values") as typeof import("convex/values");
        throw new ConvexError({
          code: "FILE_NOT_FOUND",
          message: "That file does not exist.",
        });
      };
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import { useFileBrowser } from "../features/console/files/useFileBrowser";

let browser: FileBrowser;
let unmount: () => void;

beforeEach(() => {
  calls.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", canEdit: true, isOwner: true, tier: "private" });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
});

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** What `select` asked the server to read, if anything. */
function reads(): string[] {
  return calls
    .filter((call) => call.name === "functions/files:readNote")
    .map((call) => (call.args as { path: string }).path);
}

function listed(): string[] {
  return calls
    .filter((call) => call.name === "functions/files:listFiles")
    .map((call) => (call.args as { path: string }).path);
}

describe("a folder opened from a link, with nothing loaded", () => {
  /**
   * THE test. The folder's parent has never been listed, so `findEntry` knows
   * nothing about it — and the old code read it as a note.
   */
  test("is not read as a note", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects/pilot"));
    await settle();

    expect(reads()).toEqual([]);
  });

  test("does not tell the owner their own folder does not exist", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects/pilot"));
    await settle();

    expect(browser.notice).toBeNull();
  });

  /**
   * And it loads what the folder view is about to draw. Without this the
   * screen is correct and empty, which is the second half of the same bug.
   */
  test("loads the folder's own listing", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects/pilot"));
    await settle();

    expect(listed()).toContain("1-projects/pilot");
  });

  test("is selected, so the pane has something to render", async () => {
    act(() => browser.select("1-projects/pilot"));
    await settle();
    expect(browser.selectedPath).toBe("1-projects/pilot");
  });
});

describe("a note opened from a link, with nothing loaded", () => {
  /**
   * The other half: an unknown `.md` must still be read. Deciding "unknown
   * means folder" would break every note link, which is the failure mode
   * opposite to the one being fixed.
   */
  test("is read", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects/plan.md"));
    await settle();

    expect(reads()).toEqual(["1-projects/plan.md"]);
  });

  test("and a genuine miss is still reported", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects/gone.md"));
    await settle();

    // The mock throws FILE_NOT_FOUND for every read, which is what a deleted
    // note does. That refusal is honest and must survive the fix.
    expect(browser.notice).toContain("does not exist");
  });

  test("an uppercase extension is still a note", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects/PLAN.MD"));
    await settle();

    expect(reads()).toEqual(["1-projects/PLAN.MD"]);
  });
});

describe("a folder at the root", () => {
  test("is a folder too", async () => {
    calls.length = 0;
    act(() => browser.select("1-projects"));
    await settle();

    expect(reads()).toEqual([]);
    expect(listed()).toContain("1-projects");
  });
});
