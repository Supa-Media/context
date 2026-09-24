/**
 * @jest-environment jsdom
 */

/**
 * A drop is performed only when `dnd.ts` permits it, and ⌘/ctrl-click and
 * shift-click pick several rows that are then acted on as one batch.
 *
 * Split out of `explorerActionGuards.test.ts`; see `fixtures.ts` in this
 * folder for the guard table and the mounting harness these tests share.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { displayName } from "../../features/console/files/paths";
import { drag, dragEvent, mount, openRowMenu, pressMenuItem, rowNode } from "./fixtures";

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

/**
 * ⌘/ctrl-click and shift-click, through the mounted tree.
 *
 * `selection.ts` has the rules and `treeInteractions.test.ts` has the click
 * reaching them; what only a mounted `Explorer` can show is that the pick then
 * reaches the menu and the drag as **one** batch call — and that a gesture on
 * a row outside the pick acts on that row alone, never on the rows still
 * drawn picked beside it.
 */
describe("a pick is acted on as one batch", () => {
  /** Where a real click lands: the drawn name, inside the pressable. */
  function clickRow(container: HTMLElement, name: string, init: MouseEventInit = {}): void {
    const label = [...rowNode(container, name).querySelectorAll("*")].find(
      (node) => node.textContent === displayName(name) && node.children.length === 0,
    );
    if (label === undefined) throw new Error(`no label for ${name}`);
    act(() => {
      label.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
      );
    });
  }

  function pickTwo(container: HTMLElement): void {
    // jsdom is not a Mac, so ctrl is the toggle key.
    clickRow(container, "note.md", { ctrlKey: true });
    clickRow(container, "other.md", { ctrlKey: true });
  }

  test("right-clicking a picked row offers the plural menu, and trash takes all of them", () => {
    const editor = mount(true);
    pickTwo(editor.container);
    openRowMenu(editor.container, "note.md");
    pressMenuItem("Move 2 items to trash");

    expect(editor.calls.entries).toEqual([
      { name: "destroyMany", args: [["note.md", "other.md"]] },
    ]);
  });

  test("shift-click picks the range between", () => {
    const editor = mount(true);
    clickRow(editor.container, "2-areas", { ctrlKey: true });
    clickRow(editor.container, "other.md", { shiftKey: true });
    openRowMenu(editor.container, "note.md");
    pressMenuItem("Move 3 items to trash");

    expect(editor.calls.entries).toEqual([
      { name: "destroyMany", args: [["2-areas", "note.md", "other.md"]] },
    ]);
  });

  test("dragging a picked row carries the whole pick, as one move", () => {
    const editor = mount(true);
    pickTwo(editor.container);
    drag(rowNode(editor.container, "other.md"), rowNode(editor.container, "1-projects"));

    expect(editor.calls.entries).toEqual([
      { name: "moveMany", args: [["note.md", "other.md"], "1-projects"] },
    ]);
  });

  test("a right-click outside the pick is that row's menu, and ends the pick", () => {
    const editor = mount(true);
    clickRow(editor.container, "2-areas", { ctrlKey: true });
    clickRow(editor.container, "other.md", { ctrlKey: true });
    openRowMenu(editor.container, "note.md");
    pressMenuItem("Move to trash");

    expect(editor.calls.entries).toEqual([{ name: "destroy", args: ["note.md"] }]);

    // And the pick is gone: a row that was in it now gets its own menu.
    openRowMenu(editor.container, "other.md");
    expect(document.body.textContent).not.toContain("Move 2 items to trash");
  });

  test("a drag of a row outside the pick moves that row alone", () => {
    const editor = mount(true);
    clickRow(editor.container, "2-areas", { ctrlKey: true });
    clickRow(editor.container, "other.md", { ctrlKey: true });
    drag(rowNode(editor.container, "note.md"), rowNode(editor.container, "1-projects"));

    expect(editor.calls.entries).toEqual([{ name: "move", args: ["note.md", "1-projects"] }]);
  });

  test("a plain click puts the pick down", () => {
    const editor = mount(true);
    pickTwo(editor.container);
    clickRow(editor.container, "note.md");
    openRowMenu(editor.container, "note.md");

    expect(document.body.textContent).not.toContain("Move 2 items to trash");
    expect(document.body.textContent).toContain("Move to trash");
  });

  test("Escape puts the pick down", () => {
    const editor = mount(true);
    pickTwo(editor.container);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    openRowMenu(editor.container, "note.md");

    expect(document.body.textContent).not.toContain("Move 2 items to trash");
  });

  test("moving a pick asks where, once, for all of them", () => {
    const editor = mount(true);
    pickTwo(editor.container);
    openRowMenu(editor.container, "note.md");
    pressMenuItem("Move 2 items to…");

    expect(document.body.textContent).toContain("Move 2 items");
    expect(editor.calls.entries).toEqual([]);
  });

  test("a read-only console picks nothing it could write", () => {
    const reader = mount(false);
    pickTwo(reader.container);
    openRowMenu(reader.container, "note.md");

    expect(document.body.textContent).not.toContain("to trash");
    expect(reader.calls.entries).toEqual([]);
  });
});
