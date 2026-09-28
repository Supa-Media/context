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
 *
 * ## A phone draws a smaller label
 *
 * The phone artboards (2026-09-27) first hid the flags on phones, because at
 * 390pt a full flag lies over the words being read and clips at the edge of the
 * glass. The owner then asked why a phone could not see who was typing
 * (2026-09-28), so a phone gets a compact flag instead: smaller type, a tighter
 * pad, and a width cap that ends a long name in an ellipsis. It still fades
 * like the full one. The editor picks the size by density and says so with
 * `setCaretLabels`; this file only obeys. A flag that would cross the note's
 * right edge opens leftwards instead (`caretFlagFit.ts`).
 *
 * ## One box
 *
 * A caret is a zero-width `inline-block` a line tall, with its bar and its flag
 * both absolutely positioned inside it. It used to be an empty inline span
 * drawing a border, with the flag positioned against that span. On a phone
 * (the owner's homepage screenshots, 2026-09-28) that left pink stubs on a
 * blank line, a second caret at the start of a line the peer had typed past,
 * and a flag floating free of any caret, while the document itself held one
 * caret per member throughout (sampled every 150ms at 390 and 440pt). So the
 * leftovers were paint, not roster: most likely WebKit not repainting a
 * relatively positioned *empty inline*, whose box is derived from line boxes
 * that change under it as the line fills. An atomic box has bounds of its own,
 * a real height on an empty line, and is never split across line fragments.
 */

import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { clampToDocument, type PresenceMember } from "./protocol";
import { cursorOffset } from "./sync";
import { faceNode } from "../faces/faceDom";
import { agentName } from "./agentName";
import type * as Y from "yjs";
import { darkColors } from "../../design/tokens";
import { caretFlagFit, FLIP_CLASS, LIFT_PROPERTY, ROOM_PROPERTY } from "./caretFlagFit";

/** Replace the whole roster. Nothing here merges: the reducer already did. */
/** How carets carry their name flags: full size, the phone's compact size, or not at all. */
export type CaretLabels = "full" | "compact" | "none";


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
    readonly labelled: CaretLabels,
  ) {
    super();
  }

  // Without this, every roster update replaces every widget in the document,
  // which makes the labels flicker on somebody else's keystroke.
  eq(other: CaretWidget): boolean {
    return other.name === this.name && other.color === this.color && other.labelled === this.labelled;
  }

  toDOM(): HTMLElement {
    // One positioned box, the bar and the flag both inside it: see the file
    // header's "One box" for what drawing them separately cost on a phone.
    const caret = document.createElement("span");
    caret.className = "cm-presence-caret";
    caret.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "cm-presence-bar";
    bar.style.backgroundColor = this.color;
    caret.appendChild(bar);
    // The name is set as *text*, never as markup. It has been stripped twice
    // before it got here and this is the third place it cannot become HTML.
    if (this.labelled !== "none") {
      const label = document.createElement("span");
      label.className =
        this.labelled === "compact" ? "cm-presence-label cm-presence-label-compact" : "cm-presence-label";
      label.style.backgroundColor = this.color;
      // A face, then the name: "@jon" is @jon's face and "@jon"; "@jon's
      // Claude" is @jon's face and "Claude", whose then what, compactly. The
      // face is the one drawn everywhere else (`faces/`), never initials.
      const { owner, agent } = agentName(this.name);
      const whose = owner ?? (this.name.startsWith("@") ? this.name : null);
      if (whose !== null) {
        const face = faceNode(whose, "cm-presence-owner");
        face.style.cssText +=
          "display: inline-block; width: 1.15em; height: 1.15em; border-radius: 50%; margin-right: 4px; vertical-align: -0.2em; line-height: 1.15em; text-align: center;";
        label.appendChild(face);
      }
      label.appendChild(document.createTextNode(agent));
      label.title = this.name;
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
  /**
   * Resolves a peer's relative position into an offset in *this* document.
   *
   * Absent in the tests that only care about geometry, and then a member whose
   * position cannot be resolved is simply not drawn — which is also the
   * behaviour when a peer's caret refers to text this client has not received
   * yet, and is why this returns `null` rather than guessing at zero.
   */
  resolve?: (encoded: string) => number | null,
  /**
   * How a caret's name flag is drawn: compact on a phone, where a full flag
   * covers what is being read (see the file header). "none" overrides a tool's
   * never-fading flag too.
   */
  labels: CaretLabels = "full",
): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration }[] = [];

  for (const member of members) {
    const rawAnchor = member.anchor === null ? null : (resolve?.(member.anchor) ?? null);
    const rawHead = member.head === null ? null : (resolve?.(member.head) ?? null);
    // A caret whose position this document cannot place is not drawn at all.
    // Drawing it at zero would put somebody's name at the top of the note and
    // claim they are there.
    if (rawHead === null) continue;
    const anchor = clampToDocument(rawAnchor ?? rawHead, docLength);
    const head = clampToDocument(rawHead, docLength);
    const from = Math.min(anchor, head);
    const to = Math.max(anchor, head);

    if (from !== to) {
      ranges.push({
        from,
        to,
        deco: Decoration.mark({
          class: "cm-presence-selection",
          attributes: { style: `background-color: ${withAlpha(inkFor(member))}` },
        }),
      });
    }

    /*
      A label fades because the caret keeps moving and the colour is enough to
      tell two colleagues apart once you have read their names. A tool's caret
      does neither: it appears once when a write lands, does not move again,
      and is taken down about a minute later. Fading its label leaves an
      unexplained caret sitting in somebody's note for the rest of that minute,
      which is the question this feature exists to answer.
    */
    const movedAt = lastMoved.get(member.id) ?? 0;
    const labelled = member.isAgent || now - movedAt < CARET_LABEL_MS ? labels : "none";
    ranges.push({
      from: head,
      to: head,
      deco: Decoration.widget({ widget: new CaretWidget(member.name, inkFor(member), labelled), side: 1 }),
    });
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of ranges) builder.add(range.from, range.to, range.deco);
  return builder.finish();
}

