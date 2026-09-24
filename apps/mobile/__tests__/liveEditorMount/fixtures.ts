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
 *
 * This module is the shared mounting harness for every file in this folder —
 * it carries no tests of its own.
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { LiveEditor, type EditorControls } from "../../features/console/files/LiveEditor.web";

/**
 * React logs a warning unless the environment claims act() support, and a
 * warning in a suite that is otherwise silent is noise somebody will learn to
 * ignore.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  /** Re-render with new props, the way the parent component would. */
  update: (props: Partial<Props>) => void;
  changes: string[];
  saves: number;
  /** The imperative handle, read at press time the way `NoteAccessory` does. */
  controls: () => EditorControls | null;
  /** Every handle this editor has handed out, `null`s included. */
  handles: (EditorControls | null)[];
  focus: boolean[];
  unmount: () => void;
}

export interface Props {
  value: string;
  editable: boolean;
  /** Which note is in the editor. A different one is a different document. */
  notePath?: string | null;
}

export function mount(initial: Props): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const changes: string[] = [];
  const handles: (EditorControls | null)[] = [];
  const focus: boolean[] = [];
  const state = { saves: 0 };
  let props = initial;

  const render = () => {
    act(() => {
      root.render(
        createElement(LiveEditor, {
          value: props.value,
          editable: props.editable,
          notePath: props.notePath,
          onChange: (text: string) => changes.push(text),
          onSave: () => {
            state.saves += 1;
          },
          // A fresh arrow on every render, which is the normal way a parent
          // writes this — and the case the mount-only effect exists to survive.
          controls: (api: EditorControls | null) => handles.push(api),
          onFocus: () => focus.push(true),
          onBlur: () => focus.push(false),
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
    handles,
    focus,
    controls: () => handles[handles.length - 1] ?? null,
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
export function viewIn(container: HTMLElement): EditorView {
  const dom = container.querySelector(".cm-editor");
  const view = dom === null ? null : EditorView.findFromDOM(dom as HTMLElement);
  if (view === null) throw new Error("no EditorView mounted");
  return view;
}

/**
 * Table grids in the decoration set, rather than in the DOM.
 *
 * CodeMirror renders only the viewport, so a widget below the fold is absent
 * from the DOM whether or not it was computed — asserting on `querySelector`
 * would pass for the wrong reason on a short note and fail for the wrong reason
 * on a long one. The decorations are the thing under test.
 */
export function gridsIn(view: EditorView): number {
  let found = 0;
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { widget?: { constructor: { name: string } } };
      if (spec.widget?.constructor.name === "TableGridWidget") found += 1;
      iter.next();
    }
  }
  return found;
}

/** The editor's text, read out of the DOM CodeMirror actually built. */
export function renderedText(container: HTMLElement): string {
  const content = container.querySelector(".cm-content");
  return content?.textContent ?? "";
}
