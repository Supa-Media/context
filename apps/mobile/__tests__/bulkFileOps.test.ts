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
 * The tree's multi-selection, acted on as one operation.
 *
 * The defect these guard against is not visible in any single call: a loop
 * over `move` or `destroy` reaches the server once per path and *looks* right.
 * What goes wrong is between the calls — each is its own `run`, a newer `run`
 * supersedes an older one, and the person is left with one toast offering to
 * undo the last of five. So the assertions are about the batch as a whole:
 * one sentence, one Undo, and an Undo that inverts every step, last first.
 *
 * Harness and mocking are `undoToasts.test.ts`'s, for the same reason: the
 * inverse is asserted on the *call*, never on the rendered outcome.
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

const A = "1-projects/a.md";
const B = "1-projects/b.md";
const STAMP = "4-archive/2026-08-26T09-14-02-113Z";

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

function listing(path: string, entries: ReturnType<typeof entry>[]): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

const LISTINGS: Record<string, FolderListing> = {
  "": listing("", [entry("1-projects", "folder"), entry("2-areas", "folder")]),
  "1-projects": listing("1-projects", [entry(A, "file"), entry(B, "file")]),
  "2-areas": listing("2-areas", [entry("2-areas/b.md", "file")]),
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

function argsOf(fn: string): unknown[] {
  return calls.filter((call) => call.name === name(fn)).map((call) => call.args);
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true, isOwner: true });
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
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Mount, and load the two folders the batches below read names from. */
async function ready(): Promise<() => void> {
  const unmount = mount();
  await settle();
  await act(async () => {
    await browser.ensureListing("1-projects");
    await browser.ensureListing("2-areas");
  });
  await settle();
  calls.length = 0;
  return unmount;
}

