/**
 * @jest-environment jsdom
 */

/**
 * ON A PHONE A PEER'S CARET CARRIES A COMPACT NAME FLAG.
 *
 * The phone artboards (2026-09-27, screen 1) first hid the flags, because at
 * 390pt a full flag ("@maya", "jo Claude") lay over the words being read and
 * clipped at the right edge. The owner then asked (2026-09-28) "why dont we
 * show the name of whos typing on the cursor on mobile", so a phone draws a
 * smaller flag instead of none: the same name, 10px type, capped in width.
 *
 * Three layers, each held:
 *  - `buildCaretDecorations` draws a compact flag in "compact" and none in
 *    "none", for a person and for a tool;
 *  - the `setCaretLabels` effect reaches the drawn DOM of a real editor;
 *  - the mounted `LiveEditor` picks compact at a phone width and full at a
 *    pointer width, and follows a resize.
 *
 * SABOTAGE: `LiveEditor.web.tsx` dispatching "none" on a phone fails the last
 * test; the widget ignoring "compact" fails the first.
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

describe("the flag has a phone size, and the caret is never optional", () => {
  test("compact: the same name, drawn small, over a caret and a selection wash", () => {
    const moved = new Map([["m1", 1_000]]);
    const one = [member({ anchor: at(1), head: at(4) })];
    const compact = widgetsOf(buildCaretDecorations(one, 10, 1_000, moved, resolve, "compact"))[0]!;
    const label = compact.querySelector(".cm-presence-label");
    expect(label).not.toBeNull();
    expect(label!.classList.contains("cm-presence-label-compact")).toBe(true);

    // The full flag is the pointer layout's, and carries no compact class.
    const full = widgetsOf(buildCaretDecorations(one, 10, 1_000, moved, resolve, "full"))[0]!;
    expect(full.querySelector(".cm-presence-label-compact")).toBeNull();
    expect(full.querySelector(".cm-presence-label")!.textContent).toBe(label!.textContent);
  });

  test("none: a caret, a selection wash, and no flag", () => {
    const moved = new Map([["m1", 1_000]]);
    const set = buildCaretDecorations(
      [member({ anchor: at(1), head: at(4) })],
      10,
      1_000,
      moved,
      resolve,
      "none",
    );
    const [caret] = widgetsOf(set);
    expect(caret!.className).toBe("cm-presence-caret");
    expect(caret!.querySelector(".cm-presence-label")).toBeNull();
    expect(marksOf(set)).toBe(1);

  });

  test("a tool's compact flag still never fades, and still says whose", () => {
    const tool = member({ head: at(3), name: "@jon's Claude", isAgent: true });
    const label = widgetsOf(buildCaretDecorations([tool], 10, 60_000, new Map(), resolve, "compact"))[0]!
      .querySelector(".cm-presence-label-compact");
    expect(label!.textContent).toBe("joClaude");
    expect(widgetsOf(buildCaretDecorations([tool], 10, 0, new Map(), resolve, "none"))[0]!.querySelector(".cm-presence-label")).toBeNull();
  });

  test("a person's compact flag fades like the full one", () => {
    const moved = new Map([["m1", 0]]);
    const later = buildCaretDecorations([member({ head: at(2) })], 10, 10_000, moved, resolve, "compact");
    expect(widgetsOf(later)[0]!.querySelector(".cm-presence-label")).toBeNull();
  });
});

describe("in a real editor", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
  });

  test("setCaretLabels changes the drawn flag's size, takes it off, and puts it back", () => {
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

    view.dispatch({ effects: setCaretLabels.of("compact") });
    expect(caretLabelsShown(view.state)).toBe("compact");
    expect(view.dom.querySelector(".cm-presence-label-compact")).not.toBeNull();

    view.dispatch({ effects: setCaretLabels.of("none") });
    expect(caretLabelsShown(view.state)).toBe("none");
    expect(view.dom.querySelector(".cm-presence-caret")).not.toBeNull();
    expect(view.dom.querySelector(".cm-presence-label")).toBeNull();

    view.dispatch({ effects: setCaretLabels.of("full") });
    expect(view.dom.querySelector(".cm-presence-label")).not.toBeNull();
    expect(view.dom.querySelector(".cm-presence-label-compact")).toBeNull();
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

  test("a phone draws compact flags; a pointer layout full ones; a resize follows", () => {
    setWidth(390);
    const editor = mount({ value: "hello", editable: true });
    expect(caretLabelsShown(viewIn(editor.container).state)).toBe("compact");

    setWidth(1440);
    expect(caretLabelsShown(viewIn(editor.container).state)).toBe("full");
    editor.unmount();

    const wide = mount({ value: "hello", editable: true });
    expect(caretLabelsShown(viewIn(wide.container).state)).toBe("full");
    wide.unmount();
  });
});
