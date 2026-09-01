/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **A team link opened the context and not the note.**
 *
 * `teamShareLink` hands somebody `/console/@seyi?note=3-resources/…md`, and the
 * whole point of that URL over `/s/<token>` is that it says what it points at.
 * Following one on a cold load — which is what following a link *is* — landed
 * on "Choose a note to read or edit it", over a context whose notes were
 * sitting right there.
 *
 * ## The cause is effect order, which is why nothing saw it
 *
 * The route's "open the note the URL names" effect lives in
 * `app/(app)/console/[slug]/index.tsx`; the file browser's "forget the old
 * context" effect lives in `useFileBrowser`, which is mounted by the console
 * **layout** — the route's parent. React runs a child's effects before its
 * parent's, so in the one commit where `selectedContextId` goes from `null` to
 * the workspace the URL names, both fire in this order:
 *
 *   1. the route selects the linked note,
 *   2. the browser resets for its new context and clears the selection.
 *
 * The route had already recorded the URL as honoured, so nothing retried and
 * the selection stayed empty until the person tapped something themselves.
 *
 * Warm navigation — following a link while already inside that context — never
 * reproduced it, because the browser's effect does not re-run when nothing
 * about the workspace changed. Every existing test exercised the warm path.
 *
 * ## What is asserted
 *
 * The cold path, against the real `useFileBrowser`, with the route's effect in
 * a real child component so the ordering is the reconciler's rather than the
 * test's. A string of `act`s cannot stand in for that: the bug is that two
 * effects ran in one commit in an order neither of them chose.
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
import { useLinkedNote } from "../features/console/useLinkedNote";

const NOTE = "3-resources/engineering/shipping-an-expo-app-safely.md";
const FOLDER = "3-resources/engineering";

function entry(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "team" as const,
    inherited: "team" as const,
    exception: false,
    readOnly: false,
  };
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "team",
  entries: [entry("3-resources", "folder")],
  truncated: false,
  manifestUsable: true,
};

const NOTE_BODY: OpenNote = {
  path: NOTE,
  text: "# Shipping an expo app safely\n",
  etag: "etag-1",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;
let setContext: (id: string | null) => void;

/**
 * The console's real shape: the layout owns the browser, the route is a child
 * of it, and only the child knows what the URL asked for.
 *
 * `workspaceId` starts `null` and is set from outside, which is what
 * `useLiveConsoleData` does — `selectedContextId` is derived from a Convex
 * subscription, so it is `null` for every render before the workspace list
 * lands. That first non-null render is the whole of this bug.
 */
function mount(note: string | null): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Route({ files, contextId }: { files: FileBrowser; contextId: string | null }): ReactNode {
    useLinkedNote(files, note, contextId);
    return null;
  }

  function Layout(): ReactNode {
    const [contextId, setId] = useState<string | null>(null);
    setContext = setId;
    const files = useFileBrowser({
      workspaceId: contextId as never,
      tier: "private",
      canEdit: true,
      isOwner: true,
    });
    browser = files;
    return createElement(Route, { files, contextId });
  }

  act(() => {
    root.render(createElement(Layout));
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

describe("a team link opens the note it names", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async (args: never) => {
      const path = (args as { path: string }).path;
      return path === "" ? ROOT : { ...ROOT, path, entries: [entry(NOTE, "file")] };
    };
    actions[name("readNote")] = async () => NOTE_BODY;
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("the note the URL names is open once the context has resolved", async () => {
    unmount = mount(NOTE);
    await settle();

    // The workspace list lands. This is the commit the bug lived in.
    await act(async () => setContext("w1"));
    await settle();

    expect(browser.selectedPath).toBe(NOTE);
    expect(browser.editor.path).toBe(NOTE);
    expect(calls.filter((c) => c.name === name("readNote"))).toHaveLength(1);
  });

  test("…and a folder the URL names is selected too, with its own listing asked for", async () => {
    unmount = mount(FOLDER);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    expect(browser.selectedPath).toBe(FOLDER);
    expect(
      calls.filter((c) => c.name === name("listFiles") && (c.args as { path: string }).path === FOLDER),
    ).toHaveLength(1);
  });

  test("a URL naming no note leaves the console where it was", async () => {
    // The positive control for the guard, not for the fix: without it the two
    // tests above would pass on a hook that selects something unconditionally.
    unmount = mount(null);
    await settle();
    await act(async () => setContext("w1"));
    await settle();

    expect(browser.selectedPath).toBeNull();
  });

  test("the link is honoured once, so tapping another note is not undone", async () => {
    unmount = mount(NOTE);
    await settle();
    await act(async () => setContext("w1"));
    await settle();
    expect(browser.selectedPath).toBe(NOTE);

    await act(async () => {
      browser.select("3-resources");
    });
    await settle();

    // Re-applying the URL on every render would drag somebody back to the
    // linked note the moment they opened anything else.
    expect(browser.selectedPath).toBe("3-resources");
  });
});
