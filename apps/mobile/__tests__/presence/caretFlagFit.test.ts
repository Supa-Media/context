/**
 * @jest-environment jsdom
 */

/**
 * A PEER'S CARET IS ONE BOX, AND ITS FLAG STAYS INSIDE THE NOTE.
 *
 * The owner's homepage screenshots on a phone (2026-09-28, "can we please
 * cleanup the cursors here, they seem to get stuck in some weird states"):
 *
 *  1. "jo Claude" at the end of a line ran off the right edge of the glass.
 *  2. A pink stub on a blank line, a second @maya caret at the start of a line
 *     she had typed past, and an @maya flag floating free of any caret, or
 *     clipped to a sliver showing only "a".
 *
 * Driving the same cast in a browser at 390x844 and sampling the DOM every
 * 150ms found exactly one caret per member throughout, so (2) was never a
 * second caret in the roster: it was paint left behind by a caret drawn as an
 * empty inline span with a border, and a flag positioned against that span.
 * The caret is now a zero-width atomic box a line tall, with its bar and flag
 * positioned inside it; (1) is `caretFlagFit`, which measures each flag and
 * opens it leftwards when it would cross the content's right edge.
 *
 * SABOTAGE: dropping `caretFlagFit` from `remoteCarets()` fails the editor
 * tests below; `placeFlag` always answering `flip: false` fails the geometry
 * tests; drawing the bar as the caret's own border again (or the label as a
 * sibling rather than a child) fails "one box".
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  buildCaretDecorations,
  remoteCarets,
  setCaretDocument,
  setCaretLabels,
  setRemoteCarets,
} from "../../features/console/presence/remoteCarets";
import { FLIP_CLASS, flagMeasure, placeFlag, ROOM_PROPERTY } from "../../features/console/presence/caretFlagFit";
import { cursorPosition } from "../../features/console/presence/sync";
import { at, member, resolve } from "./fixtures";

describe("which way a flag opens", () => {
  const edges = { left: 24, right: 366 };

  test("rightwards when the whole name fits", () => {
    expect(placeFlag({ ...edges, caretX: 100, width: 60 })).toEqual({ flip: false, room: null });
  });

  test("leftwards, uncapped, when a caret near the right edge would push it off the note", () => {
    // "jo Claude" at the end of "is the 90-second tour." in the screenshot.
    expect(placeFlag({ ...edges, caretX: 340, width: 66 })).toEqual({ flip: true, room: null });
  });

  test("a flag that exactly fits is not flipped", () => {
    expect(placeFlag({ ...edges, caretX: 301, width: 66 })).toEqual({ flip: false, room: null });
  });

  test("with room on neither side, toward the wider side and capped to it, never to a sliver", () => {
    const narrow = { left: 0, right: 100 };
    expect(placeFlag({ ...narrow, caretX: 70, width: 160 })).toEqual({ flip: true, room: 71 });
    expect(placeFlag({ ...narrow, caretX: 20, width: 160 })).toEqual({ flip: false, room: 81 });
  });
});

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

describe("one box", () => {
  test("the bar and the flag are both inside the caret, which draws nothing itself", () => {
    const moved = new Map([["m1", 1_000]]);
    for (const labels of ["full", "compact"] as const) {
      const [caret] = widgetsOf(buildCaretDecorations([member({ head: at(3) })], 10, 1_000, moved, resolve, labels));
      expect(caret!.className).toBe("cm-presence-caret");
      // No border on the caret: a border on an empty inline is what left stubs.
      expect(caret!.style.borderLeftColor).toBe("");
      const bar = caret!.querySelector(":scope > .cm-presence-bar") as HTMLElement | null;
      expect(bar).not.toBeNull();
      expect(bar!.style.backgroundColor).not.toBe("");
      expect(caret!.querySelector(":scope > .cm-presence-label")).not.toBeNull();
    }
  });

  test("a caret with no flag is still one bar", () => {
    const [caret] = widgetsOf(buildCaretDecorations([member({ head: at(3) })], 10, 1_000, new Map(), resolve, "none"));
    expect(caret!.children).toHaveLength(1);
    expect(caret!.firstElementChild!.className).toBe("cm-presence-bar");
  });
});

describe("in a real editor", () => {
  let view: EditorView | null = null;
  const rects: Array<{ restore: () => void }> = [];

  /** Every caret at `caretX`, the content from 24 to 366, every flag `width` wide. */
  function geometry(caretX: number, width: number) {
    const rect = (left: number, right: number) =>
      ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const box = jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("cm-content")) return rect(24, 366);
      if (this.classList.contains("cm-presence-caret")) return rect(caretX, caretX);
      return rect(0, 0);
    });
    const scroll = jest.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("cm-presence-label") ? width : 0;
    });
    rects.push({ restore: () => (box.mockRestore(), scroll.mockRestore()) });
  }

  /** The flag measurements the editor asked for, run now rather than on the next frame. */
  let requested: Array<{ view: EditorView; read: (view: EditorView) => unknown; write: (value: unknown, view: EditorView) => void }> = [];
  function flush(): void {
    const now = requested;
    requested = [];
    for (const one of now) one.write(one.read(one.view), one.view);
  }

  function open(labels: "full" | "compact" = "full"): HTMLElement {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "new here? is the 90-second tour.");
    view = new EditorView({
      state: EditorState.create({ doc: text.toString(), extensions: [remoteCarets()] }),
      parent: document.body,
    });
    const end = cursorPosition(text, text.length);
    view.dispatch({
      effects: [
        setCaretLabels.of(labels),
        setCaretDocument.of(doc),
        setRemoteCarets.of([member({ name: "@jon's Claude", isAgent: true, anchor: end, head: end })]),
      ],
    });
    flush();
    return view.dom.querySelector(".cm-presence-label") as HTMLElement;
  }

  beforeEach(() => {
    rects.length = 0;
    requested = [];
    const original = EditorView.prototype.requestMeasure;
    // jsdom has no layout for CodeMirror's own measuring; only the flags' is run.
    jest.spyOn(EditorView.prototype, "requestMeasure").mockImplementation(function (this: EditorView, request) {
      if (request !== undefined && request.read === flagMeasure.read) {
        requested.push({ view: this, read: request.read, write: request.write as never });
        return;
      }
      original.call(this, request);
    });
  });
  afterEach(() => {
    view?.destroy();
    view = null;
    for (const one of rects) one.restore();
    jest.restoreAllMocks();
  });

  test("a flag at the end of a line opens leftwards, and back again when the caret moves on", () => {
    geometry(340, 66);
    const label = open("compact");
    expect(label.classList.contains(FLIP_CLASS)).toBe(true);
    expect(label.style.getPropertyValue(ROOM_PROPERTY)).toBe("");

    // The same widget, reused: it must be measured again where it now is.
    for (const one of rects) one.restore();
    geometry(40, 66);
    view!.dispatch({});
    flush();
    expect(view!.dom.querySelector(".cm-presence-label")).toBe(label);
    expect(label.classList.contains(FLIP_CLASS)).toBe(false);
  });

  test("the caret is an atomic box a line tall, so an empty line cannot shrink or split it", () => {
    geometry(100, 66);
    open();
    const caret = view!.dom.querySelector(".cm-presence-caret") as HTMLElement;
    const style = getComputedStyle(caret);
    expect(style.display).toBe("inline-block");
    expect(style.position).toBe("relative");
    expect(style.height).toBe("1.2em");
    expect(getComputedStyle(caret.querySelector(".cm-presence-label")!).position).toBe("absolute");
  });

  test("a flag with room opens rightwards", () => {
    geometry(100, 66);
    expect(open().classList.contains(FLIP_CLASS)).toBe(false);
  });

  test("a name too long for either side is capped to the wider one", () => {
    geometry(300, 600);
    const label = open();
    expect(label.classList.contains(FLIP_CLASS)).toBe(true);
    expect(label.style.getPropertyValue(ROOM_PROPERTY)).toBe("277px");
  });
});
