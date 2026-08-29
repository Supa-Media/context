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
 * **The `Explorer` guards that decide whether the console asks the server at
 * all.**
 *
 * Row 117 of the security register: every guard in this console expressed as a
 * pure module is held by a test, and every guard living inside a component or a
 * hook was held by nothing. `#102`, `#106` and `#112` took the ones that could
 * be moved out or driven through a mounted hook. `Explorer` is the last layer,
 * and it is the one that decides *when* to call `menu.ts`, `dnd.ts` and the
 * `FileBrowser` — decisions that only exist in the component.
 *
 * ## Ten refusals, six of them reachable
 *
 * `Explorer` refuses in ten places. Six were sabotaged one at a time against
 * the whole mobile suite before this file existed and **every one went
 * undetected**, so the 0-for-N reading was right. But undetected is not the
 * same as exposed, and separating the two is half the work here: four of the
 * ten cannot be reached at all, because an outer layer decides the same thing
 * first and is itself tested.
 *
 *  - `openMenu`'s `items.length === 0` cannot fire. `itemsFor` returns `[]`
 *    only when `targetRows` returns `null`, which happens only for a `loading`
 *    or `empty` row — and `FileTree` renders those as a bare `View` with no
 *    `useRowInteractions`, so they carry no `contextmenu` listener and
 *    `openMenu` is never reached with one. For a file or folder row
 *    `entryItems` returns at least `Open` or `Copy path` under every
 *    combination of capabilities.
 *  - `runAction`'s `case "visibility"` cannot fire. Both menu presentations
 *    check `item.items !== undefined` and open the submenu instead of
 *    dispatching — `Menu.web.tsx`'s `Sheet` says so in a comment, and its
 *    `Popover` does the same in `onActivate`.
 *  - `cycleVisibility`'s `row.readOnly` cannot fire. `VisibilityControl`
 *    returns the "generated" lock *before* the pressable for a read-only row,
 *    so there is no press to make.
 *  - `runAction`'s `restore` null target cannot fire. `menu.ts` calls the same
 *    `restoreTargetFor` to decide whether to offer the item at all.
 *
 * Those four are defence in depth, and a test for them would have to sabotage
 * the outer layer to reach them — which is a test of the sabotage, not of the
 * product. They are left uncovered deliberately, and this is the record of why,
 * so the next person does not read the gap as an unfinished job. The other six
 * are below: `dragHandlers`' `canEdit`, `canDrag`'s `readOnly`, `canDrop`'s
 * folder rule, `onDrop`'s `source === null`, `onDrop`'s verdict, and the
 * toolbar's `canEdit`. Each is singly held — nothing else in the app decides
 * it — and each was sabotaged again after this file existed, to prove the
 * tests catch what they claim.
 *
 * Four of the six fail silently when removed. The other two fail loudly, and
 * that is worth stating rather than implying otherwise: `source === null` and
 * the verdict's `return` both stand in front of code that would immediately
 * dereference something absent (`source.paths`, `verdict.moves`), so removing
 * either throws out of the `drop` listener. Those two tests therefore catch a
 * crash, not a write. The *silent* version of the verdict defect — `Explorer`
 * not consulting `dnd.ts` at all — is a separate shape, and the permitted and
 * refused pair below was sabotaged against it too: with the verdict replaced by
 * an unconditional `{ ok: true }`, the refused drop calls `move` and the test
 * fails.
 *
 * ## Every test asserts on whether an action was CALLED
 *
 * The anti-vacuity rule `fileBrowserGuards.test.ts` states: a guard that
 * refuses and a server that would have refused anyway produce the same visible
 * outcome, so a test that reads the outcome proves nothing about the guard.
 *
 * Every refusal here is paired with the same gesture under conditions the guard
 * does not refuse, which must reach the browser — but not always inside the
 * same `test`. The draggable contrast lives in the first test and is what the
 * two after it lean on; the permitted drop is what the three refused drops lean
 * on. Pairing them, rather than pairing them within one block, is what keeps a
 * tree that rendered no rows at all from passing.
 */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * A root holding one folder, one note, and `privacy.md`.
 *
 * `1-projects` is deliberately left out of `listings`, so it is a collapsed
 * folder whose contents nobody has fetched. `canDrop` reads the destination's
 * names to detect collisions and an unloaded destination yields an empty set —
 * documented in `dnd.ts` as the honest degradation — which is what makes the
 * permitted drop below permitted.
 */
