/**
 * Other people's carets, drawn in this editor.
 *
 * A `StateField` holding the roster, a `StateEffect` to replace it, and a set
 * of decorations built from it. No socket, no React, no timers: the extension
 * takes members and draws them, which is why `buildCaretDecorations` is
 * exported and tested directly rather than through a mounted editor.
 *
 * ## Offsets from a peer are not positions in this document
 *
 * They arrive from somebody else's browser, relayed by a gateway that has never
 * seen the note and therefore cannot check them. They can be past the end of
 * the document, in either order, or the same. Every one of them is clamped here
 * before it becomes a range, because a CodeMirror range built past `doc.length`
 * throws — and it throws inside the update cycle of an editor somebody is
 * typing in, which loses their next keystrokes rather than their peer's caret.
 *
 * ## The label is not a tooltip
 *
 * It is an inline widget with `side: 1`, so it sits after the caret's position
 * and does not shift the text: a label that took part in layout would reflow
 * the paragraph every time somebody else moved, which is the visual equivalent
 * of somebody typing in your line. It is `pointer-events: none` for the same
 * reason — a peer's name must never eat a click meant for the word under it.
 */

import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { clampToDocument, type PresenceMember } from "./protocol";

/** Replace the whole roster. Nothing here merges: the reducer already did. */
export const setRemoteCarets = StateEffect.define<PresenceMember[]>();

/**
 * How long a label stays visible after its caret last moved.
 *
 * Long enough to read a handle, short enough that four people in one paragraph
 * do not permanently cover the text they are all looking at. The caret itself
 * never fades — the label is the noisy part.
 */
export const CARET_LABEL_MS = 3_000;

class CaretWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly color: string,
    readonly labelled: boolean,
  ) {
    super();
  }

  // Without this, every roster update replaces every widget in the document,
  // which makes the labels flicker on somebody else's keystroke.
  eq(other: CaretWidget): boolean {
    return other.name === this.name && other.color === this.color && other.labelled === this.labelled;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-presence-caret";
    caret.style.borderLeftColor = this.color;
    // The name is set as *text*, never as markup. It has been stripped twice
    // before it got here and this is the third place it cannot become HTML.
    caret.setAttribute("aria-hidden", "true");
    if (this.labelled) {
      const label = document.createElement("span");
      label.className = "cm-presence-label";
      label.style.backgroundColor = this.color;
      label.textContent = this.name;
      caret.appendChild(label);
    }
    return caret;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The decorations for one roster against one document length.
 *
 * Pure, and exported for the tests: given members and a length, this is every
 * range that will be drawn. `RangeSetBuilder` needs them in document order, so
 * they are sorted by position first — an unsorted add is the error that reads
 * as "Ranges must be added sorted" from inside an editor somebody is using.
 */
export function buildCaretDecorations(
  members: PresenceMember[],
  docLength: number,
  now: number,
  lastMoved: Map<string, number>,
): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];

  for (const member of members) {
    const anchor = clampToDocument(member.anchor, docLength);
    const head = clampToDocument(member.head, docLength);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);

    if (from !== to) {
      ranges.push({
        from,
        to,
        deco: Decoration.mark({
          class: "cm-presence-selection",
          attributes: { style: `background-color: ${withAlpha(member.color)}` },
        }),
      });
    }

    const movedAt = lastMoved.get(member.id) ?? 0;
    const labelled = now - movedAt < CARET_LABEL_MS;
    ranges.push({
      from: head,
      to: head,
      deco: Decoration.widget({ widget: new CaretWidget(member.name, member.color, labelled), side: 1 }),
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.deco);
  return builder.finish();
}

/** A selection highlight at the caret colour, kept light enough to read through. */
function withAlpha(color: string): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!hex) return "rgba(141, 133, 123, 0.22)";
  const value = hex[1];
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.22)`;
}

interface CaretState {
  members: PresenceMember[];
  /** When each member's caret last changed, for the label's fade. */
  lastMoved: Map<string, number>;
}

const caretState = StateField.define<CaretState>({
  create(): CaretState {
    return { members: [], lastMoved: new Map() };
  },
  update(value, transaction): CaretState {
    let next = value;
    for (const effect of transaction.effects) {
      if (!effect.is(setRemoteCarets)) continue;
      const now = Date.now();
      const lastMoved = new Map(value.lastMoved);
      for (const member of effect.value) {
        const previous = value.members.find((one) => one.id === member.id);
        if (!previous || previous.head !== member.head || previous.anchor !== member.anchor) {
          lastMoved.set(member.id, now);
        }
      }
      // Members who left stop being remembered, so the map cannot grow for the
      // life of a long editing session.
      for (const id of lastMoved.keys()) {
        if (!effect.value.some((one) => one.id === id)) lastMoved.delete(id);
      }
      next = { members: effect.value, lastMoved };
    }
    return next;
  },
});

const caretDecorations = EditorView.decorations.compute([caretState, "doc"], (state) => {
  const held = state.field(caretState);
  return buildCaretDecorations(held.members, state.doc.length, Date.now(), held.lastMoved);
});

/**
 * Repaint once a label is due to fade.
 *
 * Without this the label hangs until the next unrelated update — which, for
 * somebody reading rather than typing, can be a long time. One timer, armed
 * only while a label is actually showing, so an editor with nobody else in it
 * schedules nothing.
 */
const caretLabelTimer = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setRemoteCarets)))) return;
  const view = update.view;
  window.setTimeout(() => {
    // A no-op transaction: the decoration facet recomputes against a newer
    // `Date.now()` and the label drops out.
    if (view.dom.isConnected) view.dispatch({});
  }, CARET_LABEL_MS + 50);
});

const caretTheme = EditorView.baseTheme({
  ".cm-presence-caret": {
    position: "relative",
    borderLeft: "2px solid",
    marginLeft: "-1px",
    pointerEvents: "none",
  },
  ".cm-presence-label": {
    position: "absolute",
    left: "-1px",
    top: "-1.35em",
    padding: "1px 6px",
    borderRadius: "5px 5px 5px 0",
    fontSize: "11px",
    fontWeight: "600",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    color: "#100F0E",
    pointerEvents: "none",
    userSelect: "none",
  },
  ".cm-presence-selection": {
    borderRadius: "3px",
  },
});

/** The whole extension, for `editorExtensions` to include. */
export function remoteCarets(): Extension {
  return [caretState, caretDecorations, caretLabelTimer, caretTheme];
}
