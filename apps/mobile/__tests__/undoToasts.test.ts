/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The way back from a move, a rename and an archive.
 *
 * `ToastHost` has existed in `features/design/components` since the console was
 * built, with an undo slot and an eight-second budget tuned in its own doc
 * comment for exactly this — and **nothing imported it**. Every one of these
 * three operations succeeded in silence, and the only way back from a move was
 * to find the file again in the folder it had just left.
 *
 * Two properties are what make an undo honest rather than decorative, and both
 * are asserted on the *call*, never on the outcome:
 *
 *  - **It is the inverse, not a repeat.** `moveEntry` inverts by swapping its
 *    ends, so an undo that passed the original `from`/`to` again would look
 *    identical in every rendered state and move nothing back. The direction is
 *    the whole test.
 *  - **Only the last operation is on offer.** An undo is computed against the
 *    tree as it was; run it after something else has moved the same file and it
 *    names a path the bucket no longer has. `run` clears the list before every
 *    operation for that reason.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];

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

const NOTE = "1-projects/note.md";
const FOLDER = "1-projects";
const ARCHIVED = "4-archive/2026-08-26T09-14-02-113Z/1-projects/note.md";

function entry(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [entry(NOTE, "file"), entry(FOLDER, "folder"), entry("2-areas", "folder")],
  truncated: false,
  manifestUsable: true,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

function moves(): { from: string; to: string }[] {
  return calls
    .filter((c) => c.name === name("moveEntry"))
    .map((c) => c.args as { from: string; to: string })
    .map(({ from, to }) => ({ from, to }));
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", canEdit: true, isOwner: true });
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
    await Promise.resolve();
  });
}

describe("an operation with an inverse offers it", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async () => ROOT;
    actions[name("moveEntry")] = async () => ({ path: NOTE });
    actions[name("archiveEntry")] = async () => ({ path: NOTE, to: ARCHIVED });
    actions[name("duplicateEntry")] = async () => ({ path: NOTE, to: "1-projects/note 2.md" });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("a move offers the move back, with the ends swapped", async () => {
    unmount = mount();
    await settle();

    await act(async () => browser.move(NOTE, "2-areas"));
    await settle();

    expect(browser.toasts).toHaveLength(1);
    expect(browser.toasts[0]!.message).toBe("Moved to 2-areas.");
    expect(moves()).toEqual([{ from: NOTE, to: "2-areas/note.md" }]);

    await act(async () => browser.toasts[0]!.undo!());
    await settle();

    // The direction. A repeat of the original call would be indistinguishable
    // in every rendered state and would move nothing back.
    expect(moves()[1]).toEqual({ from: "2-areas/note.md", to: NOTE });
  });

  test("a move to the root says so in words", async () => {
    // `""` is the root, and "Moved to ." is not a sentence. Every other place
    // that has to name it spells it out the same way.
    unmount = mount();
    await settle();

    // A note whose name the root does not already carry — a collision is
    // refused before the server is reached, and this test is about the wording
    // of a move that happens.
    await act(async () => browser.move("1-projects/plan.md", ""));
    await settle();

    expect(browser.toasts[0]!.message).toBe("Moved to the root of your context.");
  });

  test("a rename offers the old name back", async () => {
    unmount = mount();
    await settle();

    await act(async () => browser.rename(NOTE, "renamed.md"));
    await settle();

    expect(browser.toasts[0]!.message).toBe("Renamed to renamed.md.");
    expect(moves()).toEqual([{ from: NOTE, to: "1-projects/renamed.md" }]);

    await act(async () => browser.toasts[0]!.undo!());
    await settle();

    expect(moves()[1]).toEqual({ from: "1-projects/renamed.md", to: NOTE });
  });

  test("an archive is undone by a move out of the archive", async () => {
    /*
      There is no "unarchive" action. `archiveEntry` puts the file under a
      timestamped folder and returns where it landed, so the way back is an
      ordinary move from there to where it was — the same arithmetic the row
      menu's Restore does through `restoreTargetFor`.
    */
    unmount = mount();
    await settle();

    await act(async () => browser.archive(NOTE));
    await settle();

    expect(browser.toasts[0]!.message).toBe("Archived note.md.");
    expect(moves()).toEqual([]);

    await act(async () => browser.toasts[0]!.undo!());
    await settle();

    expect(moves()).toEqual([{ from: ARCHIVED, to: NOTE }]);
  });

  test("only the last operation is on offer", async () => {
    /*
      The stale-inverse case. Move, then rename: the move's undo names
      `2-areas/note.md`, which the rename has since taken away. Offering both
      would put a button on screen that fails at the server for a reason
      nobody looking at it could work out.
    */
    unmount = mount();
    await settle();

    await act(async () => browser.move(NOTE, "2-areas"));
    await settle();
    const first = browser.toasts[0]!.id;

    await act(async () => browser.rename("2-areas/note.md", "renamed.md"));
    await settle();

    expect(browser.toasts).toHaveLength(1);
    expect(browser.toasts[0]!.id).not.toBe(first);
    expect(browser.toasts[0]!.message).toBe("Renamed to renamed.md.");
  });

  test("dismissing takes it away", async () => {
    unmount = mount();
    await settle();

    await act(async () => browser.move(NOTE, "2-areas"));
    await settle();

    await act(async () => browser.dismissToast(browser.toasts[0]!.id));
    expect(browser.toasts).toEqual([]);
  });

  test("a failed operation offers nothing to undo", async () => {
    // The offer is the inverse of something that happened. Nothing happened.
    actions[name("moveEntry")] = async () => {
      throw new Error("nope");
    };
    unmount = mount();
    await settle();

    await act(async () => browser.move(NOTE, "2-areas"));
    await settle();

    expect(browser.toasts).toEqual([]);
    expect(browser.notice).not.toBeNull();
  });

  test("an operation whose listing did not reload offers nothing either", async () => {
    /*
      The mutation landed; the tree on screen may be wrong. An undo offered
      against a listing we have just told the person not to trust is an undo
      aimed at a path we cannot vouch for, so the notice wins outright.
    */
    unmount = mount();
    await settle();

    let first = true;
    actions[name("listFiles")] = async () => {
      if (first) {
        first = false;
        throw new Error("listing gone");
      }
      return ROOT;
    };

    await act(async () => browser.move(NOTE, "2-areas"));
    await settle();

    expect(browser.toasts).toEqual([]);
    expect(browser.notice).toContain("did not reload");
  });

  test("an operation with no inverse offers none", async () => {
    // Duplicate creates something new; there is nothing to put back. Its
    // absence here is what stops "every operation gets a toast" from creeping
    // in as a convention.
    unmount = mount();
    await settle();

    await act(async () => browser.duplicate(NOTE));
    await settle();

    expect(browser.toasts).toEqual([]);
  });
});
