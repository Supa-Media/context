/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { Explorer, ExplorerDialogs } from "../features/console/files/Explorer";
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
 * ## Which refusals, and why these seven
 *
 * The counting rule, stated because a bare number is unfalsifiable: a refusal
 * is **in scope here when it decides whether the console asks the server** —
 * whether a `FileBrowser` mutating method is called, or whether a control that
 * leads to one is offered. That excludes `Explorer`'s render-mode and
 * set-state guards (`query.trim() === ""` at :102, `onDragLeave`'s
 * `current === path` at :270, `ExplorerDialogs`' `dialog === null` at :479),
 * the `onOpenPinned` fallback at :181 (both arms act), and `inheritedOf`'s
 * fail-closed `"private"` at :646 (a default, not a refusal).
 *
 * Twelve conditions are in scope. Eleven of them were sabotaged one at a time
 * against the mobile suite as it stood before this file — 1,590 checks — and
 * **every one went undetected**, so row 117's 0-for-N reading was right. (The
 * twelfth is `canDrag`'s `loading`/`empty` arms, not sabotaged: a condition
 * argued to be unreachable produces no detection either way, so the run would
 * prove nothing. An earlier version of this paragraph said "each", which
 * claimed a measurement that was not taken.) But undetected is not the same as
 * exposed, and separating the two is half the work here.
 *
 * `MovePicker`'s filter arrived a round late, and is worth naming as a miss
 * rather than folding in: the first version of this table stopped at
 * `Explorer`'s own body and did not follow `ExplorerDialogs`, even though the
 * exclusion list below already reaches into it. It is the drag path's
 * self-into-self refusal wearing a different UI — `loadedFolders` does no
 * filtering of its own, so this line is the only thing keeping a folder off its
 * own destination list — and nothing had ever put it in a state where
 * `MovePicker` renders. (`Explorer` mounts `ExplorerDialogs` unconditionally,
 * so plenty of things mount it; what nothing did was hand it a non-null
 * `dialog`. An earlier version of this paragraph said nothing mounted it at
 * all, which was read off "no test imports it" without opening the parent that
 * renders it — the third time in this file's history that a claim was asserted
 * from one fact and contradicted by the file next door.)
 *
 * | Line | Condition | |
 * | --- | --- | --- |
 * | :261 | `dragHandlers`' `!files.canEdit` | covered below |
 * | :263 | `canDrag`'s `!row.readOnly` | covered below |
 * | :264 | `canDrop`'s `row.kind === "folder"` | covered below |
 * | :279 | `onDrop`'s `source === null` | covered below |
 * | :282 | `onDrop`'s `!verdict.ok` | covered below |
 * | :327 | the toolbar's `files.canEdit` | covered below |
 * | :526 | `MovePicker`'s destination filter | covered below |
 * | :148 | `openMenu`'s `items.length === 0` | cannot fire |
 * | :222 | `runAction`'s `restore` null target | cannot fire |
 * | :247 | `runAction`'s `case "visibility"` | cannot fire |
 * | :263 | `canDrag`'s `row.kind !== "loading" \|\| "empty"` | cannot fire |
 * | :631 | `cycleVisibility`'s `row.readOnly` | cannot fire |
 *
 * ## The five that cannot fire
 *
 *  - **`openMenu`'s `items.length === 0`** — because `Explorer.openMenu` only
 *    ever builds `{ kind: "row", row }`, and `entryItems` returns at least
 *    `Open` or `Copy path` for a single file or folder row under every
 *    combination of capabilities. Note what this guard actually is: `menu.ts`
 *    documents the empty list as the **background** menu's contract — right-
 *    click on empty space with no `canEdit` and there is nothing to offer — so
 *    it stops being dead the day a background menu is wired up, and it is a
 *    live guard then rather than a spare. (`targetRows` returning `null` for a
 *    `loading` row is a third way to reach `[]`, and `FileTree` renders those
 *    as a bare `View` with no `useRowInteractions`, so no such row can open a
 *    menu either. An earlier version of this comment gave only that reason and
 *    gave it as the only one, which was wrong twice over.)
 *  - **`runAction`'s `restore` null target** — `menu.ts` calls the same pure
 *    `restoreTargetFor` to decide whether to offer the item at all.
 *  - **`runAction`'s `case "visibility"`** — every menu presentation checks
 *    `item.items !== undefined` and opens the submenu instead of dispatching.
 *    There are **three**, not two: `Menu.web.tsx`'s `Sheet` and `Popover`, and
 *    the native `Menu.tsx` sheet that ships on iOS and Android. `Popover`
 *    checks in two places — its root `Panel`'s `onActivate` and the keyboard
 *    `Enter` path — while its *submenu* `Panel` calls `close(item.id)` with no
 *    check, which is safe only because `menu.ts` states items are one level
 *    deep. All three are exercised: `menuRender.test.ts` requires `Menu.tsx`
 *    **by its explicit extension**, precisely because `jest.config.js` resolves
 *    `web.tsx` first, and its "opening Visibility dispatches nothing and closes
 *    nothing" presses that row and asserts nothing was selected. (An earlier
 *    version of this bullet said no test in the suite ever loads `Menu.tsx`,
 *    and reached for CLAUDE.md's "a guard nobody has checked is not a guard" to
 *    say so. That was asserted from the resolution rule without opening the
 *    file that works around it — the same shape as the miscount it was written
 *    to correct.)
 *  - **`cycleVisibility`'s `row.readOnly`** — `VisibilityControl` returns the
 *    "generated" lock *before* the pressable for a read-only row, so there is
 *    no press to make.
 *  - **`canDrag`'s `loading`/`empty` arms** — the same `FileTree` fact as the
 *    first bullet: those rows carry no interactions at all, so `canDrag` is
 *    never asked about one. Only the `readOnly` arm of that expression is
 *    reachable, and only that arm is covered below.
 *
 * Those five are defence in depth, and a test for them would have to sabotage
 * the outer layer to reach them — which is a test of the sabotage, not of the
 * product. They are left uncovered deliberately, and this is the record of why,
 * so the gap does not read as an unfinished job.
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
 *
 * Each of the seven was sabotaged again *after* these tests existed. Five fail
 * silently when removed. The other two fail loudly, and that is worth stating
 * rather than implying otherwise: `source === null` and the verdict's `return`
 * both stand in front of code that would immediately dereference something
 * absent (`source.paths`, `verdict.moves`), so removing either throws out of
 * the `drop` listener. Those two tests therefore catch a crash, not a write.
 * The *silent* version of the verdict defect — `Explorer` not consulting
 * `dnd.ts` at all — is a separate shape, and the permitted and refused pair
 * below was sabotaged against it too: with the verdict replaced by an
 * unconditional `{ ok: true }`, the refused drop calls `move` and the test
 * fails.
 *
 * **A deletion is not the only sabotage.** The first version of the `canDrop`
 * test dropped onto `privacy.md`, the fixture's only file row — and `privacy.md`
 * is read-only, so the refusal it observed was equally consistent with a
 * `!row.readOnly` rule. Turning the guard off (`canDrop: () => true`) failed
 * that version; *replacing* it (`canDrop: (row) => !row.readOnly`) passed it,
 * while making an ordinary note a drop target and calling `move` with a note as
 * the destination. `other.md` exists in the fixture for that reason and for no
 * other, and the same replacement now fails 1 of 1,599, where before it was 0.
 * A rule quietly becoming a *different* rule is the mutation that survives an
 * on/off sabotage.
 *
 * `MovePicker`'s filter is two rules in one expression and was mutated the same
 * way: `() => true` fails, and so does `(folder) => dialog.path !== folder`,
 * which keeps the self rule and drops the descendant one. `1-projects/sub` is
 * in the fixture so the second of those has somewhere to show up.
 */

