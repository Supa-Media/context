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
 * against 0-for-14. Neutering the reset dispatch in `useTabs` left all 1488
 * checks green, so the reducer case was a decision nobody was reaching. This is
 * what reaches it.
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

function browser(
  listings: Record<string, FolderListing | undefined>,
  openPath: string | null = null,
): FileBrowser {
  return {
    canEdit: true,
    loading: false,
    busy: false,
    listings,
    expanded: new Set<string>(),
    toggleFolder: noop,
    selectedPath: null,
    select: noop,
    // A note already open at mount, which is what reloading the console on a
    // note looks like. Without one, a redundant reset at mount hits
    // `useReducer`'s bail-out and is invisible.
    editor: openPath === null ? emptyEditor : { ...emptyEditor, status: "clean", path: openPath },
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
  render: (
    contextKey: string | null,
    listings: Record<string, FolderListing | undefined>,
    openPath?: string | null,
  ) => void;
  open: (path: string) => void;
  close: (path: string) => void;
  reopen: () => void;
  openPaths: () => string[];
  closedStack: () => string[];
} {
  let live: ReturnType<typeof useTabs> | null = null;
  function Probe({
    contextKey,
    listings,
    openPath,
  }: {
    contextKey: string | null;
    listings: Record<string, FolderListing | undefined>;
    openPath: string | null;
  }) {
    live = useTabs(browser(listings, openPath), contextKey);
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
    render: (contextKey, listings, openPath = null) =>
      act(() => {
        root.render(createElement(Probe, { contextKey, listings, openPath }));
      }),
    /** Open a tab through the hook's own API, as the tree does. */
    open: (path: string) =>
      act(() => {
        live?.pin(path);
      }),
    close: (path: string) =>
      act(() => {
        live?.close(path);
      }),
    reopen: () =>
      act(() => {
        live?.reopen();
      }),
    openPaths: () => (live?.state.tabs ?? []).map((tab) => tab.path),
    closedStack: () => [...(live?.state.closed ?? [])],
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


describe("the guards inside the switch", () => {
  /**
   * The mount case, which an earlier comment in `useTabs.ts` claimed could not
   * be tested and was wrong about.
   *
   * The reset effect runs on mount like any other, and the `opened` effect
   * above it has already put a tab in the strip by then. Without the equality
   * check the strip is wiped on arrival — invisible only when the state is
   * already empty, because the redundant `reset` hits `useReducer`'s bail-out.
   */
  test("arriving with a note already open keeps its tab", () => {
    const probe = mountTabs();
    probe.render("workspace-a", { "": listing("", ["open.md"]) }, "open.md");
    expect(probe.openPaths()).toEqual(["open.md"]);
  });

  /**
   * A -> B -> A. The ref has to move forward, not merely be compared against.
   *
   * Pinned at the first key, the first switch resets and the second does not —
   * so tabs opened in B survive back into A, which is this file's own bug
   * returning on the most ordinary navigation a context rail produces. Nothing
   * in the first version of this suite caught it.
   */
  test("switching back to the first context clears it too", () => {
    const probe = mountTabs();
    probe.render("workspace-a", { "": listing("", ["a.md"]) });
    probe.open("a.md");

    // B's tab is in a SUBFOLDER, and that is the whole point. A root-level tab
    // is closed by pruning on the way back — so a test using one passes whether
    // or not the reset fires, which is how the first version of this test
    // missed the mutation it was written for. A subfolder of B is never loaded
    // in A, so nothing but the switch can close it.
    const bDeep = { "2-areas/deals": listing("2-areas/deals", ["b-secret.md"]) };
    probe.render("workspace-b", bDeep);
    expect(probe.openPaths()).toEqual([]);
    probe.open("2-areas/deals/b-secret.md");
    expect(probe.openPaths()).toEqual(["2-areas/deals/b-secret.md"]);

    probe.render("workspace-a", { "": listing("", ["a.md"]) });
    expect(probe.openPaths()).toEqual([]);
  });

  /**
   * The pruning *dispatch*, as opposed to the pruning decision.
   *
   * `tabsToClose` is pure and `fileTabs.test.ts` covers it thoroughly — which
   * is exactly why this is needed. A decision nothing acts on looks identical
   * to a decision that is correct, and a well-tested pure module beside an
   * unheld caller is more misleading than no module at all: it manufactures the
   * appearance of coverage. Replacing the loop's iterable with `[]` failed
   * nothing before this test existed.
   */
  test("a note that stopped existing loses its tab", () => {
    const probe = mountTabs();
    probe.render("workspace-a", { "": listing("", ["gone.md", "stays.md"]) });
    probe.open("gone.md");
    probe.open("stays.md");
    expect(probe.openPaths()).toEqual(["gone.md", "stays.md"]);

    // Same context, refreshed listing: one note is no longer there.
    probe.render("workspace-a", { "": listing("", ["stays.md"]) });
    expect(probe.openPaths()).toEqual(["stays.md"]);
  });

  /**
   * Which ACTION the switch sends, not merely that the strip ends up empty.
   *
   * Clearing the tabs with a per-tab `closed` or `removed` loop leaves the strip
   * looking right and every other test here green — 1495 of them — while the
   * previous context's note paths sit in the reopen stack. ⌘⇧T then puts one
   * back on screen, which is the failure this whole change exists to remove.
   *
   * `fileTabs.test.ts` asserts `reset` empties `closed`, and cannot reach this:
   * it dispatches the action directly, so it proves the reducer and says nothing
   * about what the hook chooses to send. That is the same "well-tested pure
   * module beside an unheld call site" gap the last round found here twice, on
   * the one clause written to close it.
   */
  test("the reopen stack does not survive the switch either", () => {
    const probe = mountTabs();
    probe.render("workspace-a", { "": listing("", ["a1.md", "a2.md"]) });
    probe.open("a1.md");
    probe.open("a2.md");
    probe.close("a1.md");
    // Closed with ⌘W, so it IS on the stack — without this the assertion below
    // would hold over an empty stack and prove nothing.
    expect(probe.closedStack()).toEqual(["a1.md"]);

    probe.render("workspace-b", { "": listing("", ["b1.md"]) });
    expect(probe.openPaths()).toEqual([]);
    expect(probe.closedStack()).toEqual([]);

    // And the control the stack exists for: ⌘⇧T brings back nothing.
    probe.reopen();
    expect(probe.openPaths()).toEqual([]);
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
    // Comments **and string literals** stripped, and the call counted rather
    // than merely found. Each of those closes a hole the previous shape had:
    //
    //  - a `toContain` is satisfied by the literal sitting in a `//` comment
    //    above a call that passes something else, which is CLAUDE.md's "an
    //    import guard that read English prose as code";
    //  - stripping only comments leaves the same trick available in a string,
    //    `const wiring = "useTabs(data.files, data.selectedContextId)"`, which
    //    is prose read as code by the same mechanism;
    //  - and presence *anywhere* never establishes that the call the component
    //    makes is the wired one — a dead helper appended to the file satisfies
    //    it while the real call passes a constant. Hence exactly one.
    //
    // Both defeats were demonstrated against the previous version, with the
    // whole suite green while `useTabs` received a constant.
    const code = layout
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    expect(code.match(/useTabs\s*\(/g) ?? []).toHaveLength(1);
    // The second argument may be `data.selectedContextId`, or a local holding
    // it — hoisting a long expression into a name is an ordinary refactor, and
    // a guard that red-lights one gets deleted by whoever hits it. But "an
    // identifier" is not the same as "the right value", and a previous version
    // of this test accepted the difference: `const tabsKey = "one-context"`
    // passed all 1496 checks with the console permanently keyed on a constant,
    // which is the bug this whole change exists to remove. So a name is
    // accepted only when the file also assigns it from `data.selectedContextId`.
    const call = code.match(/useTabs\s*\(\s*data\.files\s*,\s*([^,)]+?)\s*,?\s*\)/);
    expect(call).not.toBeNull();
    const arg = call![1].trim();
    if (arg !== "data.selectedContextId") {
      expect(arg).toMatch(/^[A-Za-z_$][\w$]*$/);
      expect(code).toMatch(new RegExp(`\\b${arg}\\s*=\\s*data\\.selectedContextId\\b`));
    }
  });
});
