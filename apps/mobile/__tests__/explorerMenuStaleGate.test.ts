/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";

/**
 * **A capability read inside a callback but absent from its dependency array is
 * a capability frozen at first render.**
 *
 * `menu.ts` decides correctly and is well tested; `Explorer` decides *when to
 * ask it*. `openMenu` read `files.canSetVisibility` while depending only on
 * `[files.canEdit, files.clipboard, platform]`, and `canSetVisibility` is
 * `canEdit && isOwner` — so it can change while all three of those hold still.
 *
 * That is reachable rather than theoretical: `app/(app)/console/_layout.tsx`
 * mounts `<Explorer>` with no `key`, in a layout that persists across
 * `/console/@a` → `/console/@b`. Owning A and editing B keeps `canEdit` true;
 * the reset effect calls `setClipboard(null)` on a clipboard that is already
 * `null`, so React bails and its identity does not change either. The callback
 * is never rebuilt, and it keeps context A's ownership.
 *
 * The consequence is the one PR #93/#95 removed from three other surfaces: a
 * control offered to somebody the server will refuse. It is not privilege
 * escalation — `functions/files.ts` requires `minimum: "owner"` and
 * `fileOps.ts` refuses any non-`private` scope a second time — but this
 * codebase says in three places that a control present and refused is itself
 * the defect.
 *
 * `eslint` had been reporting exactly this as a warning the whole time, and
 * `pnpm --filter @context/mobile lint` exits 0 on warnings, so CI was green
 * over it. That is the same shape as the `ci / Lint` job that "reported
 * skipping on every PR for months" — a signal that runs and does not block.
 */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "file",
      path: "1-projects/note.md",
      name: "note.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

const noop = () => {};

/** A browser that differs from render to render in exactly one field. */
function browser(canSetVisibility: boolean): FileBrowser {
  // Typed, not cast. A cast here would let the fixture drift away from
  // `FileBrowser` silently, which is exactly what it had already done.
  return {
    canEdit: true,
    contextId: "w1",
    loading: false,
    busy: false,
    listings: { "": ROOT_LISTING },
    expanded: new Set<string>(),
    toggleFolder: noop,
    collapseAll: noop,
    selectedPath: null,
    // `select` answers whether the unsaved-changes guard let go; these
    // fixtures have no draft, so it always does.
    select: () => true,
    search: async () => ({ hits: [], indexMissing: false, indexIncomplete: false }),
    // `emptyEditor` rather than a hand-written literal. The first version of
    // this fixture was copied from a shape `EditorState` no longer has — it was
    // missing `status` and `baseline` and carried four fields that are gone —
    // and only the `as unknown as` cast below hid it. `Explorer` does not read
    // `files.editor` today; the day it does, a stale fixture would hand it
    // `undefined` and this security regression test would pass for the wrong
    // reason.
    editor: emptyEditor,
    setDraft: noop,
    save: noop,
    useTheirs: noop,
    keepMine: noop,
    conflict: null,
    resolveWith: noop,
    discard: noop,
    notice: null,
    dismissNotice: noop,
    toasts: [],
    dismissToast: noop,
    // Stable across renders on purpose: `null` is what the context-switch reset
    // effect writes onto an already-`null` clipboard, which React bails on.
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
    canSetVisibility,
    canShare: false,
    shares: undefined,
    share: () => {},
    revokeShare: () => {},
    copyShareLink: async () => ({ ok: false, message: null }),
    setSharePreviewTitle: () => {},
  };
}

function mountExplorer(): {
  render: (canSetVisibility: boolean) => void;
  container: HTMLElement;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    render: (canSetVisibility: boolean) =>
      act(() => {
        // The menu renders through `Menu.web.tsx`'s `Sheet`, which reads safe-area
        // insets — the real app provides them in `app/_layout.tsx`. Without this
        // the menu opens and then throws, which reads exactly like it never
        // opened.
        root.render(
          createElement(
            SafeAreaProvider,
            {
              initialMetrics:
                initialWindowMetrics ??
                ({
                  frame: { x: 0, y: 0, width: 1280, height: 800 },
                  insets: { top: 0, left: 0, right: 0, bottom: 0 },
                } as never),
            },
            createElement(Explorer, {
              files: browser(canSetVisibility),
              contextLabel: "@somebody",
            }),
          ),
        );
      }),
  };
}

/**
 * Right-click the row.
 *
 * `rowInteractions.web.ts` binds `contextmenu` to the underlying DOM node
 * through a ref callback — react-native-web's `Pressable` forwards no
 * `onContextMenu` prop — so there is no React handler to find and no single
 * element that is obviously "the row". Dispatching at every node that carries
 * the name walks the same subtree the listener is somewhere inside of, and the
 * event bubbles, so exactly one of them reaches it.
 */
function openRowMenu(container: HTMLElement): void {
  const nodes = [...container.querySelectorAll("*")].filter((node) =>
    node.textContent?.includes("note"),
  );
  expect(nodes.length).toBeGreaterThan(0);
  act(() => {
    for (const node of nodes) {
      node.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
      );
    }
  });
}

describe("the context menu asks the current browser, not the first one", () => {
  test("an owner who becomes a non-owner stops being offered Visibility", () => {
    const explorer = mountExplorer();

    // Owner. The submenu is offered — this half is the positive control, and
    // without it a menu that never renders would pass the assertion below.
    explorer.render(true);
    openRowMenu(explorer.container);
    expect(document.body.textContent).toContain("Visibility");

    // The same mounted component, now a non-owner. `canEdit` and `clipboard`
    // are unchanged, which is the whole point: nothing in the old dependency
    // array moved.
    explorer.render(false);
    openRowMenu(explorer.container);
    expect(document.body.textContent).not.toContain("Visibility");
  });
});