/**
 * The menu and the move dialog both render through components that read
 * safe-area insets — the real app provides them in `app/_layout.tsx`. Without
 * this the overlay mounts and then throws, which reads exactly like it never
 * opened.
 */
const METRICS =
  initialWindowMetrics ??
  ({
    frame: { x: 0, y: 0, width: 1280, height: 800 },
    insets: { top: 0, left: 0, right: 0, bottom: 0 },
  } as never);

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * A root holding two folders, two notes, and `privacy.md`.
 *
 * `1-projects` holds one subfolder and no files. `canDrop` reads the
 * destination's names to detect collisions, so `note.md` moving into it
 * collides with nothing, which is what makes the permitted drop below
 * permitted — and `loadedFolders` sees `1-projects/sub`, which is what gives
 * `MovePicker`'s descendant rule something to exclude.
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
      // A second destination, so `MovePicker`'s "Move here" is reachable at
      // all: it is disabled on the folder the thing already lives in, and for
      // anything at the top level that folder is the root.
      kind: "folder",
      path: "2-areas",
      name: "2-areas",
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
      // Ordinary and writable, and the only row in this fixture that is: it is
      // what separates `canDrop`'s folder rule from the read-only rule. See the
      // header's last paragraph.
      kind: "file",
      path: "other.md",
      name: "other.md",
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