const ROOT_LISTING: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "folder",
      path: "1-projects",
      name: "1-projects",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
    {
      kind: "file",
      path: "note.md",
      name: "note.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
    {
      kind: "file",
      path: "privacy.md",
      name: "privacy.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: true,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

const noop = () => {};

/** Every mutating call the component made, in order. */
interface Calls {
  entries: { name: string; args: unknown[] }[];
}

/**
 * Typed, not cast — `explorerMenuStaleGate.test.ts` records what a cast cost
 * the last fixture in this folder: it drifted away from `FileBrowser` silently
 * and the security regression test it backed would have passed for the wrong
 * reason.
 */
function browser(canEdit: boolean, calls: Calls): FileBrowser {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.entries.push({ name, args });
    };
  return {
    canEdit,
    loading: false,
    busy: false,
    listings: { "": ROOT_LISTING },
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
    copy: record("copy"),
    cut: record("cut"),
    paste: record("paste"),
    copyTo: record("copyTo"),
    createNote: record("createNote"),
    createFolder: record("createFolder"),
    rename: record("rename"),
    move: record("move"),
    duplicate: record("duplicate"),
    archive: record("archive"),
    destroy: record("destroy"),
    setVisibility: record("setVisibility"),
    resetPrivacy: noop,
    canResetPrivacy: false,
    // Both are `canEdit && isOwner` in the real hook, so an owner is the only
    // shape in which they can differ from `canEdit` — and moving them
    // independently is `explorerMenuStaleGate.test.ts`'s subject, not this
    // file's. Tying them to `canEdit` keeps a failure here from being read as
    // that bug.
    canSetVisibility: canEdit,
    canShare: canEdit,
    shares: undefined,
    share: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
  };
}

function mount(canEdit: boolean): { container: HTMLElement; calls: Calls } {
  const calls: Calls = { entries: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
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
        createElement(Explorer, { files: browser(canEdit, calls), contextLabel: "@somebody" }),
      ),
    );
  });
  return { container, calls };
}

/**
 * The element `useRowInteractions` attached to, found by the attribute it
 * writes.
 *
 * `draggable` is set on every row it holds — `"true"` or `"false"`, never
 * absent — so this locates the one node carrying the listeners rather than
 * dispatching at every node containing the name and relying on bubbling, which
 * would deliver a `drop` several times over.
 */
function rowNode(container: HTMLElement, name: string): HTMLElement {
  const nodes = [...container.querySelectorAll("[draggable]")].filter((node) =>
    node.textContent?.includes(name),
  );
  expect(nodes.length).toBe(1);
  return nodes[0] as HTMLElement;
}

/**
 * jsdom has no `DragEvent`, and the handlers read `event.dataTransfer`. A plain
 * `Event` leaves it `undefined`, which is not `null`, so the assignment inside
 * `if (event.dataTransfer !== null)` would throw. Defining it as `null` takes
 * the branch the handlers already guard for.
 */
function dragEvent(type: string): Event {
  // `bubbles: false` because `rowNode` finds the element the listeners are on
  // and dispatches straight at it, so nothing is lost — and because
  // react-native-web binds its own `dragstart` on `document`, where a bubbling
  // one reaches its responder system and warns about a touch that never
  // started. Noise in a security test is how a real message gets scrolled past.
  const event = new Event(type, { bubbles: false, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: null });
  return event;
}

/**
 * Two `act` calls, deliberately.
 *
 * `onDragStart` calls `setDrag`, and the `onDrop` closure reads that state:
 * `dragHandlers` is a `useMemo` over `[files, drag]`. Dispatched inside one
 * `act` the two events are batched, the component never re-renders between
 * them, and the drop reads the *previous* `drag` — `null` — so it returns at
 * the `source === null` guard and nothing is called. That is a real render
 * flush in the browser, not a testing detail: the first version of this helper
 * used one `act` and the permitted drop below silently moved nothing.
 */
