import {
  Annotation,
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { joinDictated } from "../../voice/dictation";

/**
 * Dictation inside the editor: where settled words go, and where the guess that
 * is not yet words is drawn.
 *
 * ## The guess is a decoration, and that is the whole design
 *
 * `features/voice/dictation.ts` guarantees that no unsettled phrase is ever
 * handed to this file as an insert. This file guarantees the other half: the
 * phrase that *is* drawn on screen while somebody is mid-sentence lives in a
 * `StateField` and a widget, not in the document — so there is no arrangement
 * of a crash, an autosave timer firing, a note being closed, or a conflict
 * resolver reading the buffer that can write it into the customer's bucket.
 * `state.doc` simply never contains it.
 *
 * That is stronger than "we remember to remove it before saving", which is what
 * an implementation that inserted grey text and deleted it again would be
 * relying on. `autosave.ts` writes on a 15-second ceiling *because* dictation
 * never pauses; an interim in the buffer would be caught by that ceiling within
 * one sentence.
 *
 * ## The run, and why Discard needs one
 *
 * Stop keeps what was said. Discard takes it back — not just the pending
 * phrase, the whole dictated run, which is what somebody means when they speak
 * three sentences, read them, and decide they were talking themselves in a
 * circle. So the extent of what this dictation has inserted is tracked as a
 * range that maps through every later change.
 *
 * **It is given up the moment somebody types inside it.** A run that has been
 * edited by hand is no longer the machine's to take back: deleting it would
 * take their correction with it. Typing *beside* it is fine and deliberately
 * does not count — the boundary test is strict overlap, so a sentence typed
 * after the dictated one leaves Discard working.
 */

/**
 * Marks a transaction as this feature's own.
 *
 * Without it the run field cannot tell its own insert from a keystroke, and
 * every dictated phrase would look like the hand-editing that invalidates the
 * run.
 */
export const dictation = Annotation.define<"insert" | "undo">();

/** Set the guess being drawn at the caret. `""` draws nothing. */
export const showInterim = StateEffect.define<string>();

/** Forget the current run without touching the document. */
export const endRun = StateEffect.define<null>();

export interface DictationRun {
  from: number;
  to: number;
}

/**
 * Which side of an insertion *at the run's own edge* the edge stays on.
 *
 * Both edges map outward-exclusive: `from` moves to after anything inserted at
 * it, `to` stays before anything inserted at it. So text typed hard against
 * either end of a dictated run is not inside it, and Discard does not take it.
 *
 * This is written as two named constants rather than two magic numbers because
 * getting it backwards is silent: the run merely grows a little, Discard
 * deletes a sentence somebody typed, and nothing anywhere throws. It was
 * backwards in the first version of this file and `typing after the run leaves
 * Discard working` is what found it.
 */
const EDGE_FROM = 1;
const EDGE_TO = -1;

/**
 * The guess, as state.
 *
 * A field rather than a plugin-local variable so it survives reconfiguration
 * and so the decoration can be computed from it declaratively — and so a test
 * can read it off `EditorState` without a DOM.
 */
export const interimField = StateField.define<string>({
  create: () => "",
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(showInterim)) return effect.value;
    return value;
  },
});

export const dictationRun = StateField.define<DictationRun | null>({
  create: () => null,
  update(run, tr) {
    for (const effect of tr.effects) if (effect.is(endRun)) return null;
    if (!tr.docChanged) return run;

    if (tr.annotation(dictation) === "insert") {
      let from = -1;
      let to = -1;
      tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        if (from < 0 || fromB < from) from = fromB;
        if (toB > to) to = toB;
      });
      if (from < 0) return run;
      if (run === null) return { from, to };
      return {
        from: Math.min(tr.changes.mapPos(run.from, EDGE_FROM), from),
        to: Math.max(tr.changes.mapPos(run.to, EDGE_TO), to),
      };
    }

    if (run === null) return null;
    /*
      Somebody else changed the document. Strict overlap, not adjacency: an
      insertion at exactly `run.to` is the next sentence being typed after a
      dictated one, and taking the run back later still leaves it whole. An
      insertion *inside* the run, or a deletion crossing either edge, is a
      correction — and a Discard that swallowed it would be this feature
      deleting something a person typed.
    */
    let edited = false;
    tr.changes.iterChangedRanges((fromA, toA) => {
      if (toA > run.from && fromA < run.to) edited = true;
    });
    if (edited) return null;
    return { from: tr.changes.mapPos(run.from, EDGE_FROM), to: tr.changes.mapPos(run.to, EDGE_TO) };
  },
});

class InterimWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: InterimWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-dictation-interim";
    span.textContent = this.text;
    /*
      Hidden from assistive technology on purpose, and it is not an oversight
      to be fixed later. This text is replaced four or five times a second; an
      `aria-live` region on it would read a screen-reader user the same
      half-sentence over and over and drown the document. What *does* get
      announced is the settled text, because that goes into the buffer and the
      editor announces its own changes.
    */
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  /** It is not in the document, so the caret must not be placeable inside it. */
  ignoreEvent() {
    return true;
  }
}

const interimDecoration = EditorView.decorations.compute(
  [interimField, "selection"],
  (state): DecorationSet => {
    const text = state.field(interimField, false) ?? "";
    if (text === "") return Decoration.none;
    const at = state.selection.main.head;
    return Decoration.set([
      Decoration.widget({ widget: new InterimWidget(text), side: 1 }).range(at),
    ]);
  },
);

/** Everything this feature adds to an editor. Mounted by `editorExtensions`. */
export function dictationExtension(): Extension {
  return [interimField, dictationRun, interimDecoration];
}

/**
 * Put a settled phrase in the document at the caret.
 *
 * Read-only is checked here as well as by `editability`'s change filter and by
 * `acceptsCommand` on the wire, for the reason `runCommand` states at length: a
 * refused transaction is still a transaction, and one dispatched per phrase
 * would fill the undo history of a note nobody may type in.
 */
export function insertDictated(view: EditorView, phrase: string): void {
  if (view.state.readOnly) return;
  const range = view.state.selection.main;
  const before = view.state.sliceDoc(Math.max(0, range.from - 1), range.from);
  const insert = joinDictated(before, phrase);
  if (insert === "") return;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
    scrollIntoView: true,
    annotations: [dictation.of("insert"), Transaction.userEvent.of("input.dictate")],
  });
}

/** Draw the current guess. Never a document change. */
export function drawInterim(view: EditorView, text: string): void {
  if (view.state.readOnly && text !== "") return;
  view.dispatch({ effects: showInterim.of(text) });
}

/**
 * Take back everything this run inserted.
 *
 * Answers whether it did, so the caller can tell somebody that a run they had
 * edited by hand was left alone rather than silently doing nothing.
 */
export function takeBackRun(view: EditorView): boolean {
  const run = view.state.field(dictationRun, false) ?? null;
  if (run === null || run.to <= run.from) return false;
  if (view.state.readOnly) return false;
  view.dispatch({
    changes: { from: run.from, to: run.to, insert: "" },
    selection: EditorSelection.cursor(run.from),
    effects: [endRun.of(null), showInterim.of("")],
    annotations: dictation.of("undo"),
  });
  return true;
}
