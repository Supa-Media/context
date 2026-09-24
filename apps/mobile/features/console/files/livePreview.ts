/**
 * Live Preview — Obsidian's editing surface, and why it is this rather than a
 * block editor.
 *
 * The buffer **is** the Markdown. Nothing here parses the document into another
 * model and serializes it back; the decorations below only change how the text
 * that is already there is drawn. That is the whole argument for this approach
 * over a block editor (Yoopta, TipTap, Lexical), and it is two arguments:
 *
 *  - **Round-trip is lossless by construction.** There is no serializer, so
 *    there is nothing that can mangle an ASCII diagram, a raw HTML block, or a
 *    frontmatter key it has no node type for. `NoteEditor.tsx` used to say a
 *    WYSIWYG "can disagree with the file"; this keeps that true instead of
 *    reversing it.
 *  - **CodeMirror has no React peer.** A React DOM editor entering
 *    `apps/mobile`'s dependency tree is the exact move that broke native
 *    rendering twice in the sibling app, by pulling a second React into the
 *    lockfile and re-keying the Expo native-module graph onto it. The
 *    `reactResolution` guardrail in `__tests__/supa-framework.test.js` is what
 *    proves this stayed true; it is not a claim in a comment.
 *
 * ## The one behaviour that makes it feel right
 *
 * Markup hides when your cursor is elsewhere and comes back the instant you
 * enter it. `## Heading` renders as a heading until you click the line, and
 * then it is `## Heading` again — because you cannot edit syntax you cannot
 * see, and an editor that permanently hides its own markup is a block editor
 * with extra steps.
 *
 * The unit that reveals is the **whole containing node**, not the mark. Putting
 * the cursor between the asterisks of `**bold**` has to show you both pairs, or
 * the text jumps sideways as you arrow through it.
 *
 * ## Everything below the extension is pure
 *
 * `revealedRanges` and `decorationsFor` take a document, a tree and a selection
 * and return ranges. That is deliberate: this is the part with the interesting
 * edge cases — a selection spanning three nodes, a cursor exactly on a
 * boundary, a mark at the very end of the document — and it can be tested
 * without a browser, a renderer, or a mounted editor.
 */

/*
  MODULE MAP. This file is the facade: it re-exports every name it exported
  when it was one 4,985-line file, and nothing under `livePreview/` imports it.
  Imports point down this list, never up:

    language.ts      the GFM dialect, fence languages, fence highlight style
    frontmatter.ts   frontmatterRange/Block and the two frontmatter decorations
    reveal.ts        the inline reveal rule: hidden marks, reveal units,
                     selectionTouches, styleClassFor, wiki-link spans
    lists.ts         hanging indents, finished tasks, list glyphs, isTicked
    callouts.ts      callout detection and CalloutTitleWidget
    writingTable.ts  STATE: setWritingTable / writingTable (the table shown as
                     source), stopWritingTable, showTableSource
    engagement.ts    STATE: setEditorEngaged / editorEngaged, engageEditor,
                     revealSelection (the selection the reveal rule may use)
    cellText.ts      one table cell's Markdown as styled runs (cellRuns)
    tableModel.ts    TableGrid, readTable, tableGrids, alignmentsIn, tableLines
    gridDom.ts       STATE: drawnGrids (WeakMap) — painting, finding and
                     focusing drawn cells, focusGridCell
    cellEditing.ts   makeCellEditable, toggleMarkerInCell
    tableWidget.ts   TableGridWidget (the drawn, editable <table>)
    listWidgets.ts   BulletWidget, TaskWidget, taskToggle (one extension value)
    htmlPreview.ts   html-preview fences, previewDocument, HtmlPreviewWidget
    decorations.ts   decorationsFor — assembles every pass above, in order
    extension.ts     livePreview() — the extension array, gridRanges (WeakMap
                     cache); the decorations StateField is created per call
    styles/*.ts      consecutive slices of livePreviewStyles, joined below

  Each StateField, StateEffect, WeakMap and extension value is created once, in
  the module named above; moving each into its module changed no identity and
  no order. `__tests__/livePreviewModules.test.ts` holds all of this.
*/

