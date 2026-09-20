/**
 * @jest-environment jsdom
 */

/**
 * The sort control reaches the folder page, not just the tree.
 *
 * The third instance of "things you can do to a folder in the sidebar that you
 * cannot do to it in the middle", and the one with no module to point at: the
 * direction lived in `Explorer`'s own `useState`, so pressing "Sort Z to A"
 * reordered the sidebar and left the very same folder, drawn as a page beside
 * it, still A to Z.
 *
 * `FolderView.tsx` opens by calling itself "the tree, in the other place", and
 * the one screen where a person would check that was where it was false. So
 * the state moved into `listingOrder.ts` and both surfaces read it.
 *
 * Asserted on the **drawn order of the rows**, not on the store's value: a
 * store that flips a boolean nobody renders from is the version of this fix
 * that passes a test and changes nothing on screen.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const { FolderView } =
  require("../features/console/files/FolderView") as typeof import("../features/console/files/FolderView");
const { setListingOrder, resetListingOrder } =
  require("../features/console/files/listingOrder") as typeof import("../features/console/files/listingOrder");
const { listedEntries } =
  require("../features/console/files/tree") as typeof import("../features/console/files/tree");
type FileEntry = import("../features/console/files/types").FileEntry;
type FolderListing = import("../features/console/files/types").FolderListing;

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

/** Two folders and two notes, so "folders first" survives the reversal too. */
const LISTING: FolderListing = {
  path: "2-areas",
  folderDefault: "team",
  entries: [
    entry({ path: "2-areas/admin", name: "admin", kind: "folder" }),
    entry({ path: "2-areas/health", name: "health", kind: "folder" }),
    entry({ path: "2-areas/apples.md", name: "apples.md" }),
    entry({ path: "2-areas/zebra.md", name: "zebra.md" }),
  ],
  truncated: false,
  manifestUsable: true,
};

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  resetListingOrder();
});

function drawnOrder(): string[] {
  return Array.from(document.querySelectorAll("[data-testid='folder-row']")).map(
    (node) => (node.getAttribute("aria-label") ?? "").replace(/, folder$/, ""),
  );
}

function mountListing() {
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
      } as never),
    );
  });
}

/* -------------------------------------------------------------------------- */

describe("the folder page honours the sort the tree's header sets", () => {
  test("A to Z by default", () => {
    mountListing();
    expect(drawnOrder()).toEqual(["admin", "health", "apples", "zebra"]);
  });

  test("Z to A once the control is pressed, without remounting the page", () => {
    mountListing();
    act(() => {
      setListingOrder(true);
    });
    expect(drawnOrder()).toEqual(["health", "admin", "zebra", "apples"]);
  });

  test("a page mounted while it is already Z to A comes up that way", () => {
    // The press happens in the sidebar, and the folder page may be opened
    // afterwards. A store read only on mount would pass the test above and
    // fail this one.
    setListingOrder(true);
    mountListing();
    expect(drawnOrder()).toEqual(["health", "admin", "zebra", "apples"]);
  });

  test("folders stay ahead of notes in both directions", () => {
    // The reversal is `orderedEntries`', which reverses each group rather than
    // the list — a plain `.reverse()` would put the notes first.
    mountListing();
    act(() => {
      setListingOrder(true);
    });
    const drawn = drawnOrder();
    expect(drawn.slice(0, 2).sort()).toEqual(["admin", "health"]);
    expect(drawn.slice(2).sort()).toEqual(["apples", "zebra"]);
  });

  test("it is the same function the tree is built from, not a second opinion", () => {
    setListingOrder(true);
    mountListing();
    const shared = listedEntries(LISTING.entries, { descending: true }).map((one) =>
      one.name.replace(/\.md$/, ""),
    );
    expect(drawnOrder()).toEqual(shared);
  });
});
