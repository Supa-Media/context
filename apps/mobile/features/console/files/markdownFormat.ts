/**
 * The formatting verbs, as CodeMirror commands over markdown source.
 *
 * `editorSetup.ts` already had three of these inline — `wrapSelection`,
 * `toggleLinePrefix`, `insertLink` — and they were right where they were while
 * the only thing that ran them was the accessory bar's six keys. They are here
 * now because two more surfaces want the same verbs and one of them wants a
 * dozen of them: a ⌘B/⌘I keymap, and a right-click menu over the note body on
 * the web console. A verb reached from three places and written in three places
 * is three behaviours with one name.
 *
 * Nothing here touches React, react-native or the DOM. Same rule as
 * `editorSetup.ts`, and for the same reason: this module is compiled twice —
 * by Metro for the browser and by esbuild into the committed iOS guest bundle
 * (`webview/bundle.generated.ts`) — so an import either bundler cannot follow
 * would break one of the two hosts, and the tests for it run in plain node.
 *
 * ## Why toggling, rather than inserting
 *
 * `wrapSelection` inserted a pair of markers and nothing took them off again.
 * That was survivable on a bar where Bold is one key among six and a mis-press
 * is undone with the undo key sitting beside it. It is not survivable on ⌘B,
 * because ⌘B is *the* chord people press twice — once to start a bold word and
 * once to end it — and an editor that answers the second press with `****bold**`
 * is an editor that punishes the most ordinary thing anybody does with it.
 *
 * So every marker verb here is a toggle, and the toggle is the *same* function
 * the bar's Bold key now runs. The bar did not ask for that, and it gets it
 * anyway, deliberately: two meanings of Bold on two surfaces is the drift
 * `editorSetup.ts`'s own header exists to prevent.
 */