/** One subfolder, so a descendant exists for `MovePicker` to exclude. */
const PROJECTS_LISTING: FolderListing = {
  path: "1-projects",
  folderDefault: "private",
  entries: [
    {
      kind: "folder",
      path: "1-projects/sub",
      name: "sub",
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

interface Calls {
  /** Every mutating call the component made against the browser, in order. */
  entries: { name: string; args: unknown[] }[];
  /**
   * Every call it made against its own props. Kept apart from `entries`
   * because these are not requests to the server and one of them fires on
   * mount: `onOverlayChange(false)` runs from an effect before any gesture, so
   * folding it in would make every `toEqual([])` below read past it.
   */
  props: { name: string; args: unknown[] }[];
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
    listings: { "": ROOT_LISTING, "1-projects": PROJECTS_LISTING },
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
    // Recorded, not no-ops: `expect(contextB.entries).toEqual([])` below is
    // about a call reaching the new context, and a `() => {}` here makes that
    // assertion unable to observe the very call it names.
    share: record("share"),
    revokeShare: record("revokeShare"),
    setSharePreviewTitle: record("setSharePreviewTitle"),
    // `#137`'s addition. Recorded like its neighbours rather than left a
    // no-op, and it has to keep returning a promise to satisfy the contract.
    teamShareLink: async (...args: unknown[]) => {
      calls.entries.push({ name: "teamShareLink", args });
      return null;
    },
  };
}

/**
 * `onOpenPinned` and `onOverlayChange` are passed because the product's only
 * mount site passes them (`app/(app)/console/_layout.tsx`), and a fixture that
 * mounts a shape nothing mounts is the drift `browser()` is typed to avoid, one
 * level out.
 *
 * They record into `calls.props`, and the drop tests assert on it. An earlier
 * version said only that recording meant a stray call "would show up rather
 * than vanish" — a detection claim about an array nothing read, which in this
 * file's own terms is an unasserted outcome proving nothing.
 */
function mount(canEdit: boolean): { container: HTMLElement; calls: Calls } {
  const calls: Calls = { entries: [], props: [] };
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
        { initialMetrics: METRICS },
        createElement(Explorer, {
          files: browser(canEdit, calls),
          contextLabel: "@somebody",
          onOpenPinned: (path: string) => calls.props.push({ name: "onOpenPinned", args: [path] }),
          onOverlayChange: (open: boolean) =>
            calls.props.push({ name: "onOverlayChange", args: [open] }),
        }),
      ),
    );
  });
  return { container, calls };
}

/**
 * The same mounted `<Explorer>`, re-rendered — which is the only way to reach
 * a context switch. `<Explorer>` lives in `app/(app)/console/_layout.tsx`,
 * above `<Slot/>`, so a fresh mount per assertion cannot see what survives one.
 */
