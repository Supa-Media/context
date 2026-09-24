/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { layout, type Mounted, mountFrame, pointerOn, styleOf } from "./fixtures";

describe("dragging the explorer's edge", () => {
  /** The width react-native-web actually wrote onto the explorer column. */
  function columnWidth(app: Mounted): number {
    const column = app.find("explorer")?.parentElement;
    if (column == null) throw new Error("no explorer column");
    return Number.parseFloat(column.style.width);
  }

  /** One press, a run of moves, one release. Returns the width after each move. */
  function drag(app: Mounted, from: number, through: number[]): number[] {
    const handle = app.find("explorer-resizer");
    if (handle === null) throw new Error("no resize handle");
    const pointer = pointerOn(handle);
    const widths: number[] = [];

    pointer.down(from);
    for (const x of through) {
      pointer.move(x);
      widths.push(columnWidth(app));
    }
    pointer.up(through.length === 0 ? from : through[through.length - 1]!);
    return widths;
  }

  test("the column follows the whole gesture, not its last frame", () => {
    const app = mountFrame(1440);
    expect(columnWidth(app)).toBe(layout.explorerWidth);

    // Press at 100, then move to 150, 200, 250 — +50, +100, +150 from where the
    // pointer went down. Sampling after every move is the point: the failure
    // this guards is *stuttering*, and a test that only read the end could be
    // satisfied by a drag that crawled there.
    //
    // Rebuilding the responder on each move — which is what listing `width` in
    // its `useMemo` deps does — gives 310, 310, 360 instead: react-native-web
    // allocates a fresh `gestureState` with `dx: 0` per instance while
    // `startWidth` still holds the grant-time width, so all but the last
    // increment is thrown away and the drag ends about a third short.
    expect(drag(app, 100, [150, 200, 250])).toEqual([310, 360, 410]);

    // The same claim in one line: where the pointer put it is where it is.
    expect(columnWidth(app)).toBe(layout.explorerWidth + 150);

    app.unmount();
  });

  test("the next drag starts from where the last one finished", () => {
    // The gesture's starting width is read through a ref at grant time. A ref
    // initialised once and never refreshed would send every later drag back to
    // the resting width — the other half of the same bug, and the reason the
    // ref is kept current by a commit rather than only by `useRef`'s initial
    // value.
    const app = mountFrame(1440);

    drag(app, 100, [250]);
    expect(columnWidth(app)).toBe(layout.explorerWidth + 150);

    drag(app, 400, [340]);
    expect(columnWidth(app)).toBe(layout.explorerWidth + 150 - 60);

    app.unmount();
  });

  test("the clamp still holds at both ends of a long drag", () => {
    const app = mountFrame(1440);

    drag(app, 100, [1400]);
    expect(columnWidth(app)).toBe(layout.explorerMaxWidth);

    /*
      **The floor still refuses to render anything narrower, and that is the
      half of this test that must not change.** What changed is only what a
      release past it means: the second half used to drag 900px left and assert
      the column sat at the floor afterwards, which now folds it away instead —
      so the claim is made *during* the gesture, where it is actually about the
      clamp, and the release is a separate test below.
    */
    const widths = drag(app, 400, [380, 360, 340, 300]).slice(0, -1);
    expect(widths.every((width) => width >= layout.explorerMinWidth)).toBe(true);

    app.unmount();
  });

  test("dragging past the floor and releasing folds the column away", () => {
    // The clamp's own comment gave the reason it refused rather than closing:
    // dragging to zero is how somebody hides a region and then wonders where it
    // went. That reason is answered by the seam left standing, not by the
    // refusal — so the drag can mean something past the floor now.
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    pointer.down(400);
    pointer.move(400 - (layout.explorerWidth - layout.explorerMinWidth) - 60);
    // Armed, and saying so, before anything has been decided.
    expect(app.find("explorer-seam-arming")).not.toBeNull();
    expect(app.find("explorer")).not.toBeNull();

    pointer.up(400 - (layout.explorerWidth - layout.explorerMinWidth) - 60);

    expect(app.find("explorer")).toBeNull();
    expect(app.find("explorer-seam-closed")).not.toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("a drag that stops short of the overshoot snaps back instead", () => {
    // The gap between the floor and the close is what stops a pull that
    // overshoots by a few pixels from folding the tree by accident.
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    const justInside =
      400 - (layout.explorerWidth - layout.explorerMinWidth) - layout.explorerCloseOvershoot + 4;
    pointer.down(400);
    pointer.move(justInside);
    expect(app.find("explorer-seam-arming")).toBeNull();
    pointer.up(justInside);

    expect(app.find("explorer")).not.toBeNull();
    expect(columnWidth(app)).toBe(layout.explorerMinWidth);

    app.unmount();
  });

  test("the width somebody dragged to survives the fold", () => {
    // `explorerHidden` and `explorerWidth` are two fields precisely so that
    // re-opening does not have to invent a width.
    const app = mountFrame(1440);

    drag(app, 100, [180]);
    expect(columnWidth(app)).toBe(layout.explorerWidth + 80);

    app.press("status-toggle-explorer");
    expect(app.find("explorer")).toBeNull();
    app.press("explorer-seam-closed");

    expect(columnWidth(app)).toBe(layout.explorerWidth + 80);

    app.unmount();
  });

  test("the handle highlights for the length of the gesture and no longer", () => {
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);
    const idle = styleOf(handle, "background-color");

    pointer.down(100);
    const held = styleOf(handle, "background-color");
    pointer.move(150);
    expect(styleOf(handle, "background-color")).toBe(held);
    pointer.up(150);

    expect(idle).toBe("rgba(0, 0, 0, 0)");
    expect(held).not.toBe(idle);
    expect(styleOf(handle, "background-color")).toBe(idle);

    app.unmount();
  });

  test("the handle lies over the border, after the editor that used to cover it", () => {
    /*
      **Where this node sits in the row is the whole of whether it can be
      pressed.** The strip straddles the column's border, because a target you
      can grab is wider than a hairline and people aim at the edge rather than a
      few points inside it — so half of it lies over the editor. Drawn as the
      column's last child, that half was drawn there and pressed nowhere: later
      siblings are on top and the editor is a later sibling, so it took every
      press that landed on the outer half.

      Measured in Chromium before the move: `elementFromPoint` at the middle of
      a 7pt handle answered the editor's region, not the handle.
    */
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const column = app.find("explorer")!.parentElement!;

    expect(column.contains(handle)).toBe(false);

    const row = Array.from(handle.parentElement!.children);
    const editor = row.findIndex((node) => node.textContent?.includes("the note"));
    expect(editor).toBeGreaterThanOrEqual(0);
    expect(row.indexOf(handle)).toBeGreaterThan(editor);

    // And it is laid over the border rather than beside it: three of its seven
    // points over the editor, the rest over the tree.
    expect(handle.style.left).toBe(
      `${layout.explorerWidth - layout.explorerSeamOverhang}px`,
    );

    app.unmount();
  });

  test("the handle follows the edge it is dragging", () => {
    // It is positioned from the column's width now rather than pinned to its
    // side, so the arithmetic has to hold for the length of a drag — a handle
    // left at the resting offset would walk away from the border it draws.
    const app = mountFrame(1440);

    drag(app, 100, [180]);

    expect(app.find("explorer-resizer")!.style.left).toBe(
      `${layout.explorerWidth + 80 - layout.explorerSeamOverhang}px`,
    );

    app.unmount();
  });

  /**
   * The browser deciding that a pointer dragged across text is a selection.
   *
   * Faithful to what a real drag does rather than convenient: the anchor is a
   * *text node*, because `isSelectionValid` — which is what react-native-web
   * asks before it terminates a gesture — ignores a selection whose ends are
   * both elements, and a test that selected the node's contents would arm
   * nothing and pass against the bug.
   */
  function selectTextIn(node: HTMLElement) {
    const text = node.firstChild;
    if (text == null || text.nodeType !== Node.TEXT_NODE) throw new Error("no text to select");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent?.length ?? 0);
    const selection = window.getSelection();
    if (selection == null) throw new Error("no selection");
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    });
  }

  test("a selection under the pointer does not end the drag", () => {
    /*
      **The bug this covers is the whole reason the drag felt one-directional.**
      A pointer moving with the button down is a text selection as far as the
      browser is concerned, and react-native-web's responder system terminates
      the current gesture the moment one becomes valid — `selectionchange` with
      a non-empty string over a text node is `onResponderTerminate`, and the
      default `onResponderTerminationRequest` says yes to it.

      Dragging the seam *left* crosses the tree's note names, so it hit that on
      the first row the pointer got ahead of; dragging *right* crosses
      CodeMirror's editing host, where a selection started outside it does not
      extend, so that direction never did. What was left was a handle that only
      worked while it was moved slowly enough to stay inside its own 7pt strip,
      where there is no text to select.
    */
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    pointer.down(400);
    pointer.move(370);
    expect(columnWidth(app)).toBe(layout.explorerWidth - 30);

    selectTextIn(app.find("explorer")!);

    // The gesture is still the gesture: the next move is measured from where
    // the pointer went down, not from a fresh grant that never happened.
    pointer.move(340);
    expect(columnWidth(app)).toBe(layout.explorerWidth - 60);

    pointer.up(340);
    expect(columnWidth(app)).toBe(layout.explorerWidth - 60);

    app.unmount();
  });

  test("the drag holds the document still while it runs, and hands it back", () => {
    /*
      Refusing to hand the gesture over keeps the drag alive; this is what keeps
      the *page* from painting a selection across the tree underneath it, and
      keeps the resize cursor on the pointer once it is past the handle. Both
      are released on the way out — a page left unselectable after a drag is a
      worse bug than the one this fixes.
    */
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    expect(document.body.style.getPropertyValue("user-select")).toBe("");

    pointer.down(400);
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");
    expect(document.body.style.getPropertyValue("cursor")).toBe("col-resize");

    pointer.move(340);
    pointer.up(340);

    expect(document.body.style.getPropertyValue("user-select")).toBe("");
    expect(document.body.style.getPropertyValue("cursor")).toBe("");

    app.unmount();
  });

  test("a gesture the browser cancels hands the document back too", () => {
    // A native drag starting under the pointer takes the gesture away for real
    // — `dragstart` is a cancel, not a request — and the one thing that must
    // not survive it is an unselectable page.
    const app = mountFrame(1440);
    const handle = app.find("explorer-resizer")!;
    const pointer = pointerOn(handle);

    pointer.down(400);
    pointer.move(340);
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");

    act(() => {
      document.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });

    expect(document.body.style.getPropertyValue("user-select")).toBe("");
    // A cancel is not a release: the column stays where the drag left it and
    // nothing folds.
    expect(columnWidth(app)).toBe(layout.explorerWidth - 60);
    expect(app.find("explorer")).not.toBeNull();

    app.unmount();
  });

  test("unmounting mid-drag hands the document back", () => {
    // ⌘⇧E during a drag, or a rotation out of this density: the handle goes
    // away with the column and there is no release to tidy up after it.
    const app = mountFrame(1440);
    const pointer = pointerOn(app.find("explorer-resizer")!);

    pointer.down(400);
    expect(document.body.style.getPropertyValue("user-select")).toBe("none");

    app.unmount();

    expect(document.body.style.getPropertyValue("user-select")).toBe("");
    expect(document.body.style.getPropertyValue("cursor")).toBe("");
  });
});
