/**
 * The bullet and checkbox widgets drawn in place of list markers, and the
 * press handler that ticks a drawn checkbox.
 *
 * `taskToggle` is created once, here. Part of the Live Preview extension;
 * `../livePreview.ts` is the facade that re-exports the public names and holds
 * the module map.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { isTicked } from "./lists";

/**
 * A bullet, drawn in place of the `-` that means it.
 *
 * Fixed-width by class rather than by the character's own metrics, so the
 * hanging indent above stays true on a wrapped line: a bullet stands in for
 * exactly one character and has to occupy exactly one character's worth of
 * room.
 */
export class BulletWidget extends WidgetType {
  eq(): boolean {
    // Every bullet is the same bullet. Returning `true` lets CodeMirror reuse
    // the DOM across every redraw rather than rebuilding a span per list item
    // per keystroke.
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "\u2022";
    return span;
  }
  /* A click on a bullet should still place the caret on that line. */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A checkbox, drawn as a checkbox.
 *
 * ## Why this is not a character
 *
 * The first version of this drew ☐ and ☑, and they are *text*: they take the
 * body font's weight, they are a different shape in every font that has them at
 * all, several fonts do not and fall back to a box the reader has seen used for
 * "missing glyph", and none of them looks like something you press. The
 * complaint that followed was that checklists "just get rendered as plain
 * text", which was exactly right — they were rendered as text, because they
 * were text.
 *
 * So the box is **drawn**: a border, a radius, and a tick built from two
 * borders on a rotated pseudo-element. That is Obsidian's construction and it
 * is the reason it reads as a control — it does not depend on the reader having
 * a font, and it does not change weight when the surrounding text does.
 *
 * ## The three characters it stands in for
 *
 * The outer span is `3ch` wide and holds a box of about one em inside it, so
 * `[ ]` and the drawn box occupy the same room and `hangingIndents` stays true
 * for a wrapped task. The box is centred in that space rather than left in it,
 * because a `-` and a `[ ]` are different widths and a column of mixed items
 * should still have its text in one column.
 *
 * ## Accessibility
 *
 * `role="checkbox"` with `aria-checked`, because it is one — a screen reader
 * over the raw text would otherwise hear "left bracket x right bracket". It is
 * deliberately not focusable: the editor owns the caret, and a tab stop inside
 * the document would take Tab away from the text.
 */
export class TaskWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }
  /*
    Compared on `checked`, and this is load-bearing rather than an optimisation:
    a widget that reported itself equal to a differently-ticked one would keep
    its old DOM when the box was pressed, so the buffer would say `[x]` and the
    screen would show an empty box until something else forced a redraw.
  */
  eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.checked ? "cm-lp-task cm-lp-task-on" : "cm-lp-task";
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", this.checked ? "true" : "false");
    const box = document.createElement("span");
    box.className = "cm-lp-task-box";
    span.append(box);
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Tick and untick a checkbox by pressing it.
 *
 * A drawn checkbox that does nothing when it is pressed is worse than the `[ ]`
 * it replaced, because the `[ ]` never looked like a control. This edits the
 * three characters in the buffer — there is no other state — so the file is
 * exactly what somebody would have typed, and undo undoes it like any edit.
 *
 * Refused on a read-only note, for the reason `editorSetup`'s `runCommand`
 * states: `changeFilter` would drop the change anyway, but a refused
 * transaction still moves the selection and lands in the history.
 */
export const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return false;
    /*
      `closest`, not `classList.contains`: the press usually lands on the drawn
      box *inside* the widget rather than on the widget itself, and the first
      version tested the class on the target alone — so the checkbox answered a
      press only on the sliver of padding around it.
    */
    const widget = target.closest(".cm-lp-task");
    if (widget === null) return false;
    if (view.state.readOnly) return false;
    /*
      `posAtDOM` answers where the widget sits, which is where the marker it
      replaced starts. Resolving one character in rather than at the boundary
      is what lands inside the node instead of beside it.
    */
    const at = view.posAtDOM(widget) + 1;
    const marker = nodeAt(syntaxTree(view.state).resolveInner(at, 1), "TaskMarker");
    if (marker === null) return false;
    view.dispatch({
      changes: {
        from: marker.from,
        to: marker.to,
        insert: isTicked(view.state.doc, marker.from, marker.to) ? "[ ]" : "[x]",
      },
      userEvent: "input",
    });
    // Claimed, so the press does not also drop a caret in the middle of the
    // three characters it just rewrote — which would reveal the markup and
    // replace the box the person is looking at with `[x]`.
    event.preventDefault();
    return true;
  },
});

/** `node`, or its nearest ancestor of that name, or `null`. */
function nodeAt(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (let current = node; current !== null; current = current.parent) {
    if (current.name === name) return current;
  }
  return null;
}
