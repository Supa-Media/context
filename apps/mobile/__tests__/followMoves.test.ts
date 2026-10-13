/**
 * @jest-environment jsdom
 */

/**
 * The open note follows a move made somewhere else (`useFollowMoves.ts`), and
 * only then: a file leaving its live folder (`vanishedFiles`) re-reads the
 * note at its old name, and a read that the forwarding ledger answered at a
 * new name moves the editor there.
 *
 * Sabotage:
 *  - drop the "editor moved on" check in `still` and the own-rename case
 *    fails (this tab's rename would be followed twice);
 *  - follow without comparing the read's path and the same-name case fails;
 *  - drop the `catch` notice and the deleted case fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FOLLOW_DELAY_MS, MOVED_ELSEWHERE, useFollowMoves } from "../features/console/files/fileBrowser/useFollowMoves";
import { vanishedFiles } from "../features/console/files/fileBrowser/useLiveTree";
import type { FolderListing } from "../features/console/files/types";

type Listener = (paths: string[]) => void;

function harness(read: (path: string) => Promise<{ path: string }>) {
  const listeners = new Set<Listener>();
  const editorRef = { current: { path: "a/note.md" as string | null } };
  const openRun = { current: 1 };
  const renamingRef = { current: null as unknown };
  const notices: string[] = [];
  const follows: [string, string][] = [];
  const deps = {
    readNote: ({ path }: { path: string }) => read(path),
    workspaceId: "ws1",
    workspaceGenerationRef: { current: { epoch: 1 } },
    editorRef,
    openRun,
    renamingRef,
    setNotice: (notice: string) => void notices.push(notice),
    subscribeVanished: (listener: Listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    followRename: (from: string, to: string) => void follows.push([from, to]),
  };
  function Probe() {
    useFollowMoves(deps as unknown as Parameters<typeof useFollowMoves>[0]);
    return null;
  }
  const host = document.createElement("div");
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(Probe));
  });
  const vanish = (paths: string[]) => act(() => listeners.forEach((listener) => listener(paths)));
  const settle = async () => {
    await act(async () => {
      jest.advanceTimersByTime(FOLLOW_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  return { editorRef, openRun, renamingRef, notices, follows, vanish, settle, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("following the open note", () => {
  test("a move made elsewhere moves the editor to the forwarded name", async () => {
    const h = harness(async () => ({ path: "b/note.md" }));
    h.vanish(["a/note.md"]);
    await h.settle();
    expect(h.follows).toEqual([["a/note.md", "b/note.md"]]);
    h.unmount();
  });

  test("another file leaving the folder does nothing", async () => {
    const read = jest.fn(async () => ({ path: "b/other.md" }));
    const h = harness(read);
    h.vanish(["a/other.md"]);
    await h.settle();
    expect(read).not.toHaveBeenCalled();
    expect(h.follows).toEqual([]);
    h.unmount();
  });

  test("this tab's own rename, already followed, is not followed again", async () => {
    const read = jest.fn(async () => ({ path: "b/note.md" }));
    const h = harness(read);
    h.vanish(["a/note.md"]);
    h.editorRef.current.path = "a/renamed.md";
    await h.settle();
    expect(read).not.toHaveBeenCalled();
    expect(h.follows).toEqual([]);
    h.unmount();
  });

  test("a rename of this tab's in flight, or another open since, is left alone", async () => {
    const h = harness(async () => ({ path: "b/note.md" }));
    h.vanish(["a/note.md"]);
    h.renamingRef.current = { path: "a/x.md", held: null };
    await h.settle();
    h.renamingRef.current = null;
    h.vanish(["a/note.md"]);
    h.openRun.current += 1;
    await h.settle();
    expect(h.follows).toEqual([]);
    h.unmount();
  });

  test("still at the same name: the listing was behind, nothing moves", async () => {
    const h = harness(async () => ({ path: "a/note.md" }));
    h.vanish(["a/note.md"]);
    await h.settle();
    expect(h.follows).toEqual([]);
    expect(h.notices).toEqual([]);
    h.unmount();
  });

  test("deleted, or moved out of reach: says so and keeps the text on screen", async () => {
    const h = harness(async () => {
      throw new Error("FILE_NOT_FOUND");
    });
    h.vanish(["a/note.md"]);
    await h.settle();
    expect(h.follows).toEqual([]);
    expect(h.notices).toEqual([MOVED_ELSEWHERE]);
    h.unmount();
  });
});

describe("vanishedFiles", () => {
  const page = (paths: string[]): FolderListing => ({
    path: "a",
    folderDefault: "private",
    truncated: false,
    manifestUsable: true,
    entries: paths.map((path) => ({
      kind: path.endsWith(".md") ? ("file" as const) : ("folder" as const),
      path,
      name: path,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
  });

  test("names the files the new answer dropped, never folders, never on a first answer", () => {
    expect(vanishedFiles(undefined, page(["a/x.md"]))).toEqual([]);
    expect(vanishedFiles(new Set(["a/x.md", "a/y.md"]), page(["a/y.md", "a/sub"]))).toEqual(["a/x.md"]);
    expect(vanishedFiles(new Set(["a/x.md"]), page(["a/x.md", "a/z.md"]))).toEqual([]);
  });
});
