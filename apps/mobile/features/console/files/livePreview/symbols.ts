/**
 * Show Markdown, and the editor that never shows it.
 *
 * Owner, 2026-11-08: "instead of exposing a lot of markdown details, we make
 * it a regular editor that supports markdown." So with Show Markdown off,
 * which is the default (Settings › Writing), the reveal rule stops at the
 * caret: entering bold does not bring its `**` back, a heading never shows its
 * `#`, a link never shows its address. The words are what is on screen, and
 * the buffer is still the same Markdown. Typing a shortcut (`**word**`,
 * `# `) turns into the formatting the moment it is complete, because nothing
 * reveals it again.
 *
 * Three things follow from the marks staying hidden, and live here:
 *
 *  - **The setting itself**, a state field the host sets. A state with no
 *    field (every bare unit test, any surface that never says) behaves as Show
 *    Markdown on, which is the rule as it always was.
 *  - **Backspace and Delete act on the letter you can see.** Without this, a
 *    Backspace after bold eats one `*` you cannot see and the word falls apart
 *    into `**basil*`. Instead it skips the hidden marks and deletes the `l`, a
 *    word's last letter takes its marks with it, and Backspace at the start of
 *    a heading's words makes it a paragraph.
 *  - **Hidden marks are atomic**, so an arrow key or a tap cannot leave the
 *    caret between two asterisks, where typing would write symbols.
 *
 * Kept in step by `decorationsFor`, which reads `markSelection` wherever a
 * mark's reveal follows the caret.
 */

import {
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  findClusterBreak,
  type TransactionSpec,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { revealSelection } from "./engagement";

export const setMarkdownShown = StateEffect.define<boolean>();

/**
 * Whether Markdown's symbols are shown under the caret. The host installs it
 * with `markdownShown.init(() => setting)` and changes it with
 * `setMarkdownShown`; the default here is the product's, off.
 */
export const markdownShown = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarkdownShown)) return effect.value;
    return value;
  },
});

/** True when this editor hides Markdown's symbols even under the caret. */
export function symbolsHidden(state: EditorState): boolean {
  return state.field(markdownShown, false) === false;
}

/** The selection a mark's reveal follows: none at all while symbols are hidden. */
export function markSelection(state: EditorState): Array<{ from: number; to: number }> {
  return symbolsHidden(state) ? [] : revealSelection(state);
}

type Range = { from: number; to: number };

/** Inline constructs that are nothing but their marks once their last letter goes. */
const EMPTIED: ReadonlySet<string> = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "Highlight",
  "Underline",
  "InlineCode",
  "Link",
]);

/**
 * The deletion a Backspace (`back`) or Delete at `at` should make while
 * symbols are hidden, given the hidden ranges, or null to leave it as it was.
 */
export function visibleDeletion(
  state: EditorState,
  hidden: readonly Range[],
  at: number,
  back: boolean,
): Range | null {
  const tree = syntaxTree(state);
  let pos = at;
  for (;;) {
    const mark = hidden.find((range) => (back ? range.from < pos && range.to >= pos : range.from <= pos && range.to > pos));
    if (mark === undefined) break;
    // A heading's `# ` at the start of its line: Backspace there unmakes the heading.
    if (back && tree.resolveInner(mark.from, 1).name === "HeaderMark" && state.doc.lineAt(mark.from).from === mark.from) {
      return { from: mark.from, to: mark.to };
    }
    pos = back ? mark.from : mark.to;
  }
  const line = state.doc.lineAt(pos);
  let target: Range;
  if (back) {
    if (pos === 0) return null;
    target = pos === line.from ? { from: pos - 1, to: pos } : { from: findClusterBreak(line.text, pos - line.from, false) + line.from, to: pos };
  } else {
    if (pos === state.doc.length) return null;
    target = pos === line.to ? { from: pos, to: pos + 1 } : { from: pos, to: findClusterBreak(line.text, pos - line.from, true) + line.from };
  }
  if (hidden.some((range) => range.from < target.to && range.to > target.from)) return null;

  return emptied(state, hidden, target) ?? target;
}

/**
 * The whole construct, when `range` is all that is left of its words: the
 * last letter of a bold word takes the bold with it, rather than leave `****`
 * on screen.
 */
export function emptied(state: EditorState, hidden: readonly Range[], range: Range): Range | null {
  const tree = syntaxTree(state);
  for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(range.from, 1); node !== null; node = node.parent) {
    if (!EMPTIED.has(node.name)) continue;
    if (node.from > range.from || node.to < range.to) return null;
    const unhidden = visibleLength(node.from, node.to, hidden);
    return unhidden > 0 && unhidden <= visibleLength(range.from, range.to, hidden) ? { from: node.from, to: node.to } : null;
  }
  return null;
}

function visibleLength(from: number, to: number, hidden: readonly Range[]): number {
  let length = to - from;
  for (const range of hidden) {
    const start = Math.max(from, range.from);
    const end = Math.min(to, range.to);
    if (end > start) length -= end - start;
  }
  return length;
}

/**
 * Backspace and Delete, retargeted onto the letter on screen. A transaction
 * filter rather than a key binding, because a phone's keyboard deletes through
 * the page as often as through a key event, and both arrive here as one
 * `delete` transaction removing a character beside the caret.
 */
export function symbolDeletes(hiddenOf: (state: EditorState) => readonly Range[]) {
  return EditorState.transactionFilter.of((transaction: Transaction): Transaction | TransactionSpec => {
    if (!transaction.docChanged || !transaction.isUserEvent("delete")) return transaction;
    const start = transaction.startState;
    if (!symbolsHidden(start) || start.selection.ranges.length !== 1 || !start.selection.main.empty) return transaction;
    let removed: Range | null = null;
    let inserted = false;
    let count = 0;
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
      count += 1;
      removed = { from: fromA, to: toA };
      if (text.length > 0) inserted = true;
    });
    if (count !== 1 || inserted || removed === null) return transaction;
    const { from, to } = removed as Range;
    const caret = start.selection.main.head;
    if (caret !== to && caret !== from) return transaction;
    const hidden = hiddenOf(start);
    const deletion = hidden.some((range) => range.from < to && range.to > from)
      ? visibleDeletion(start, hidden, caret, caret === to)
      : emptied(start, hidden, { from, to });
    if (deletion === null) return transaction;
    return {
      changes: { from: deletion.from, to: deletion.to },
      selection: EditorSelection.cursor(deletion.from),
      userEvent: transaction.annotation(Transaction.userEvent) ?? "delete",
      scrollIntoView: true,
    };
  });
}

/** Every hidden mark in a decoration set, as atomic ranges, while symbols are hidden. */
export function symbolAtoms(decorations: (state: EditorState) => DecorationSet, isHiddenMark: (value: Decoration) => boolean) {
  return EditorView.atomicRanges.of((view) => {
    const builder = new RangeSetBuilder<Decoration>();
    if (!symbolsHidden(view.state)) return builder.finish();
    decorations(view.state).between(0, view.state.doc.length, (from, to, value) => {
      if (from < to && isHiddenMark(value)) builder.add(from, to, value);
    });
    return builder.finish();
  });
}

/** The hidden marks of a decoration set, in document order. */
export function hiddenRangesOf(set: DecorationSet, length: number, isHiddenMark: (value: Decoration) => boolean): Range[] {
  const out: Range[] = [];
  set.between(0, length, (from, to, value) => {
    if (from < to && isHiddenMark(value)) out.push({ from, to });
  });
  return out;
}
