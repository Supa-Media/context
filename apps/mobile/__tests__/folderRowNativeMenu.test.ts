/**
 * @jest-environment jsdom
 */

/**
 * A row in the folder listing has a menu on a phone.
 *
 * This is the half no DOM assertion can reach, and it is the one the
 * complaint was actually about. `FolderView`'s rows went through
 * `useRightClick`, whose **native** half is a documented no-op — it exists
 * "to give the web file a shape to be the other half of". On the native
 * build there is no file tree at compact density (`app/frame.ts`), so this
 * listing is the only browse surface there is, and every verb the sidebar
 * offers by long press — rename, move, duplicate, visibility, archive,
 * delete — could not be reached at all.
 *
 * `useRowInteractions` is the pair whose native half is `onLongPress`, which
 * is why the fix is "call the hook the tree calls" rather than "add a menu
 * here". So what is held here is exactly that: the listing calls that hook,
 * once per row, with the row's own menu and the row's own drag verdicts. The
 * hook is mocked, because what its native half does with those options is its
 * own test's business (`rowInteractions.ts`) and mounting the real one under
 * jsdom would resolve the web half anyway (see `jest.config.js`).
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

/** What each row asked the shared hook for, in the order the rows are drawn. */
const asked: { path: string; hasMenu: boolean; canDrag: boolean; canDrop: boolean }[] = [];

jest.mock("../features/console/files/rowInteractions", () => ({
  LONG_PRESS_MS: 400,
  useRowInteractions: (options: {
    path: string;
    onMenu?: unknown;
    canDrag: boolean;
    canDrop: boolean;
  }) => {
    asked.push({
      path: options.path,
      hasMenu: options.onMenu !== undefined,
      canDrag: options.canDrag,
      canDrop: options.canDrop,
    });
    return { pressableProps: {} };
  },
}));

const { FolderView } =
  require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");
type FileEntry = import("../features/console/files/types").FileEntry;
type FolderListing = import("../features/console/files/types").FolderListing;
type FolderDrag = import("../features/console/files/FolderView").FolderDrag;

function entry(over: Partial<FileEntry> & Pick<FileEntry, "path" | "name">): FileEntry {
  return {
    kind: "file",
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
    ...over,
  } as FileEntry;
}

const FOLDER = entry({ path: "2-areas", name: "2-areas", kind: "folder" });

const LISTING: FolderListing = {
  path: "2-areas",
  folderDefault: "team",
  entries: [
    entry({ path: "2-areas/health", name: "health", kind: "folder" }),
    entry({ path: "2-areas/journal.md", name: "journal.md" }),
    entry({ path: "2-areas/privacy.md", name: "privacy.md", readOnly: true }),
  ],
  truncated: false,
  manifestUsable: true,
};

const DRAG: FolderDrag = {
  canDrag: (one) => !one.readOnly,
  canDrop: (one) => one.kind === "folder",
  onDragStart: () => {},
  onDragOver: () => {},
  onDragLeave: () => {},
  onDrop: () => {},
  onDragEnd: () => {},
  target: null,
};

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  asked.length = 0;
});

function render(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(FolderView, {
        entry: FOLDER,
        listing: LISTING,
        canSetVisibility: true,
        contextLabel: "Seyi",
        onSelect: () => {},
        ...props,
      } as never),
    );
  });
}

/* -------------------------------------------------------------------------- */

describe("every row goes through the hook the tree's rows go through", () => {
  test("once per row, in listing order", () => {
    render({ menu: { onRow: () => true, onBackground: () => true }, drag: DRAG });
    expect(asked.map((one) => one.path)).toEqual([
      "2-areas/health",
      "2-areas/journal.md",
      "2-areas/privacy.md",
    ]);
  });

  test("each one carrying its own menu — which is the phone's long press", () => {
    render({ menu: { onRow: () => true, onBackground: () => true }, drag: DRAG });
    expect(asked.every((one) => one.hasMenu)).toBe(true);
  });

  test("and its own drag verdicts, asked of the entry rather than assumed", () => {
    render({ menu: { onRow: () => true, onBackground: () => true }, drag: DRAG });
    // `privacy.md` is generated, so it is not a source; only the folder is a
    // target. Both answers come from the pane, which asks `dnd.ts`.
    expect(asked.map((one) => one.canDrag)).toEqual([true, true, false]);
    expect(asked.map((one) => one.canDrop)).toEqual([true, false, false]);
  });

  test("a read-only console passes no menu, so the press is not swallowed", () => {
    // The hook returns nothing to spread when `onMenu` is absent, and that is
    // what stops a long press opening nothing *and* eating the tap that was
    // meant to open the note.
    render({ drag: undefined });
    expect(asked.map((one) => one.hasMenu)).toEqual([false, false, false]);
    expect(asked.map((one) => one.canDrag)).toEqual([false, false, false]);
  });
});