import { EditorSelection, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { focusGridCell, toggleMarkerInCell } from "./livePreview";
import { planToggle, wordAround, type RangePlan } from "./markerToggle";

/*
  The marker pairs and their name type live in `markerToggle.ts`, beside the
  rule that applies them, so `livePreview.ts` can answer ⌘B in a table cell
  without importing this module — which imports it. Re-exported here because
  three surfaces already say `MARKERS` from this file.
*/
export { MARKERS, type MarkerName } from "./markerToggle";

/**
 * Bold, italic, strikethrough, an inline code span — the pair of markers around
 * the selection, on and off again.
 *
 * `changeByRange` rather than one dispatch per marker, because a document with
 * more than one cursor in it is an ordinary CodeMirror document and two
 * separate dispatches would apply the second against positions the first has
 * already moved.
 *
 * ## Why the ranges have to agree
 *
 * With three cursors, two inside bold text and one outside it, per-range
 * decisions produce a transaction that bolds one and unbolds two — a single
 * press leaving the document in a state nobody asked for and no second press
 * undoes. So the *document* decides once: markers come off only if **every**
 * range already has them, and otherwise every range gets them. That is the rule
 * a person can hold in their head ("it does the same thing everywhere"), and it
 * is the one that makes the second press the inverse of the first.
 */
export function toggleWrap(view: EditorView, before: string, after: string): void {
  /*
    A table cell first, when one has the caret. Focus is in a widget's own
    `contenteditable` there, so the document's selection is somewhere else
    entirely and toggling markers in it would bold a word nobody is looking
    at. `toggleMarkerInCell` runs the same decision over the cell's own text
    and says whether it took it.
  */
  if (toggleMarkerInCell(view, before, after)) return;
  const doc = view.state.doc.toString();
  const proposed = view.state.selection.ranges.map((range) =>
    planToggle(doc, range, before, after),
  );
  const removing = proposed.every((plan) => plan.removed);
  const plans = removing
    ? proposed
    : view.state.selection.ranges.map((range, index) =>
        proposed[index].removed ? planWrapOnly(doc, range, before, after) : proposed[index],
      );

  /*
    A counter rather than a lookup by identity: `changeByRange` visits
    `state.selection.ranges` in order, which is the order `plans` was built in,
    and an `indexOf` over ranges would answer the wrong index for a document
    holding two identical empty cursors.
  */
  let next = 0;
  view.dispatch(
    view.state.update(
      view.state.changeByRange(() => {
        const plan = plans[next];
        next += 1;
        return { changes: plan.changes, range: plan.range };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
}

/** The wrap half of `planToggle`, for a range overruled by the ones beside it. */
function planWrapOnly(
  doc: string,
  original: SelectionRange,
  before: string,
  after: string,
): RangePlan {
  const range = wordAround(doc, original);
  return {
    changes: [
      { from: range.from, insert: before },
      { from: range.to, insert: after },
    ],
    range: EditorSelection.range(range.from + before.length, range.to + before.length),
    removed: false,
  };
}

/**
 * A blank GFM table, `rows` body rows by `cols` columns, with the caret in the
 * first header cell — of the drawn grid where there is one, which is what the
 * returned boolean reports.
 *
 * ## Why it is padded with spaces
 *
 * `|  |  |` is a valid table and it is unreadable in the source. That used to
 * be what the author was looking at while they filled it in; it is not any
 * more — the grid is drawn while the note is being written and the cells are
 * typed into directly (`livePreview.ts`). The padding stays anyway, for the
 * reader this product cannot see: the file is open in Obsidian, in a text
 * editor and in `git diff`, and three spaces is the width of the `---` under
 * it, so an empty table's columns line up in the monospace face and stay lined
 * up for a cell of up to three characters.
 *
 * ## Why it may insert two newlines before itself
 *
 * A GFM table cannot interrupt a paragraph — a delimiter row directly under a
 * line of prose is parsed as more prose, and what the person gets for their
 * trouble is a row of pipes in the middle of a sentence. So a table asked for
 * on a line that already has text is put *after* that paragraph, with the blank
 * line the grammar requires. On an empty line it lands where the caret is.
 */
export function insertTable(view: EditorView, rows: number, cols: number): boolean {
  /*
    Refused here rather than left to `EditorState.readOnly` to drop the
    transaction. It always did drop it, but the caret this command places
    afterwards is computed from a table that was never inserted, and pointing a
    selection past the end of the document throws.
  */
  if (view.state.readOnly) return false;
  const columns = Math.max(1, Math.trunc(cols));
  const bodyRows = Math.max(0, Math.trunc(rows));

  const blank = `| ${Array.from({ length: columns }, () => "   ").join(" | ")} |`;
  const rule = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
  const table = [blank, rule, ...Array.from({ length: bodyRows }, () => blank)].join("\n");

  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const lead = line.text.trim() === "" ? "" : "\n\n";
  const at = lead === "" ? head : line.to;

  view.dispatch(
    view.state.update(
      {
        changes: { from: at, to: at, insert: `${lead}${table}\n` },
        /*
          Past the table's own last character, so the grid is drawn: the end
          of a table's last line is where the keystroke that made it a table
          leaves the caret, and `writingTable` reads that as a table being
          written and shows its source. One character further on is the line
          below, which is where somebody who asked for a finished table is. The caret is then put in the grid's first cell
          below, and only a surface with no grid falls back to the position
          this command used before there were any — two characters past the
          opening pipe, which is the first header cell's own text.
        */
        selection: EditorSelection.cursor(at + lead.length + table.length + 1),
      },
      { scrollIntoView: true, userEvent: "input" },
    ),
  );

  /*
    After the dispatch, because the grid is drawn by the transaction this
    command just made: CodeMirror updates its DOM synchronously, so the cell
    exists by the time this line runs.

    Returned rather than swallowed, and the caller has to care: the menu that
    ran this used to call `view.focus()` straight afterwards, which is right
    when the caret is in the document and takes it out of the cell when it is
    not. Pinned by the WebKit spec, which typed into a grid nobody was in.
  */
  if (focusGridCell(view, at + lead.length, -1, 0)) return true;

  /*
    No grid: a surface without Live Preview, or a table it refused. The caret
    goes where it went before there were grids — two characters past the
    opening pipe, which is the first header cell's own text. The dispatch above
    left it after the table, because `tableGrids` undraws the table the
    document's caret is inside and the whole point of the line above is that
    there is a cell to put the caret in.
  */
  view.dispatch({ selection: EditorSelection.cursor(at + lead.length + 2) });
  return false;
}
