/**
 * The editor's half of the Link sheet: hold the selection while the sheet is
 * open, then write the chosen link over it — or put it back untouched.
 *
 * ## Why the selection is held here and not read again at the end
 *
 * Between the key press and the pick, the selection is not safe where it is.
 * On a phone the sheet's field takes the keyboard, so the editor loses focus;
 * on iOS the choice arrives over the bridge some time later; and in a shared
 * note somebody else can type above the words in the meantime. So the ranges
 * are saved in a state field at the press and **mapped through every change**
 * until the pick, and a range whose words no longer match what was selected is
 * left alone rather than overwritten — a link written over text the person did
 * not choose is worse than no link.
 *
 * The field is installed on first use (`StateEffect.appendConfig`) rather
 * than added to `editorExtensions`, so nothing about an editor that never
 * opens the sheet changes, and this file is the whole of the feature on the
 * editor's side.
 *
 * ## Several cursors
 *
 * Every non-empty range is linked, each with its own words as the label, in
 * one transaction — the same "more than one cursor is an ordinary document"
 * rule `wrapSelection` and `insertLink` follow in `editorSetup.ts`. The sheet
 * names the main range's words; the others follow.
 */

import { EditorSelection, StateEffect, StateField, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { linkableLabel, linkMarkdown, type LinkTarget } from "./linkMarkdown";

interface SavedRange {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface Pending {
  readonly ranges: readonly SavedRange[];
  /** The whole selection as it was, for Cancel. */
  readonly selection: EditorSelection;
}

const setPending = StateEffect.define<Pending | null>();

const pendingLink = StateField.define<Pending | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setPending)) return effect.value;
    if (value === null || tr.changes.empty) return value;
    return {
      // `from` leans right and `to` left, so text typed at either edge is not
      // pulled inside the saved words — it would then fail the match below.
      ranges: value.ranges.map((range) => ({
        from: tr.changes.mapPos(range.from, 1),
        to: tr.changes.mapPos(range.to, -1),
        text: range.text,
      })),
      selection: value.selection.map(tr.changes),
    };
  },
});

/** The saved request, if the sheet is open over this editor. */
function pending(view: EditorView): Pending | null {
  return view.state.field(pendingLink, false) ?? null;
}

/**
 * The words the sheet will link, or `null` when it should not open.
 *
 * `null` for an empty selection (the key's old behaviour stands) and for words
 * no link can hold (`linkableLabel`). The main range is named when it has
 * words; otherwise the first range that does.
 */
export function selectedLinkText(view: EditorView): string | null {
  const { state } = view;
  const ranges = state.selection.ranges.filter((range) => !range.empty);
  if (ranges.length === 0) return null;
  const texts = ranges.map((range) => state.sliceDoc(range.from, range.to));
  if (!texts.every(linkableLabel)) return null;
  const main = state.selection.main;
  return main.empty ? texts[0] : state.sliceDoc(main.from, main.to);
}

/**
 * Save the selection and ask for a link. `false` when there is nothing to
 * link, and the caller carries on with the key's ordinary behaviour.
 */
export function requestLink(view: EditorView, ask: (text: string) => void): boolean {
  const text = selectedLinkText(view);
  if (text === null) return false;
  const { state } = view;
  const saved: Pending = {
    ranges: state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => ({ from: range.from, to: range.to, text: state.sliceDoc(range.from, range.to) })),
    selection: state.selection,
  };
  // Two dispatches the first time: a field added by a transaction starts from
  // `create` and does not see that transaction's other effects.
  if (state.field(pendingLink, false) === undefined) {
    view.dispatch({ effects: StateEffect.appendConfig.of(pendingLink) });
  }
  view.dispatch({ effects: setPending.of(saved) });
  ask(text);
  return true;
}

/**
 * Write the chosen link over every saved range whose words are still there,
 * and put the caret after each. A no-op when nothing was asked for.
 */
export function applyLink(view: EditorView, target: LinkTarget): void {
  const saved = pending(view);
  if (saved === null) return;
  const { doc } = view.state;
  const kept = saved.ranges.filter(
    (range) => range.from < range.to && doc.sliceString(range.from, range.to) === range.text,
  );
  const changes: ChangeSpec[] = kept.map((range) => ({
    from: range.from,
    to: range.to,
    insert: linkMarkdown(range.text, target),
  }));
  if (changes.length === 0) {
    cancelLink(view);
    return;
  }
  const set = view.state.changes(changes);
  view.dispatch({
    changes: set,
    selection: EditorSelection.create(kept.map((range) => EditorSelection.cursor(set.mapPos(range.to, 1)))),
    effects: setPending.of(null),
    scrollIntoView: true,
    userEvent: "input",
  });
}

/** Close the request and put the selection back exactly as it was. */
export function cancelLink(view: EditorView): void {
  const saved = pending(view);
  if (saved === null) return;
  view.dispatch({ selection: saved.selection, effects: setPending.of(null) });
}
