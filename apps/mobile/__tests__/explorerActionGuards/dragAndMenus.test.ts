/**
 * @jest-environment jsdom
 */

/**
 * `Explorer`'s edit-gated gestures, the row menu's overlays surviving a
 * context switch, what may be dragged and dropped on, and the storage
 * migration control's absence from this toolbar.
 *
 * Split out of `explorerActionGuards.test.ts`; see `fixtures.ts` in this
 * folder for the guard table and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import {
  drag,
  dragEvent,
  mount,
  mountSwitchable,
  openRowMenu,
  pressMenuItem,
  rowNode,
  shareDialogFor,
  type Calls,
} from "./fixtures";

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

  test("the create button is absent without canEdit and present with it", () => {
    // One `+` now, whose menu holds note, folder and drawing — so the button
    // is the whole of what `canEdit` has to withhold.
    const create = (container: HTMLElement) =>
      container.querySelector('[data-testid="explorer-new"]');

    const editor = mount(true);
    expect(create(editor.container)).not.toBeNull();

    const reader = mount(false);
    expect(create(reader.container)).toBeNull();
  });

  test("Move to trash acts immediately without opening a confirmation dialog", () => {
    const editor = mount(true);
    openRowMenu(editor.container, "note.md");
    pressMenuItem("Move to trash");

    expect(editor.calls.entries).toContainEqual({ name: "destroy", args: ["note.md"] });
    expect(document.body.textContent).not.toContain("Type note.md to confirm");
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
    //
    // The tree only draws privacy.md while it is the open note (it is unlisted
    // otherwise; see `isPrivacyManifest`), so this opens it: that is the one
    // state in which the row exists to be dragged.
    const editor = mount(true, { selectedPath: "privacy.md" });
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
 * The storage-layout update is **not** one of this toolbar's controls.
 *
 * It was, and the owner flagged it: a gear beside New note, New folder, Sort
 * A-Z and Collapse every folder, for an operation that reorganizes Context's
 * own hidden objects under `.context/` once, ever, and changes not one note.
 * Permanent top-level chrome for one-time internal maintenance.
 *
 * Its guard did not go with it. `storageMigrationEntry.test.ts` holds the two
 * surfaces that do offer it — Settings → Storage, and a dismissible notice in
 * the console — in both states of the same owner-only `updateStorageLayout`.
 * What is left here is the half that belongs to this component: an owner with
 * the capability is offered it *nowhere in this toolbar*, so it cannot creep
 * back by being handed an icon again.
 */
describe("the storage migration control is not toolbar chrome", () => {
  test("an owner who may run it is offered no toolbar button for it", () => {
    const explorer = mountSwitchable();
    explorer.render("@owner", explorer.calls, {
      updateStorageLayout: () =>
        explorer.calls.entries.push({ name: "updateStorageLayout", args: [] }),
    });

    expect(
      explorer.container.querySelector('[data-testid="explorer-storage-migration"]'),
    ).toBeNull();
    // The positive control, in the same assertion: this *is* an owner's
    // toolbar, drawn, with the three controls that belong in it. Without this
    // the test above passes on an explorer that rendered nothing at all.
    for (const control of ["filter-toggle", "new", "view"]) {
      expect(
        explorer.container.querySelector(`[data-testid="explorer-${control}"]`),
      ).not.toBeNull();
    }
    expect(explorer.calls.entries).toEqual([]);
  });
});
