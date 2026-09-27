/**
 * @jest-environment jsdom
 */

/**
 * ON A PHONE A PEER'S CARET HAS NO NAME FLAG.
 *
 * The owner's phone artboards (2026-09-27, screen 1): "Cursor name tags are
 * hidden on phones." At 390pt the flags ("@maya", "jo Claude") lay over the
 * words being read and clipped at the right edge of the glass. The coloured
 * caret and the selection wash stay — they say *where* somebody is — and the
 * presence pile in the path row says *who*.
 *
 * Three layers, each held:
 *  - `buildCaretDecorations` with labels off draws the caret and no flag, for
 *    a person and for a tool (whose flag otherwise never fades);
 *  - the `setCaretLabels` effect reaches the drawn DOM of a real editor;
 *  - the mounted `LiveEditor` turns labels off at a compact width and leaves
 *    them on at a pointer width.
 *
 * SABOTAGE: `LiveEditor.web.tsx` dispatching `setCaretLabels.of(true)`
 * regardless of density fails the last test; `labelled` ignoring `labels` in
 * `buildCaretDecorations` fails the first two.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act } from "react";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  buildCaretDecorations,
  caretLabelsShown,
  remoteCarets,
  setCaretDocument,
  setCaretLabels,
  setRemoteCarets,
} from "../../features/console/presence/remoteCarets";
import { cursorPosition } from "../../features/console/presence/sync";
import { at, member, resolve } from "./fixtures";
import { mount, viewIn } from "../liveEditorMount/fixtures";

function widgetsOf(set: ReturnType<typeof buildCaretDecorations>): HTMLElement[] {
  const found: HTMLElement[] = [];
  const cursor = set.iter();
  while (cursor.value !== null) {
    const spec = cursor.value.spec as { widget?: { toDOM: () => HTMLElement } };
    if (spec.widget) found.push(spec.widget.toDOM());
    cursor.next();
  }
  return found;
}

function marksOf(set: ReturnType<typeof buildCaretDecorations>): number {
  let count = 0;
  const cursor = set.iter();
  while (cursor.value !== null) {
    if ((cursor.value.spec as { class?: string }).class === "cm-presence-selection") count += 1;
    cursor.next();
  }
  return count;
}

describe("the flag is optional, the caret is not", () => {
  test("labels off: a caret, a selection wash, and no flag", () => {
    const moved = new Map([["m1", 1_000]]);
    const set = buildCaretDecorations(
      [member({ anchor: at(1), head: at(4) })],
      10,
      1_000,
      moved,
      resolve,
      false,
    );
    const [caret] = widgetsOf(set);
    expect(caret!.className).toBe("cm-presence-caret");
    expect(caret!.querySelector(".cm-presence-label")).toBeNull();
    expect(marksOf(set)).toBe(1);

    // The positive control: the same, labels on, is flagged.
    const on = buildCaretDecorations([member({ anchor: at(1), head: at(4) })], 10, 1_000, moved, resolve, true);
    expect(widgetsOf(on)[0]!.querySelector(".cm-presence-label")).not.toBeNull();
  });

  test("…including a tool's, whose flag otherwise never fades", () => {
    const tool = member({ head: at(3), name: "@jon's Claude", isAgent: true });
    const set = buildCaretDecorations([tool], 10, 0, new Map(), resolve, false);
    expect(widgetsOf(set)[0]!.querySelector(".cm-presence-label")).toBeNull();
  });
});

describe("in a real editor", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  test("setCaretLabels takes the flag off the drawn caret, and puts it back", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "hello world");
    view = new EditorView({
      state: EditorState.create({ doc: "hello world", extensions: [remoteCarets()] }),
      parent: document.body,
    });
    view.dispatch({
      effects: [
        setCaretDocument.of(doc),
        setRemoteCarets.of([member({ anchor: cursorPosition(text, 2), head: cursorPosition(text, 2) })]),
      ],
    });
    expect(view.dom.querySelector(".cm-presence-label")).not.toBeNull();

    view.dispatch({ effects: setCaretLabels.of(false) });
    expect(caretLabelsShown(view.state)).toBe(false);
    expect(view.dom.querySelector(".cm-presence-caret")).not.toBeNull();
    expect(view.dom.querySelector(".cm-presence-label")).toBeNull();

    view.dispatch({ effects: setCaretLabels.of(true) });
    expect(view.dom.querySelector(".cm-presence-label")).not.toBeNull();
  });
});

describe("the live editor decides by density", () => {
  const setWidth = (width: number) => {
    Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
    Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  };

  test("a phone hides the flags; a pointer layout shows them; a resize follows", () => {
    setWidth(390);
    const editor = mount({ value: "hello", editable: true });
    expect(caretLabelsShown(viewIn(editor.container).state)).toBe(false);

    setWidth(1440);
    expect(caretLabelsShown(viewIn(editor.container).state)).toBe(true);
    editor.unmount();

    const wide = mount({ value: "hello", editable: true });
    expect(caretLabelsShown(viewIn(wide.container).state)).toBe(true);
    wide.unmount();
  });
});
