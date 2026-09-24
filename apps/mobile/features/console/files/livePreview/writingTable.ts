/**
 * `writingTable`: the one table whose source is shown rather than drawn as a
 * grid, and the effects that set and clear it.
 *
 * Defined exactly once, here. Part of the Live Preview extension;
 * `../livePreview.ts` is the facade that re-exports the public names and holds
 * the module map.
 */

import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

/**
 * THE TABLE SOMEBODY IS TYPING, WHICH IS THE ONE THAT IS NOT DRAWN.
 *
 * Found in a browser and by nothing else: a table becomes a table the moment
 * `| - | - |` parses, which is in the *middle* of typing the delimiter row.
 * The grid was drawn over the two lines, the caret was left at the end of a
 * line that is no longer on screen, and the rest of what the person typed went
 * in somewhere they could not see. Measured: `| --- | --- |` finished as
 * `-- |` on its own line with a two-column grid above it.
 *
 * So one table gives way, and it is identified rather than inferred from where
 * the caret is. Position alone cannot answer this: a caret at the end of the
 * delimiter row and a caret parked there by Escape are the same number, and
 * they want opposite answers.
 *
 * - A **document change** with the caret in a table says that table is being
 *   written. That is the keystroke case and nothing else produces it, because
 *   `atomicRanges` means the caret cannot walk into a drawn one.
 * - A **selection that leaves it** puts it back. Clicking away, arrowing out,
 *   anything deliberate.
 * - An **effect** puts it back explicitly, for the two gestures that hand the
 *   table over rather than leave it: Escape out of a cell, and a cell taking
 *   focus.
 *
 * Arrowing *within* the source keeps it revealed, which is the same courtesy
 * every other construct in this file extends to the thing you are editing.
 */
const setWritingTable = StateEffect.define<number | null>();

/** Stop revealing the source of whatever table was being written. */
export function stopWritingTable() {
  return setWritingTable.of(null);
}

/**
 * Show one table as its own pipes, because somebody asked to edit it as text.
 *
 * The same state a table being typed is in, reached deliberately from the
 * table's own menu. It is the escape hatch for everything the controls have
 * no verb for, and without it a drawn table is a block a person cannot get
 * inside: `atomicRanges` keeps the caret out, so there would be no way to
 * repair a table the grid draws but nobody meant.
 */
export function showTableSource(from: number) {
  return setWritingTable.of(from);
}

/**
 * Whether the caret is *in* a table rather than beside it.
 *
 * Asymmetric, and both halves were found by a test rather than reasoned out.
 * The first character is where arriving from above leaves you and where
 * `openingCaret` parks, so a caret there is before the table. The last is
 * where the keystroke that made these lines a table leaves you, so a caret
 * there is in it.
 */
function inTable(head: number, table: { from: number; to: number }): boolean {
  return head > table.from && head <= table.to;
}

/** The `Table` node covering `pos`, ends included. */
function tableAround(state: EditorState, pos: number): { from: number; to: number } | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    for (; node !== null; node = node.parent) {
      if (node.name === "Table") return { from: node.from, to: node.to };
    }
  }
  return null;
}

export const writingTable = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWritingTable)) return effect.value;
    }
    if (transaction.state.readOnly) return null;

    if (transaction.docChanged) {
      /*
        The caret after the change, not before it: the character just typed is
        what may have made these lines a table, and the node is read from the
        state that has it.

        Two conditions beyond "a table is there", and each answers a case that
        got this wrong. The change has to **touch the table**, or an edit
        somewhere else in the note would reveal a table the caret happens to
        sit at the start of — `openingCaret` parks at the first line, which on
        plenty of notes is a table's own first character. And the caret has to
        be **past** that first character: arriving at a table from above is
        being beside it, while the end of its last line is where the keystroke
        that made it one leaves you.
      */
      const head = transaction.state.selection.main.head;
      const table = tableAround(transaction.state, head);
      if (
        table !== null &&
        inTable(head, table) &&
        transaction.changes.touchesRange(table.from, table.to) !== false
      ) {
        return table.from;
      }
    }

    const at = value === null ? null : transaction.changes.mapPos(value, -1);
    if (at === null) return null;
    if (!transaction.selection && !transaction.docChanged) return at;

    const table = tableAround(transaction.state, at);
    if (table === null) return null;
    return inTable(transaction.state.selection.main.head, table) ? table.from : null;
  },
});