describe("a batch is one operation", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async (args: never) =>
      LISTINGS[(args as { path: string }).path] ?? listing((args as { path: string }).path, []);
    actions[name("moveEntry")] = async () => ({});
    actions[name("copyEntry")] = async () => ({});
    actions[name("archiveEntry")] = async (args: never) => ({
      to: `${STAMP}/${(args as { path: string }).path}`,
    });
    actions[name("trashEntry")] = async (args: never) => ({
      to: `.context/trash/stamp/${(args as { path: string }).path}`,
    });
    actions[name("restoreTrashEntry")] = async () => ({});
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("trashing several says one sentence, and its Undo restores every one, last first", async () => {
    unmount = await ready();

    await act(async () => browser.destroyMany([A, B]));
    await settle();

    expect(argsOf("trashEntry")).toEqual([
      { workspaceId: "w1", path: A },
      { workspaceId: "w1", path: B },
    ]);
    expect(browser.toasts).toHaveLength(1);
    expect(browser.toasts[0]!.message).toBe("Moved 2 items to trash.");

    await act(async () => browser.toasts[0]!.undo!());
    await settle();

    expect(argsOf("restoreTrashEntry")).toEqual([
      { workspaceId: "w1", from: `.context/trash/stamp/${B}`, to: B },
      { workspaceId: "w1", from: `.context/trash/stamp/${A}`, to: A },
    ]);
  });

  test("moving several is one toast whose Undo moves each back with its ends swapped", async () => {
    unmount = await ready();

    await act(async () => browser.moveMany([A, "2-areas/b.md"], ""));
    await settle();

    expect(argsOf("moveEntry")).toEqual([
      { workspaceId: "w1", from: A, to: "a.md" },
      { workspaceId: "w1", from: "2-areas/b.md", to: "b.md" },
    ]);
    expect(browser.toasts.map((toast) => toast.message)).toEqual([
      "Moved 2 items to the root of your context.",
    ]);

    await act(async () => browser.toasts[0]!.undo!());
    await settle();

    expect(argsOf("moveEntry").slice(2)).toEqual([
      { workspaceId: "w1", from: "b.md", to: "2-areas/b.md" },
      { workspaceId: "w1", from: "a.md", to: A },
    ]);
  });

  test("what is already in the destination stays put rather than refusing the rest", async () => {
    unmount = await ready();

    // `a.md` is already in 1-projects; the other one is not.
    await act(async () => browser.moveMany([A, "2-areas/c.md", "2-areas/d.md"], "1-projects"));
    await settle();

    expect(argsOf("moveEntry").map((args) => (args as { from: string }).from)).toEqual([
      "2-areas/c.md",
      "2-areas/d.md",
    ]);
  });

  test("a collision refuses the whole batch before anything moves", async () => {
    unmount = await ready();

    // 2-areas already has b.md: all or nothing, so a.md does not go either.
    await act(async () => browser.moveMany([A, B], "2-areas"));
    await settle();

    expect(argsOf("moveEntry")).toEqual([]);
    expect(browser.notice).toContain(B);
    expect(browser.toasts).toEqual([]);
  });

  test("a batch that stops halfway says how far it got, and offers no Undo for the whole", async () => {
    unmount = await ready();
    let count = 0;
    actions[name("trashEntry")] = async (args: never) => {
      count += 1;
      if (count === 2) throw new Error("gone");
      return { to: `.context/trash/stamp/${(args as { path: string }).path}` };
    };

    await act(async () => browser.destroyMany([A, B, "2-areas/b.md"]));
    await settle();

    // The third is never attempted: the batch stops at the first refusal.
    expect(argsOf("trashEntry")).toHaveLength(2);
    expect(browser.toasts).toEqual([]);
    expect(browser.notice).toMatch(/^Moved 1 item to trash\. b\.md did not: /);
  });

  test("a batch whose first step fails is an ordinary failure", async () => {
    unmount = await ready();
    actions[name("moveEntry")] = async () => {
      throw new Error("nope");
    };

    await act(async () => browser.moveMany([A, B], ""));
    await settle();

    expect(browser.toasts).toEqual([]);
    expect(browser.notice).not.toBeNull();
    expect(browser.notice).not.toMatch(/^Moved/);
  });

  test("archiving several is undone by moving each out of the archive", async () => {
    unmount = await ready();

    await act(async () => browser.archiveMany([A, B]));
    await settle();

    expect(browser.toasts[0]!.message).toBe("Archived 2 items.");
    await act(async () => browser.toasts[0]!.undo!());
    await settle();

    expect(argsOf("moveEntry")).toEqual([
      { workspaceId: "w1", from: `${STAMP}/${B}`, to: B },
      { workspaceId: "w1", from: `${STAMP}/${A}`, to: A },
    ]);
  });

  test("restoring several puts each back where it came from", async () => {
    unmount = await ready();

    await act(async () => browser.restoreMany([`${STAMP}/2-areas/x.md`, `${STAMP}/2-areas/y.md`]));
    await settle();

    expect(argsOf("moveEntry")).toEqual([
      { workspaceId: "w1", from: `${STAMP}/2-areas/x.md`, to: "2-areas/x.md" },
      { workspaceId: "w1", from: `${STAMP}/2-areas/y.md`, to: "2-areas/y.md" },
    ]);
    expect(browser.toasts[0]!.message).toBe("Restored 2 items.");
  });

  test("a restore where one path was never archived does nothing at all", async () => {
    unmount = await ready();

    await act(async () => browser.restoreMany([`${STAMP}/2-areas/x.md`, A]));
    await settle();

    expect(argsOf("moveEntry")).toEqual([]);
  });

  test("copying several plans every name across the batch", async () => {
    unmount = await ready();

    // Both land in 2-areas, which already has b.md: the copy of b takes the
    // next free name rather than colliding, as a single copy does.
    await act(async () => browser.copyManyTo([A, B], "2-areas"));
    await settle();

    expect(argsOf("copyEntry")).toEqual([
      { workspaceId: "w1", from: A, to: "2-areas/a.md" },
      { workspaceId: "w1", from: B, to: "2-areas/b copy.md" },
    ]);
    expect(browser.toasts[0]!.message).toBe("Copied 2 items to areas.");
  });

  test("a batch of one is the single operation, word for word", async () => {
    unmount = await ready();

    await act(async () => browser.destroyMany([A]));
    await settle();

    expect(browser.toasts[0]!.message).toBe("Moved a.md to trash.");
  });
});