/**
 * The colour a member is drawn in.
 *
 * A peer that sent nothing usable gets the muted chrome token rather than a
 * hue: an unknown member should read as present and unremarkable, not as a
 * ninth person in a palette of eight.
 */
function inkFor(member: PresenceMember): string {
  return member.color ?? darkColors.chromeMuted;
}

/** A selection highlight at the caret colour, kept light enough to read through. */
function withAlpha(color: string): string {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!hex) return `rgba(141, 133, 123, 0.22)`;
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

/**
 * How carets carry name flags in this editor. The editor sets it from its
 * density (`LiveEditor.web.tsx`): compact on a phone. Full until told
 * otherwise, so an editor nobody configures behaves as it always did.
 */
export const setCaretLabels = StateEffect.define<CaretLabels>();

const caretLabels = StateField.define<CaretLabels>({
  create: () => "full",
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCaretLabels)) return effect.value;
    }
    return value;
  },
});

/** Read back what `setCaretLabels` last said, for the editor's own checks. */
export function caretLabelsShown(state: EditorState): CaretLabels {
  return state.field(caretLabels, false) ?? "full";
}

/**
 * The document carets are resolved against, set when the room binds.
 *
 * A relative position is meaningless without the document it refers to, so the
 * extension needs the `Y.Doc` to draw anything at all. Held in a `StateField`
 * alongside the roster rather than captured in a closure, for the reason the
 * roster is: the editor is built before the room answers.
 */
export const setCaretDocument = StateEffect.define<Y.Doc | null>();

const caretDocument = StateField.define<Y.Doc | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCaretDocument)) return effect.value;
    }
    return value;
  },
});

