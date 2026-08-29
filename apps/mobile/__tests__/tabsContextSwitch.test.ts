/**
 * @jest-environment jsdom
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";
import { useTabs } from "../features/console/files/useTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **Why this mounts the hook rather than testing the reducer.**
 *
 * `tabs.ts` already holds the decision — `{ type: "reset" }` empties the strip
 * and `fileTabs.test.ts` proves it. That test passes whether or not anything
 * ever *sends* a reset, which is exactly the gap `#102` measured across this
 * console: every pure-module guard held, every hook guard unheld, 13-for-13
 * against 0-for-14. Sabotaging the dispatch in `useTabs` — `if (false && !first)`
 * — left all 1488 checks green, so the reducer case was a decision nobody was
 * reaching. This is what reaches it.
 *
 * The behaviour: tabs opened in one context must not survive into the next.
 * Pruning cannot do this job, and that is the part that is easy to get wrong —
 * its rule is "a folder that IS loaded and does not hold this note", and a
 * subfolder of the context you left is never loaded in the one you arrive at.
 * So a tab at `1-projects/deals/acquisition.md` survived indefinitely, and the
 * strip showed a note name from the person's own brain while they were inside
 * somebody else's shared workspace.
 */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const noop = () => {};

function listing(path: string, names: string[]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: names.map((name) => ({
      kind: "file" as const,
      path: path === "" ? name : `${path}/${name}`,
      name,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
    truncated: false,
    manifestUsable: true,
  };
}

function browser(listings: Record<string, FolderListing | undefined>): FileBrowser {
  return {
    canEdit: true,
    loading: false,
    busy: false,
    listings,
    expanded: new Set<string>(),
    toggleFolder: noop,
    selectedPath: null,
    select: noop,
    editor: emptyEditor,
    setDraft: noop,
    save: noop,
    useTheirs: noop,
    keepMine: noop,
    discard: noop,
    notice: null,
    dismissNotice: noop,
    clipboard: null,
    copy: noop,
    cut: noop,
    paste: noop,
    copyTo: noop,
    createNote: noop,
    createFolder: noop,
    rename: noop,
    move: noop,
    duplicate: noop,
    archive: noop,
    destroy: noop,
    setVisibility: noop,
    resetPrivacy: noop,
    canResetPrivacy: false,
    canSetVisibility: false,
  };
}

/** Mount `useTabs` and expose it, so a test can drive it like the frame does. */
function mountTabs(): {
  render: (contextKey: string | null, listings: Record<string, FolderListing | undefined>) => void;
  open: (path: string) => void;
  openPaths: () => string[];
} {
  let live: ReturnType<typeof useTabs> | null = null;
  function Probe({
    contextKey,
    listings,
  }: {
    contextKey: string | null;
    listings: Record<string, FolderListing | undefined>;
  }) {
    live = useTabs(browser(listings), contextKey);
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    render: (contextKey, listings) =>
      act(() => {
        root.render(createElement(Probe, { contextKey, listings }));
      }),
    /** Open a tab through the hook's own API, as the tree does. */
    open: (path: string) =>
      act(() => {
        live?.pin(path);
      }),
    openPaths: () => (live?.state.tabs ?? []).map((tab) => tab.path),
  };
}

describe("tabs do not survive a context switch", () => {
  test("a tab in a subfolder of the context you left is gone", () => {
    const A = { "1-projects/deals": listing("1-projects/deals", ["acquisition.md"]) };
    const probe = mountTabs();

    probe.render("workspace-a", A);
    probe.open("1-projects/deals/acquisition.md");
    expect(probe.openPaths()).toEqual(["1-projects/deals/acquisition.md"]);

    // Context B. `1-projects/deals` is not loaded here — under PARA both
    // contexts have a `1-projects`, and the subfolder is simply not one B has
    // looked at — so pruning cannot and must not close this tab. Only the
    // switch itself can.
    probe.render("workspace-b", { "": listing("", ["index.md"]) });
    expect(probe.openPaths()).toEqual([]);
  });

  test("the landing page is a context like any other", () => {
    const probe = mountTabs();
    probe.render("workspace-a", { "": listing("", ["note.md"]) });
    probe.open("note.md");
    expect(probe.openPaths()).toEqual(["note.md"]);

    probe.render(null, {});
    expect(probe.openPaths()).toEqual([]);
  });

  test("re-rendering the SAME context keeps the strip", () => {
    // The control. Without it, a reset dispatched on every render would pass
    // both tests above while making tabs useless.
    const A = { "": listing("", ["note.md"]) };
    const probe = mountTabs();
    probe.render("workspace-a", A);
    probe.open("note.md");
    probe.render("workspace-a", A);
    probe.render("workspace-a", { ...A, "1-projects": listing("1-projects", []) });
    expect(probe.openPaths()).toEqual(["note.md"]);
  });
});


/**
 * The wiring, asserted at the source.
 *
 * The tests above hand `useTabs` a `contextKey` directly, so they cannot see
 * whether the frame passes a real one — replacing `data.selectedContextId` with
 * a constant left all 1491 checks green. That is the same gap `#102`'s review
 * caught in its render test: an input the test supplies is an input the test
 * cannot check. `authHandleCode.test.ts` already reads a layout this way for
 * the same reason.
 */
describe("the console frame keys its tabs on the open context", () => {
  test("_layout passes the selected context id, not a constant", () => {
    const layout = readFileSync(
      join(__dirname, "..", "app", "(app)", "console", "_layout.tsx"),
      "utf8",
    );
    expect(layout).toContain("useTabs(data.files, data.selectedContextId)");
  });
});
