/**
 * `livePreview()`: the extension array the editor installs, and the memoised
 * table ranges its atomic-range facet reads.
 *
 * The array's order and every object in it are unchanged: `editorEngaged`,
 * `writingTable` and `taskToggle` are the single instances their own modules
 * create, and the decorations field is still defined per call, as before.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import { RangeSet, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { imageSelection } from "../imageBlock";
import { decorationsFor } from "./decorations";
import { editorEngaged, setEditorEngaged } from "./engagement";
import { frontmatterRange } from "./frontmatter";
import { taskToggle } from "./listWidgets";
import { tableGrids } from "./tableModel";
import { writingTable } from "./writingTable";

/**
 * The tables a caret steps over, as a range set.
 *
 * The frontmatter is excluded the same way `decorationsFor` excludes it, and
 * for the same reason: nothing in a note's metadata is a table, and a caret
 * that could not enter the block would be a caret that could not fix it.
 *
 * Memoised on the state, because this is a facet CodeMirror reads on **cursor
 * motion** rather than on a transaction: every arrow key asks it, more than
 * once, and the honest implementation reads the whole document as a string and
 * walks the tree. One answer per state is the same work `decorationsFor`
 * already does once, rather than a document scan per keypress in a long note.
 */
const gridRangeCache = new WeakMap<EditorState, RangeSet<Decoration>>();

function gridRanges(state: EditorState): RangeSet<Decoration> {
  const cached = gridRangeCache.get(state);
  if (cached !== undefined) return cached;
  const front = frontmatterRange(state.doc.toString());
  const ranges = RangeSet.of(
    tableGrids(state, front === null ? 0 : front.to).map((grid) => ({
      from: grid.from,
      to: grid.to,
      value: Decoration.mark({}),
    })),
    true,
  );
  gridRangeCache.set(state, ranges);
  return ranges;
}

/**
 * The extension: recompute whenever the answer can have changed.
 *
 * A `StateField` rather than a `ViewPlugin` because the decorations depend on
 * the selection, and a view plugin that maps its own decorations through
 * transactions would have to invalidate them on every cursor move anyway —
 * which is the entire workload. Recomputing from the tree is simpler and is
 * what makes `decorationsFor` a pure function worth testing.
 *
 * ## The three inputs, and the one that was missed
 *
 * `decorationsFor` reads exactly three things out of the state: the document,
 * the selection, and **`readOnly`**. The first two are what a transaction
 * obviously carries. The third is configuration, and it changes by a route that
 * carries neither — `LiveEditor`'s compartment swapping `editability(…)` when
 * the eye is pressed — so a guard of "document or selection" let the whole of
 * reading mode go stale.
 *
 * On screen that was the bug this comment exists for: **pressing the eye did
 * nothing until you clicked into the note.** A form fence stayed as its own
 * source, a table stayed as its pipes, and the markup a reader is not supposed
 * to see stayed revealed — all of it correct again the instant any click
 * produced a selection transaction and the cached set was finally thrown away.
 *
 * `readOnly` is compared rather than `transaction.reconfigured` being trusted,
 * and the difference is not pedantry in both directions:
 *
 *  - A reconfigure that leaves `readOnly` alone cannot change a decoration, and
 *    rebuilding the whole set from the tree is the work this field does per
 *    keystroke. Redoing it for an unrelated facet is waste on the hottest path
 *    here.
 *  - More importantly it says *what is actually being watched*. A fourth input
 *    added to `decorationsFor` later is a line to add here, and a condition
 *    naming `readOnly` is one somebody reads and notices; `reconfigured` is one
 *    that looks like it already covers everything and does not.
 */
export function livePreview() {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => decorationsFor(state),
    update(value, transaction) {
      const readOnlyChanged = transaction.startState.readOnly !== transaction.state.readOnly;
      /*
        Engagement, which is the fourth input and arrives by its own route: a
        transaction carrying only `setEditorEngaged` changes no document, no
        selection and no `readOnly`, so without this the whole document would
        stay as it was drawn when nobody was in it — clicking into a note would
        put a caret in markup that never came back.
      */
      const focusChanged =
        transaction.startState.field(editorEngaged, false) !==
        transaction.state.field(editorEngaged, false);
      /*
        And the tree, which arrives late on a note of any size. CodeMirror parses
        the first few thousand characters synchronously and finishes the rest on
        an idle callback, announcing it with a transaction that carries no
        document change, no selection and no change of `readOnly` — the third
        input, by a fourth route. Without this a reader scrolling past roughly
        the first screen of a long note finds raw markdown below it until a
        click, which is the same symptom the `readOnly` comparison above was
        added to kill.

        Identity, not contents: the language state hands back a new `Tree` when
        it has parsed further, and the same one otherwise.
      */
      const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
      /*
        And which image is selected, which arrives by a fifth route and is the
        reason clicking a picture did nothing at all for a day: `selectImage`
        carries no document change, no selection, no `readOnly` and no new
        tree, so this gate held the old decorations and the toolbar was never
        drawn. The effect was reaching the field; the field was reaching
        nothing.
      */
      const pickChanged =
        transaction.startState.field(imageSelection, false) !==
        transaction.state.field(imageSelection, false);
      if (
        !transaction.docChanged &&
        !transaction.selection &&
        !readOnlyChanged &&
        !treeChanged &&
        !focusChanged &&
        !pickChanged
      ) {
        return value;
      }
      return decorationsFor(transaction.state);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
  // The one place this extension is more than decorations: a drawn checkbox has
  // to answer a press. See `taskToggle`.
  return [
    editorEngaged,
    // The table being typed, which is the only one not drawn as a grid.
    writingTable,
    /*
      A drawn table is one object rather than a run of characters — the same
      sentence `imageBlock.ts` makes about a row of images, and it matters more
      here because the grid is drawn while the note is editable: without this,
      arrowing down into a table walks an invisible caret through three lines of
      pipes that are not on screen. With it the caret steps over the whole
      table, and a selection takes it whole, so Backspace deletes the table
      rather than a character of markup nobody can see.
    */
    EditorView.atomicRanges.of((view) => gridRanges(view.state)),
    /*
      Focus opens the gate and never closes it — see `editorEngaged`. Tabbing
      into the editor is somebody arriving to write, and a blur is a popover,
      not a departure.
    */
    EditorView.focusChangeEffect.of((_state, focusing) =>
      focusing ? setEditorEngaged.of(true) : null,
    ),
    decorations,
    taskToggle,
  ];
}
