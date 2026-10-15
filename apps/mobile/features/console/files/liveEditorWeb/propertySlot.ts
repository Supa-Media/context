/**
 * Where a note's property chips are drawn in the web editor: a box under its
 * title, which the note page portals its chips into (`noteEditor/chips/`).
 *
 * The chips sit *under the name* (board B of `property-dropdown`, picked by
 * the owner on 2026-10-14), and on the web the name is the first line of the
 * document — so the place under it is inside the editor. A block widget
 * rather than React drawn over the editor, for `titleLine.ts`'s reason: it
 * moves with the title, a wrapped one or one that grows as it is typed,
 * without anybody measuring anything. A note with no title line has its name
 * drawn above the editor (`NameField`), and the box is the editor's first
 * thing instead, which is again right under the name.
 *
 * ## One host that moves, as `joinSlot.ts` does
 *
 * The page hands in one element, `host`, that lives as long as the page. The
 * widget's box takes it in when drawn and lets it go when destroyed, so when
 * CodeMirror redraws the box — it can, when the text around it changes — the
 * chips inside are moved, never remounted, and a menu or a half-typed tag
 * survives the title changing above it.
 *
 * Events in the box are the chips', not the editor's (`ignoreEvent`), and the
 * box is not editable: a click on a chip must not put a caret in the note.
 */

import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { titleRange } from "./titleLine";

/** Put the chips' host under the title, or `null` to take the box away. */
export const setPropertyHost = StateEffect.define<HTMLElement | null>();

class PropertySlotWidget extends WidgetType {
  constructor(readonly host: HTMLElement) {
    super();
  }

  eq(other: PropertySlotWidget): boolean {
    return other.host === this.host;
  }

  toDOM(): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-lp-property-slot";
    box.contentEditable = "false";
    box.appendChild(this.host);
    return box;
  }

  destroy(box: HTMLElement): void {
    // Only if it is still here: a redraw may already have moved it into the new box.
    if (this.host.parentElement === box) box.removeChild(this.host);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Where the box goes: after the title line when there is one, else before the
 * first line of the body — never inside the front matter block, which the
 * editor folds away.
 */
export function propertySlotAt(state: EditorState): { pos: number; side: 1 | -1 } {
  const title = titleRange(state);
  if (title !== null) return { pos: title.to, side: 1 };
  const doc = state.doc;
  let number = 1;
  if (doc.lines >= 1 && doc.line(1).text.trim() === "---") {
    let close = 2;
    while (close <= doc.lines && doc.line(close).text.trim() !== "---") close += 1;
    // An unclosed block is not front matter; the box then simply opens the note.
    if (close <= doc.lines) number = close + 1;
  }
  if (number > doc.lines) return { pos: doc.length, side: 1 };
  return { pos: doc.line(number).from, side: -1 };
}

function decorate(state: EditorState, host: HTMLElement | null): DecorationSet {
  if (host === null) return Decoration.none;
  const { pos, side } = propertySlotAt(state);
  return Decoration.set([Decoration.widget({ widget: new PropertySlotWidget(host), block: true, side }).range(pos)]);
}

const propertySlotField = StateField.define<{ host: HTMLElement | null; decorations: DecorationSet }>({
  create: () => ({ host: null, decorations: Decoration.none }),
  update(value, transaction) {
    let host = value.host;
    for (const effect of transaction.effects) if (effect.is(setPropertyHost)) host = effect.value;
    if (host === value.host && !transaction.docChanged) return value;
    return { host, decorations: decorate(transaction.state, host) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function propertySlot(): Extension {
  return propertySlotField;
}

/** Draw the box with `host` in it, or take it away. */
export function showPropertySlot(view: EditorView, host: HTMLElement | null): void {
  const current = view.state.field(propertySlotField, false)?.host ?? null;
  if (current === host) return;
  view.dispatch({ effects: setPropertyHost.of(host) });
}