const caretDecorations = EditorView.decorations.compute(
  [caretState, caretDocument, caretLabels, "doc"],
  (state) => {
    const held = state.field(caretState);
    const doc = state.field(caretDocument);
    return buildCaretDecorations(
      held.members,
      state.doc.length,
      Date.now(),
      held.lastMoved,
      doc === null ? undefined : (encoded) => cursorOffset(encoded, doc),
      state.field(caretLabels),
    );
  },
);

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
  // A zero-width atomic box a line tall, on an empty line as on a full one.
  ".cm-presence-caret": {
    position: "relative",
    display: "inline-block",
    width: "0",
    height: "1.2em",
    verticalAlign: "text-bottom",
    pointerEvents: "none",
  },
  ".cm-presence-bar": {
    position: "absolute",
    left: "-1px",
    // Grows upward with a lifted flag (`caretFlagFit`), so the two stay joined.
    top: `calc(-1 * var(${LIFT_PROPERTY}, 0px))`,
    bottom: "0",
    width: "2px",
    borderRadius: "1px",
  },
  ".cm-presence-label": {
    position: "absolute",
    left: "-1px",
    bottom: `calc(100% + var(${LIFT_PROPERTY}, 0px))`,
    // Above every bar, so a lifted flag's longer bar never crosses a name.
    zIndex: "1",
    boxSizing: "border-box",
    /*
      The flag sits inside a line and would inherit its text layout. A bullet
      line's hanging indent (a negative text-indent) shifted the name left
      inside the flag's own overflow: "@priya" drew as "riya" (the owner, on
      the pricing page, after #1053). Reset everything that moves text in a box.
    */
    textIndent: "0",
    textAlign: "left",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    fontStyle: "normal",
    direction: "ltr",
    width: "max-content",
    // `caretFlagFit` narrows this only when neither side has room for the name.
    maxWidth: `var(${ROOM_PROPERTY}, none)`,
    overflow: "hidden",
    textOverflow: "ellipsis",
    padding: "1px 6px",
    borderRadius: "5px 5px 5px 0",
    fontSize: "11px",
    fontWeight: "600",
    lineHeight: "1.4",
    whiteSpace: "nowrap",
    color: darkColors.ink,
    pointerEvents: "none",
    userSelect: "none",
  },
  // Opens leftwards, its right edge on the caret: set by `caretFlagFit` when
  // the flag would otherwise cross the content's right edge.
  [`.cm-presence-label.${FLIP_CLASS}`]: {
    left: "auto",
    right: "-1px",
    borderRadius: "5px 5px 0 5px",
  },
  // The phone's flag: the same flag, smaller, and never wider than a short name.
  ".cm-presence-label.cm-presence-label-compact": {
    padding: "0 4px",
    fontSize: "10px",
    maxWidth: `min(9em, var(${ROOM_PROPERTY}, 9em))`,
  },
  ".cm-presence-selection": {
    borderRadius: "3px",
  },
});

/**
 * This editor's own caret, going out to the room.
 *
 * Here rather than inline in `LiveEditor.web.tsx` for one reason: it runs
 * inside the update cycle, so it has to be impossible for it to throw, and a
 * guard that cannot be reached by a test is a guard nobody has checked. As an
 * exported extension it can be dispatched into a real `EditorState` with a
 * reporter that throws, and the document asserted to have changed anyway.
 *
 * `selectionSet || docChanged` rather than every update: a repaint, a scroll
 * and a remote caret all produce updates, and reporting on those would send a
 * frame for every keystroke of somebody else's typing.
 */
export function reportSelection(getReporter: () => Reporter | undefined): Extension {
  return EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return;
    const range = update.state.selection.main;
    try {
      getReporter()?.(range.anchor, range.head);
    } catch {
      // The room loses this position and the next movement replaces it. Nothing
      // about the document, the draft or the save path reads this call, so a
      // socket in a state nobody predicted costs a caret rather than the note.
    }
  });
}

/** Told where this editor's caret is. Never told what is in the document. */
export type Reporter = (anchor: number, head: number) => void;

/** The whole extension, for `editorExtensions` to include. */
export function remoteCarets(): Extension {
  return [caretState, caretDocument, caretLabels, caretDecorations, caretLabelTimer, caretFlagFit, caretTheme];
}