function mountSwitchable(): {
  container: HTMLElement;
  calls: Calls;
  render: (contextLabel: string, calls?: Calls, over?: Partial<FileBrowser>) => void;
} {
  const first: Calls = { entries: [], props: [] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    calls: first,
    render: (contextLabel, calls = first, over = {}) =>
      act(() => {
        root.render(
          createElement(
            SafeAreaProvider,
            { initialMetrics: METRICS },
            createElement(Explorer, {
              files: { ...browser(true, calls), ...over },
              contextLabel,
            }),
          ),
        );
      }),
  };
}

/**
 * Right-click a row. `rowInteractions.web.ts` binds `contextmenu` through a ref
 * callback rather than a React prop, so there is no handler to find — the event
 * is dispatched at the node carrying the listener.
 */
function openRowMenu(container: HTMLElement, name: string): void {
  // Inside `act`, or the menu's state update is not flushed and the item this
  // returns to is not on screen yet.
  act(() => {
    rowNode(container, name).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
}

function pressMenuItem(label: string): void {
  const node = [...document.body.querySelectorAll("*")].find(
    (candidate) => candidate.textContent?.trim() === label && candidate.children.length === 0,
  );
  // jest's `expect` takes no message argument — that is vitest's signature, and
  // carrying it across is a mistake this suite has now made twice.
  if (node === undefined) throw new Error(`no menu item labelled ${label}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

const shareDialogFor = (name: string) =>
  document.body.querySelector(`[aria-label="Share ${name}"]`);

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
  test("no row is draggable without canEdit, and every writable row is with it", () => {
    // Positive control first: without it a tree that rendered no rows at all
    // would satisfy the assertion below. All four writable rows, not a sample —
    // `other.md` in particular, because it is the node the drop-target test
    // dispatches at, and that test would stay green if file rows stopped
    // carrying listeners at all.
    const editor = mount(true);
    for (const name of ["1-projects", "2-areas", "note.md", "other.md"]) {
      expect(rowNode(editor.container, name).getAttribute("draggable")).toBe("true");
    }

    // "every writable row", not "every row": `privacy.md` is read-only and
    // reads `"false"` even here, which the next block proves rather than
    // assumes.
    const reader = mount(false);
    for (const name of ["1-projects", "2-areas", "note.md", "other.md"]) {
      expect(rowNode(reader.container, name).getAttribute("draggable")).toBe("false");
    }
  });

  test("a drag begun without canEdit reaches the browser with nothing", () => {
    const reader = mount(false);
    drag(rowNode(reader.container, "note.md"), rowNode(reader.container, "1-projects"));
    expect(reader.calls.entries).toEqual([]);
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

/**
 * **The row menu's share dialog, which is the other one.**
 *
 * `#133` guarded `BrowsePane`'s dialog and left this one, and the record it
 * shipped said "the share dialog". There are two, and this is the one that
 * matters more on a phone: the row menu is the only way to reach Share for a
 * note you are *not* reading, which is the whole reason that control was moved
 * onto the note in the first place.
 *
 * It is also more persistent. `<Explorer>` is mounted in
 * `app/(app)/console/_layout.tsx` **above `<Slot/>`**, so it survives a context
 * switch more thoroughly than a pane does — and `dialog` was ordinary state
 * that nothing reset. Driven before the fix: the dialog stayed open titled
 * after the old context's note, and submitting called the new context's `share`
 * with the old context's path.
 */
describe("an overlay does not follow the reader into another context", () => {
  test("the row menu's share dialog closes when the context changes", () => {
    const explorer = mountSwitchable();
    explorer.render("@a");
    openRowMenu(explorer.container, "note.md");
    pressMenuItem("Share…");

    // The positive control: without it, a dialog that never opened would
    // satisfy the assertion below.
    expect(shareDialogFor("note.md")).not.toBeNull();

    const contextB: Calls = { entries: [], props: [] };
    explorer.render("@b", contextB);

    expect(shareDialogFor("note.md")).toBeNull();
    expect(contextB.entries).toEqual([]);
  });

  /**
   * **The row menu is worse than the dialog, and was held by nothing.**
   *
   * Removing `setMenu(null)` from the reset passed all 1,674 checks. It is not
   * cosmetic: `duplicate`, `copy`, `cut`, `paste`, `restore` and the three
   * visibility actions fire straight from `runAction` with **no dialog in
   * between** — a menu that survives the switch is one click from acting on the
   * old context's path in the new context.
   */
  test("the row menu does not survive the context change", () => {
    const explorer = mountSwitchable();
    explorer.render("@a");
    openRowMenu(explorer.container, "note.md");
    expect(document.body.textContent).toContain("Duplicate");

    const contextB: Calls = { entries: [], props: [] };
    explorer.render("@b", contextB);

    expect(document.body.textContent).not.toContain("Duplicate");
    expect(contextB.entries).toEqual([]);
  });

  /**
   * **And a pending drag is the destructive one.**
   *
   * A drop is a `move`, not a read grant. `onDragEnd` cannot rescue it either:
   * the source row is unmounted by the re-render into the new context, so its
   * listener is gone and `dragend` never arrives to clear `drag`.
   *
   * Nor does this need somebody to switch context mid-gesture —
   * `selectedContextId` falls back to the first workspace, so losing membership
   * under a mounted console re-renders the tree beneath a pending drag.
   */
  test("a pending drag does not drop into the next context", () => {
    const explorer = mountSwitchable();
    explorer.render("@a");
    act(() => {
      rowNode(explorer.container, "note.md").dispatchEvent(dragEvent("dragstart"));
    });

    const contextB: Calls = { entries: [], props: [] };
    explorer.render("@b", contextB);
    act(() => {
      rowNode(explorer.container, "1-projects").dispatchEvent(dragEvent("drop"));
    });

    expect(contextB.entries).toEqual([]);
  });

  /**
   * **The other direction, and the one that would be worse to get wrong.**
   *
   * A reset keyed on `files` rather than on `contextLabel` passes both checks
   * above — measured — because this fixture changes the two together. It would
   * also close the dialog on every listing refresh, every save, every tab
   * change: somebody halfway through typing a recipient loses it, silently, for
   * no reason they can see. A guard that closes a dialog somebody is using is
   * worse than the bug it fixes, so the distinction gets its own check.
   */
  test("but an ordinary re-render in the same context does not close it", () => {
    const explorer = mountSwitchable();
    explorer.render("@a");
    openRowMenu(explorer.container, "note.md");
    pressMenuItem("Share…");
    expect(shareDialogFor("note.md")).not.toBeNull();

    // A new `files` object, same context — `browser()` builds a fresh one per
    // render, which is what a listing refresh looks like from here.
    explorer.render("@a");
    expect(shareDialogFor("note.md")).not.toBeNull();
  });

  test("and closes when the capability that opened it goes away", () => {
    const explorer = mountSwitchable();
    explorer.render("@a");
    openRowMenu(explorer.container, "note.md");
    pressMenuItem("Share…");
    expect(shareDialogFor("note.md")).not.toBeNull();

    // Ownership can go away under a mounted console — the subject of
    // `explorerMenuStaleGate.test.ts`. `canShare` is `canEdit && isOwner`, so
    // it moves on its own.
    explorer.render("@a", explorer.calls, { canShare: false });
    expect(shareDialogFor("note.md")).toBeNull();
  });
});

describe("what may be dragged, and what may be dropped on", () => {
  test("privacy.md is not draggable even for an editor", () => {
    // Not a `canEdit` rule, which is why it is not in the block above: this
    // mounts an editor. `dnd.ts` refuses a read-only source as well, and that
    // refusal is tested there — this is the earlier gate, `canDrag` in
    // `Explorer`'s own handler, which stops the drag from starting at all.
    // The contrast is the first test in this file, where all four writable
    // rows read `"true"`.
    const editor = mount(true);
    expect(rowNode(editor.container, "privacy.md").getAttribute("draggable")).toBe("false");
  });

  test("an ordinary file row is not a drop target", () => {
    // `canDrop: (row) => row.kind === "folder"`. `other.md` is writable and not
    // read-only, so the only rule that can refuse this drop is the folder rule
    // — which is the whole reason it is `other.md` and not `privacy.md`.
    const editor = mount(true);
    drag(rowNode(editor.container, "note.md"), rowNode(editor.container, "other.md"));
    expect(editor.calls.entries).toEqual([]);
  });
});

/**
 * `ExplorerDialogs` mounted on its own.
 *
 * It is exported from the same module and takes no frame context, so it needs
 * no `AppFrame` — but `MovePicker` renders through `Shell`, which reaches for
 * safe-area insets on the web build, so it needs `METRICS` for the reason given
 * there.
 */
function mountMoveDialog(path: string): { container: HTMLElement; calls: Calls } {
  const calls: Calls = { entries: [], props: [] };
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
        { initialMetrics: METRICS },
        createElement(ExplorerDialogs, {
          files: browser(true, calls),
          dialog: { kind: "move", path },
          onClose: noop,
        }),
      ),
    );
  });
  return { container, calls };
}