export { markdownLanguage, fenceHighlightStyle, codeHighlighting } from "./livePreview/language";
export {
  hiddenMarkRanges,
  revealUnitFor,
  selectionTouches,
  styleClassFor,
  type TextRange,
} from "./livePreview/reveal";
export { frontmatterBlock, frontmatterRange } from "./livePreview/frontmatter";
export {
  completedTasks,
  hangingIndents,
  listGlyphs,
  type HangingIndent,
  type ListGlyph,
} from "./livePreview/lists";
export { CalloutTitleWidget, calloutLabel, callouts, type Callout } from "./livePreview/callouts";
export {
  alignmentsIn,
  tableGrids,
  tableLines,
  type CellAlign,
  type CellRun,
  type CellSpan,
  type TableGrid,
} from "./livePreview/tableModel";
export { TableGridWidget } from "./livePreview/tableWidget";
export { toggleMarkerInCell } from "./livePreview/cellEditing";
export { focusGridCell } from "./livePreview/gridDom";
export {
  HTML_PREVIEW_TAG,
  HtmlPreviewWidget,
  htmlPreviews,
  previewDocument,
  type HtmlPreview,
} from "./livePreview/htmlPreview";
export { showTableSource, stopWritingTable, writingTable } from "./livePreview/writingTable";
export { editorEngaged, engageEditor } from "./livePreview/engagement";
export { decorationsFor } from "./livePreview/decorations";
export { livePreview } from "./livePreview/extension";

import { formStyles } from "./livePreview/styles/forms";
import { imageStyles } from "./livePreview/styles/images";
import { tableStyles } from "./livePreview/styles/tables";
import { textStyles } from "./livePreview/styles/text";

/**
 * The heading ladder: the first slice of `livePreviewStyles`, kept in this
 * file because `__tests__/typeScale.test.ts` holds these ratios to the tokens by
 * reading `livePreview.ts` as text (the comment inside says so). The rest of
 * the sheet is in `./livePreview/styles/`, in its original order.
 */
const headingStyles = `
.cm-lp-h1, .cm-lp-h2, .cm-lp-h3, .cm-lp-h4, .cm-lp-h5, .cm-lp-h6 {
  font-weight: 600;
  color: var(--lp-heading);
  line-height: 1.3;
}
/*
  THE TYPE SCALE, RESTATED AS MULTIPLES OF THE BODY.

  30 / 23 / 19 against a 16px body, which is pointerType's title, h2 and h3
  exactly -- the scale this product already declares, arrived at here by
  division rather than by a second opinion.

  It was 1.625 / 1.3 / 1.15, measured off Obsidian mobile, and that was a third
  ladder: neither the tokens' nor the 1.7 / 1.4 / 1.2 it replaced. Two scales in
  one application is one of them being wrong wherever they meet, and where they
  met was the note -- a 30pt title in the tokens, a 26pt one on the page. The
  design canvas sides with the tokens.

  Literals rather than a custom property because these are ratios to the
  editor's own font size, which is what em means here. typeScale.test.ts holds
  them to tokens.ts by reading this file as text.

  (No backticks anywhere in this comment: it is inside a template literal and
  one would end the string. That is not hypothetical -- writing this comment
  with them is what broke the build a minute before it was rewritten.)
*/
.cm-lp-h1 { font-size: 1.875em; }
.cm-lp-h2 { font-size: 1.4375em; }
.cm-lp-h3 { font-size: 1.1875em; }
.cm-lp-h4, .cm-lp-h5, .cm-lp-h6 { font-size: 1.05em; }`;

/**
 * How the rendered document looks.
 *
 * Sizes and colours come from `features/design/tokens` via CSS custom
 * properties set on the wrapper, so this file states relationships (a heading
 * is 1.6× body) and the theme states values. Deliberately not a full typographic
 * system: this is a note editor, and a document that looks like a magazine is
 * harder to edit than one that looks like a document.
 */
export const livePreviewStyles = headingStyles + textStyles + tableStyles + formStyles + imageStyles;
