/**
 * @jest-environment jsdom
 */

/**
 * THE CONSOLE'S EDITOR, LENT TO A FOLDER PAGE'S SIDE PEEK.
 *
 * Decided by the owner on 2026-09-28: "the side panel shouldnt be read only,
 * it should be editable". A folder page holds no note in the editor, so the
 * peek puts one there (`openBeside`) — read the way any note is read, with
 * the server deciding whether this person may — and takes it out again when
 * it closes (`closeBeside`), leaving the selection on the folder throughout.
 * Mounted with `convex/react` mocked, as `selectFolder.test.ts` does.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";

const calls: { name: string; args: unknown }[] = [];
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= async (args: never) => {
        calls.push({ name, args });
        const path = (args as { path: string }).path;
        if (name === "functions/files:listFiles") {
          return { kind: "listing", path, folderDefault: "team", entries: [], truncated: false, manifestUsable: true };
        }
        if (name === "functions/files:readNote") {
          if (path.endsWith("hidden.md")) {
            const { ConvexError } = require("convex/values") as typeof import("convex/values");
            throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
          }
          return { path, text: `# ${path}\n`, etag: "e1", visibility: "team", inherited: "team", exception: false, readOnly: false };
        }
        return null;
      };
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

let browser: FileBrowser;
let unmount: () => void;

beforeEach(() => {
  calls.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true, isOwner: true });
    return null;
  }
  act(() => root.render(createElement(Probe)));
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
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

const reads = () => calls.filter((call) => call.name === "functions/files:readNote").map((call) => (call.args as { path: string }).path);

describe("lending the editor to the peek", () => {
  test("opens the note in the editor, read by the server, and leaves the folder selected", async () => {
    act(() => void browser.select("1-projects/cafe"));
    await settle();
    let lent = false;
    act(() => void (lent = browser.openBeside!("1-projects/cafe/lease.md")));
    await settle();
    expect(lent).toBe(true);
    expect(reads()).toEqual(["1-projects/cafe/lease.md"]);
    expect(browser.editor.path).toBe("1-projects/cafe/lease.md");
    expect(browser.editor.draft).toBe("# 1-projects/cafe/lease.md\n");
    expect(browser.selectedPath).toBe("1-projects/cafe");
    expect(browser.beside).toBe("1-projects/cafe/lease.md");
  });

  test("closing gives it back: the editor holds nothing, and the folder is still selected", async () => {
    act(() => void browser.select("1-projects/cafe"));
    act(() => void browser.openBeside!("1-projects/cafe/lease.md"));
    await settle();
    act(() => void browser.closeBeside!("1-projects/cafe/lease.md"));
    await settle();
    expect(browser.editor.path).toBeNull();
    expect(browser.beside).toBeNull();
    expect(browser.selectedPath).toBe("1-projects/cafe");
  });

  test("a note the server refuses is not put in the editor", async () => {
    act(() => void browser.select("1-projects/cafe"));
    act(() => void browser.openBeside!("1-projects/cafe/hidden.md"));
    await settle();
    expect(browser.editor.path).toBeNull();
  });

  test("only a note is lent, never a folder", async () => {
    let lent = true;
    act(() => void (lent = browser.openBeside!("1-projects/cafe/kitchen")));
    await settle();
    expect(lent).toBe(false);
    expect(reads()).toEqual([]);
  });

  test("closing a note that is no longer the one lent changes nothing", async () => {
    act(() => void browser.select("1-projects/cafe"));
    act(() => void browser.openBeside!("1-projects/cafe/lease.md"));
    await settle();
    act(() => void browser.openBeside!("1-projects/cafe/budget.md"));
    await settle();
    // The first peek's cleanup runs after the second's open, as React orders them.
    act(() => void browser.closeBeside!("1-projects/cafe/lease.md"));
    await settle();
    expect(browser.editor.path).toBe("1-projects/cafe/budget.md");
    // Still lent: the tab strip still leaves it out, and its own close still gives it back.
    expect(browser.beside).toBe("1-projects/cafe/budget.md");
  });

  test("selecting the lent note (Expand) keeps it open, as the selection", async () => {
    act(() => void browser.select("1-projects/cafe"));
    act(() => void browser.openBeside!("1-projects/cafe/lease.md"));
    await settle();
    act(() => void browser.select("1-projects/cafe/lease.md"));
    await settle();
    act(() => void browser.closeBeside!("1-projects/cafe/lease.md"));
    await settle();
    expect(browser.selectedPath).toBe("1-projects/cafe/lease.md");
    expect(browser.editor.path).toBe("1-projects/cafe/lease.md");
    expect(browser.beside).toBeNull();
  });
});