/** `MovePicker`'s label for the root, which is not a path. */
const ROOT_LABEL = "the root of your context";

/**
 * Every folder path the fixture contains, derived rather than listed.
 *
 * `loadedFolders` can only ever return `""` plus the `kind: "folder"` entries of
 * the listings it is given, so this set is exactly the space the dialog's list
 * is drawn from — which makes the filter below complete by construction. The
 * first version matched `/^[0-9]-/` instead and would have silently dropped a
 * leaked `Journal/` or `Clients/`, the folder names `CLAUDE.md`'s
 * `resetPrivacyManifest` decision exists because real brains actually have.
 */
const EVERY_FOLDER = new Set(
  [ROOT_LISTING, PROJECTS_LISTING].flatMap((listing) =>
    listing.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.path),
  ),
);

/** Every destination the dialog is offering, in the order it offers them. */
function offeredFolders(): string[] {
  return [...document.body.querySelectorAll("[aria-label]")]
    .map((node) => node.getAttribute("aria-label") ?? "")
    .filter((label) => label === ROOT_LABEL || EVERY_FOLDER.has(label));
}

function press(label: string): void {
  const node = [...document.body.querySelectorAll("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  expect(node).toBeDefined();
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node!.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

describe("the move dialog does not offer a folder itself or its own descendants", () => {
  test("a folder is offered every destination but itself and below it", () => {
    // Positive control in the same assertion: `2-areas` and the root ARE
    // offered, so this cannot pass by rendering an empty list. `loadedFolders`
    // returns all four — "", 1-projects, 1-projects/sub, 2-areas — and does no
    // filtering of its own, so the two that are missing are missing because of
    // the filter under test.
    mountMoveDialog("1-projects");
    expect(offeredFolders()).toEqual([ROOT_LABEL, "2-areas"]);
  });

  test("choosing an offered destination moves; the dialog's list is the only gate", () => {
    // `MovePicker` calls `onConfirm` with whatever was chosen and asks nothing
    // else, and `files.move` does not re-check — so what the list contains is
    // what can be moved into. That is why the exclusion above is a guard rather
    // than a nicety.
    const dialog = mountMoveDialog("1-projects");
    press("2-areas");
    press("Move here");
    expect(dialog.calls.entries).toEqual([{ name: "move", args: ["1-projects", "2-areas"] }]);
  });
});

describe("a drop is performed only when dnd.ts permits it", () => {
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
    // The props too: the one entry is `onOverlayChange(false)` from the mount
    // effect, so nothing this gesture did reached a prop either.
    expect(editor.calls.props).toEqual([{ name: "onOverlayChange", args: [false] }]);
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
    // A refusal raises a message, not an overlay: `setRefusal` is not `setMenu`
    // or `setDialog`, so `overlayOpen` never changes and the mount effect's one
    // entry is still the only one.
    expect(refused.calls.props).toEqual([{ name: "onOverlayChange", args: [false] }]);
  });
});
