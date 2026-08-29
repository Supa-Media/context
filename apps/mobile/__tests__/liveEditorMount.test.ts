/**
 * @jest-environment jsdom
 */

/**
 * THE LIVE EDITOR, MOUNTED.
 *
 * `livePreview.test.ts` proves the decoration logic without a DOM. This proves
 * the part that logic cannot: that a real CodeMirror instance and React's idea
 * of the document stay in agreement.
 *
 * There is one bug worth this whole file, and it is invisible to every test
 * that does not mount:
 *
 *   Editor fires `onChange` → parent re-renders with the same text → the effect
 *   writes it back into the editor → CodeMirror replaces the document → the
 *   selection resets.
 *
 * On screen that is **the caret jumping to the end of the document on every
 * keystroke**, and the editor is unusable. A string renderer sees none of it,
 * because nothing about the rendered output is wrong; what is wrong is that a
 * document was dispatched at all. So the tests below count dispatches and read
 * the selection, rather than asserting on markup.
 */

import { describe, expect, test } from "@jest/globals";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { LiveEditor } from "../features/console/files/LiveEditor.web";

/**
 * React logs a warning unless the environment claims act() support, and a
 * warning in a suite that is otherwise silent is noise somebody will learn to
 * ignore.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  /** Re-render with new props, the way the parent component would. */
  update: (props: Partial<Props>) => void;
  changes: string[];
  saves: number;
  unmount: () => void;
}

interface Props {
  value: string;
  editable: boolean;
}

function mount(initial: Props): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const changes: string[] = [];
  const state = { saves: 0 };
  let props = initial;

  const render = () => {
    act(() => {
      root.render(
        createElement(LiveEditor, {
          value: props.value,
          editable: props.editable,
          onChange: (text: string) => changes.push(text),
          onSave: () => {
            state.saves += 1;
          },
          accessibilityLabel: "note markdown",
        }),
      );
    });
  };

  render();

  return {
    container,
    root,
    update: (next) => {
      props = { ...props, ...next };
      render();
    },
    changes,
    get saves() {
      return state.saves;
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  } as Mounted;
}

/**
 * The live `EditorView`, through CodeMirror's own public lookup.
 *
 * `EditorView.findFromDOM` rather than reaching for an internal handle on the
 * element: a test that pokes at internals passes or fails on a detail the
 * library never promised, and this one is asserting behaviour the library does
 * promise.
 */
function viewIn(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor");
  const view = dom === null ? null : EditorView.findFromDOM(dom as HTMLElement);
  if (view === null) throw new Error("no EditorView mounted");
  return view;
}

/** The editor's text, read out of the DOM CodeMirror actually built. */
function renderedText(container: HTMLElement): string {
  const content = container.querySelector(".cm-content");
  return content?.textContent ?? "";
}

describe("mounting", () => {
  test("the note's text is in the editor", () => {
    const m = mount({ value: "# Heading\n\nbody", editable: true });
    expect(renderedText(m.container)).toContain("Heading");
    m.unmount();
  });

  test("the accessibility label reaches the DOM", () => {
    const m = mount({ value: "x", editable: true });
    expect(m.container.querySelector('[aria-label="note markdown"]')).not.toBeNull();
    m.unmount();
  });

  test("unmounting destroys the view rather than leaking it", () => {
    const m = mount({ value: "x", editable: true });
    expect(m.container.querySelector(".cm-editor")).not.toBeNull();
    m.unmount();
    expect(m.container.querySelector(".cm-editor")).toBeNull();
  });
});

describe("React must not fight the editor", () => {
  /**
   * THE test this file exists for.
   *
   * The parent re-renders with the *same* text — which is what happens on every
   * keystroke once `onChange` has run — and the editor must not be written to.
   * If it is, the selection resets and the caret jumps to the end of the
   * document.
   */
  test("the parent echoing back what was just typed leaves the caret alone", () => {
    const m = mount({ value: "hello world", editable: true });
    const view = viewIn(m.container);

    // Type an X at position 5, the way a person would. The caret lands after
    // it, in the middle of the document.
    view.dispatch({
      changes: { from: 5, insert: "X" },
      selection: { anchor: 6 },
    });
    expect(view.state.doc.toString()).toBe("helloX world");
    expect(view.state.selection.main.head).toBe(6);

    // The reducer now re-renders with that same text. This is the echo, and it
    // is a *changed* prop — which is why an earlier version of this test, which
    // re-rendered with unchanged text, proved nothing: React skips the effect
    // entirely when the dependency is referentially equal, so the guard was
    // never reached and removing it did not fail anything.
    m.update({ value: "helloX world" });

    // Without the `value === latestValue.current` guard the effect replaces the
    // whole document here, and the caret is thrown to the end.
    expect(view.state.doc.toString()).toBe("helloX world");
    expect(view.state.selection.main.head).toBe(6);
    m.unmount();
  });

  /**
   * The other direction: text that genuinely came from outside — a different
   * note opened, a draft discarded, a conflict resolved with "load theirs" —
   * must land in the editor. Suppressing this to avoid the loop above would
   * mean opening a second note and seeing the first one's contents.
   */
  test("authoritative text from outside is written in", () => {
    const m = mount({ value: "first note", editable: true });
    m.update({ value: "second note entirely" });
    expect(renderedText(m.container)).toContain("second note entirely");
    m.unmount();
  });

  test("typing reaches onChange exactly once per change", () => {
    const m = mount({ value: "", editable: true });
    viewIn(m.container).dispatch({ changes: { from: 0, insert: "typed" } });

    expect(m.changes).toEqual(["typed"]);
    m.unmount();
  });
});

describe("editability", () => {
  test("a read-only note is not editable, and stays wired up", () => {
    const m = mount({ value: "text", editable: true });
    m.update({ editable: false });

    const view = viewIn(m.container);
    expect(view.state.facet(EditorView.editable)).toBe(false);

    /**
     * The important half of this test is the second assertion. Toggling
     * editability by replacing the whole configuration — which an earlier draft
     * did — silently rebuilds the update listener and detaches typing from
     * `onChange`. A compartment swaps one facet and leaves the listener alone,
     * so a programmatic change still reports.
     */
    view.dispatch({ changes: { from: 0, insert: "more " } });
    expect(m.changes.length).toBeGreaterThan(0);
    m.unmount();
  });
});