function drag(from: HTMLElement, onto: HTMLElement): void {
  act(() => {
    from.dispatchEvent(dragEvent("dragstart"));
  });
  act(() => {
    onto.dispatchEvent(dragEvent("drop"));
  });
}

describe("a console that cannot edit cannot start the gestures that write", () => {
  test("no row is draggable without canEdit, and every row is with it", () => {
    // Positive control first: without it a tree that rendered no rows at all
    // would satisfy the assertion below.
    const editor = mount(true);
    expect(rowNode(editor.container, "note.md").getAttribute("draggable")).toBe("true");
    expect(rowNode(editor.container, "1-projects").getAttribute("draggable")).toBe("true");

    const reader = mount(false);
    expect(rowNode(reader.container, "note.md").getAttribute("draggable")).toBe("false");
    expect(rowNode(reader.container, "1-projects").getAttribute("draggable")).toBe("false");
  });

  test("a drag begun without canEdit reaches the browser with nothing", () => {
    const reader = mount(false);
    drag(rowNode(reader.container, "note.md"), rowNode(reader.container, "1-projects"));
    expect(reader.calls.entries).toEqual([]);
  });

  test("privacy.md is not draggable even for an editor", () => {
    // `dnd.ts` refuses a read-only source as well, and that refusal is tested
    // there. This is the earlier gate — `canDrag` in `Explorer`'s own handler —
    // which is what stops the drag from starting at all.
    const editor = mount(true);
    expect(rowNode(editor.container, "privacy.md").getAttribute("draggable")).toBe("false");
  });

  test("the create buttons are absent without canEdit and present with it", () => {
    const newNote = (container: HTMLElement) =>
      container.querySelector('[data-testid="explorer-new-note"]');
    const newFolder = (container: HTMLElement) =>
      container.querySelector('[data-testid="explorer-new-folder"]');

    const editor = mount(true);
    expect(newNote(editor.container)).not.toBeNull();
    expect(newFolder(editor.container)).not.toBeNull();

    const reader = mount(false);
    expect(newNote(reader.container)).toBeNull();
    expect(newFolder(reader.container)).toBeNull();
  });
});

describe("a drop is performed only when dnd.ts permits it", () => {
  test("a file row is not a drop target", () => {
    // `canDrop: (row) => row.kind === "folder"`. Dropping a note onto another
    // note is refused before `dnd.ts` is consulted at all, so this is
    // `Explorer`'s rule and nothing else's.
    const editor = mount(true);
    drag(rowNode(editor.container, "note.md"), rowNode(editor.container, "privacy.md"));
    expect(editor.calls.entries).toEqual([]);
  });

  test("a drop with nothing being dragged calls nothing", () => {
    // Reachable without a `dragstart`: a drag begun in another window, or one
    // this component did not start. `onDrop`'s `source === null` is the only
    // thing between that and `canDrop` dereferencing it — so what this catches
    // is the crash, per the header. Asserting no call is still the right
    // assertion: it is what the guard promises, and it is what would fail if
    // the guard were replaced by something that let an empty source through
    // without throwing.
    const editor = mount(true);
    act(() => {
      rowNode(editor.container, "1-projects").dispatchEvent(dragEvent("drop"));
    });
    expect(editor.calls.entries).toEqual([]);
  });

  test("a permitted drop moves, and a refused one calls nothing", () => {
    // Permitted: a note at the root into a folder it is not already in.
    const permitted = mount(true);
    drag(rowNode(permitted.container, "note.md"), rowNode(permitted.container, "1-projects"));
    expect(permitted.calls.entries).toEqual([{ name: "move", args: ["note.md", "1-projects"] }]);

    // Refused: `describeMoveProblem` answers "That is the folder you are
    // moving." A crash would satisfy "no move was called" just as well, so the
    // refusal is asserted positively too — the reason `dnd.ts` produced is on
    // screen, which is only true if the component reached the branch that
    // reads it, rendered, and did not throw on the way.
    const refused = mount(true);
    const folder = rowNode(refused.container, "1-projects");
    drag(folder, folder);
    expect(refused.calls.entries).toEqual([]);
    expect(refused.container.textContent).toContain("That is the folder you are moving.");
  });
});
