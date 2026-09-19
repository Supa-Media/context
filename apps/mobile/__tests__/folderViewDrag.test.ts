/**
 * @jest-environment jsdom
 */

/**
 * The listing gets the tree's own gestures, because it is the tree in the
 * other place.
 *
 * The complaint: a folder in the sidebar could be picked up and dropped
 * somewhere else, and the same folder drawn as a row in the middle of the
 * screen could not — and on a phone, where `frame.ts` draws no file tree at
 * all, there was no drag anywhere and **no menu on a row either**, because
 * `FolderView` went through `useRightClick`, whose native half is a no-op. So
 * rename, move, duplicate, visibility, archive and delete were unreachable on
 * the one surface a phone has.
 *
 * Both halves of that are wiring rather than rules, which is why the
 * assertions are literal about the DOM: `dnd.ts` and `menu.ts` own what is
 * allowed and have their own tests, and neither can see whether the gesture
 * ever arrives. `treeInteractions.test.ts` makes the same argument for the
 * tree and these are deliberately its assertions, applied to the other
 * surface — two surfaces that are supposed to behave identically should be
 * held to it by tests that read the same.
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
    // `privacy.md` is generated. It draws, and it is never a drag source.
    entry({ path: "2-areas/privacy.md", name: "privacy.md", readOnly: true }),
  ],
  truncated: false,
  manifestUsable: true,
};

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mountListing(drag?: FolderDrag) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });

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
        drag,
      } as never),
    );
  });

  /** The outer element of a row — the one the gestures are attached to. */
  const rowFor = (drawn: string): HTMLElement => {
    const label = Array.from(container.querySelectorAll("*")).find(
      (node) => node.textContent === drawn && node.children.length === 0,
    );
    if (label === undefined) throw new Error(`no row labelled ${drawn}`);
    let node: HTMLElement | null = label.parentElement;
    while (node !== null && node.getAttribute("draggable") === null) node = node.parentElement;
    if (node === null) throw new Error(`row ${drawn} has no gesture host`);
    return node;
  };

  return { container, rowFor };
}

function dragHandlers(over: Partial<FolderDrag> = {}): FolderDrag {
  return {
    canDrag: (one) => !one.readOnly,
    canDrop: (one) => one.kind === "folder",
    onDragStart: () => {},
    onDragOver: () => {},
    onDragLeave: () => {},
    onDrop: () => {},
    onDragEnd: () => {},
    target: null,
    ...over,
  };
}

/** A `DragEvent` jsdom will carry, with the `dataTransfer` the handlers read. */
function dragEvent(kind: string, init: MouseEventInit = {}): Event {
  const event = new MouseEvent(kind, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: () => {}, getData: () => "", effectAllowed: "", dropEffect: "" },
    configurable: true,
  });
  return event;
}

/* -------------------------------------------------------------------------- */

describe("picking a row up", () => {
  test("a row is draggable once the pane supplies handlers", () => {
    const { rowFor } = mountListing(dragHandlers());
    expect(rowFor("health").getAttribute("draggable")).toBe("true");
    expect(rowFor("journal").getAttribute("draggable")).toBe("true");
  });

  test("the generated manifest is not a drag source", () => {
    // `canDrag` is false for it, and the refusal has to be the attribute
    // rather than a rejection after the pick-up: there is no cursor on this
    // surface to say a drag is going nowhere.
    const { rowFor } = mountListing(dragHandlers());
    expect(rowFor("privacy").getAttribute("draggable")).toBe("false");
  });

  test("a read-only console offers no pick-up at all", () => {
    // No handlers is how `BrowsePane` spells "this console cannot edit".
    const { container } = mountListing(undefined);
    const draggable = Array.from(container.querySelectorAll("[draggable='true']"));
    expect(draggable).toEqual([]);
  });

  test("dragstart on a row names the row", () => {
    const started: string[] = [];
    const { rowFor } = mountListing(dragHandlers({ onDragStart: (path) => started.push(path) }));
    act(() => {
      rowFor("health").dispatchEvent(dragEvent("dragstart"));
    });
    expect(started).toEqual(["2-areas/health"]);
  });
});

describe("dropping on a row", () => {
  test("a folder row permits the drop, which is what preventDefault means here", () => {
    const { rowFor } = mountListing(dragHandlers());
    const over = dragEvent("dragover");
    act(() => {
      rowFor("health").dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
  });

  test("a note row does not, so the pointer says no-drop", () => {
    const { rowFor } = mountListing(dragHandlers());
    const over = dragEvent("dragover");
    act(() => {
      rowFor("journal").dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(false);
  });

  test("a drop reaches the handler with the folder it landed on", () => {
    const dropped: string[] = [];
    const { rowFor } = mountListing(dragHandlers({ onDrop: (path) => dropped.push(path) }));
    act(() => {
      rowFor("health").dispatchEvent(dragEvent("drop"));
    });
    expect(dropped).toEqual(["2-areas/health"]);
  });

  test("the row under the drag is washed, and only that row", () => {
    const { rowFor } = mountListing(dragHandlers({ target: "2-areas/health" }));
    // The wash is a style on the gesture host, which react-native-web spells
    // as a class. Asserted as "these two differ" rather than against a colour,
    // which is the theme's business and not this file's.
    expect(rowFor("health").className).not.toBe(rowFor("journal").className);
  });
});
