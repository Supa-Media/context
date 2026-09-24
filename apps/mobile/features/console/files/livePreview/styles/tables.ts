/**
 * Tables: the monospace fallback, the laid-out grid, its editing chrome and
 * menus, and the horizontal rule that follows them in the sheet.
 *
 * One consecutive slice of `livePreviewStyles`, moved out of `livePreview.ts`
 * verbatim and in its original order; `../../livePreview.ts` joins the slices
 * back into the identical string. Order matters to the cascade, so a rule is
 * never moved between slices.
 */
export const tableStyles = `
/*
  AN EDITABLE table is not laid out — the pipes are still the author's — but it
  is drawn in the mono face, which is what makes the columns of a table that
  fits line up. A reader gets the grid below instead. See tableLines and
  tableGrids.
*/
.cm-lp-table {
  font-family: var(--lp-mono);
  font-size: 0.86em;
}
.cm-lp-table-delim { color: var(--lp-muted); }
/*
  A TABLE, LAID OUT FOR A READER.

  Hairlines and nothing else: no outer box, no fill, no zebra. A table in a
  note is part of the document rather than a panel sitting on it, and every
  edge spent here is an edge competing with the note's own structure. What
  separates the header from the body is one stronger rule, which is the only
  place this needs weight.

  The scroller is the wrapper, so a table wider than the measure scrolls in its
  own box rather than dragging the whole note sideways.
*/
.cm-lp-grid {
  overflow-x: auto;
  margin: 0.4em 0;
}
.cm-lp-grid-table {
  border-collapse: collapse;
  /*
    Sized by its content rather than stretched to the measure. A two-column
    table pushed to full width puts a hand-span of nothing between the label
    and its value, which is harder to read than the pipes were.
  */
  width: auto;
  max-width: 100%;
  font-size: 0.94em;
  line-height: 1.5;
  /* Digits in a column line up, which is most of why a column of them exists. */
  font-variant-numeric: tabular-nums;
}
.cm-lp-grid-table th {
  font-weight: 600;
  color: var(--lp-heading);
  text-align: left;
  padding: 7px 14px 8px;
  border-bottom: 1px solid var(--lp-line-strong);
  /*
    A header is a label, and a label that wraps to two lines over a one-line
    column is the table drawing attention to its own chrome.
  */
  white-space: nowrap;
}
.cm-lp-grid-table td {
  padding: 8px 14px;
  border-top: 1px solid var(--lp-line);
  vertical-align: top;
  color: var(--lp-content);
}
/*
  The outer columns lose their side padding, so the grid's own edges line up
  with the paragraph above it. Without this a table reads as indented from the
  text around it by however much cell padding happens to be, which is the one
  thing that gives away a rendered block as a rendered block.
*/
.cm-lp-grid-table tr > :first-child { padding-left: 0; }
.cm-lp-grid-table tr > :last-child { padding-right: 0; }
/*
  Scoped to the table rather than left as bare classes, because the header's
  own rule above sets text-align and was winning on equal specificity: a
  column aligned right had right-aligned values under a left-aligned heading,
  which is not what the delimiter row says and not what any other renderer
  does with it.
*/
.cm-lp-grid-table .cm-lp-grid-left { text-align: left; }
.cm-lp-grid-table .cm-lp-grid-center { text-align: center; }
.cm-lp-grid-table .cm-lp-grid-right { text-align: right; }
/*
  An empty cell says so. Drawn as nothing it is indistinguishable from a column
  that failed to render, and a reader cannot tell which they are looking at.
*/
.cm-lp-grid-empty::after {
  content: "—";
  color: var(--lp-muted);
}
/*
  A TABLE THAT CAN BE TYPED INTO, and the rules that are only true of one.

  The frame shrinks to the table so the controls sit against the columns they
  add to rather than at the right edge of the measure. Pinned rather than laid
  out, so a table nobody is working in occupies exactly what a reader's does --
  the moment the chrome takes room in the flow, an editable note and a read one
  are two different documents.
*/
.cm-lp-grid-frame {
  position: relative;
  display: inline-block;
  min-width: 0;
  max-width: 100%;
}
/*
  ROOM FOR THE CHROME, which the first version of this deliberately did not
  reserve -- and looking at it in a browser is what settled the argument. The
  bar was pinned above the frame with a negative offset so an editable table
  occupied exactly what a reader's does. In the running app it was drawn over
  the last line of the paragraph above and then cut in half by this box, whose
  overflow-x makes overflow-y a clip too. Half a control over somebody's
  sentence is worse than a table that sits a line lower while it can be edited,
  so the space is reserved, and only while the grid is live.
*/
.cm-lp-grid-live { padding-top: 1.7em; }
/*
  AND ROOM ACROSS, for the same reason and found the same way. The frame
  shrinks to the table, an absolutely positioned box cannot be wider than the
  box it is positioned in, and a two-column table of single characters is
  narrower than four buttons -- so in the browser the bar wrapped every label
  down its own column and drew "+ r o w" on top of "+ c o l". The frame keeps
  a floor wide enough for the chrome while the grid is live; the table inside
  it is still sized by its own content.
*/
.cm-lp-grid-live .cm-lp-grid-frame { min-width: 12em; }
/*
  Something to aim at. An empty cell in an editable grid is a box a person
  clicks into, and a box with no width cannot be clicked -- while the reader's
  dash, which exists so an empty cell is not mistaken for a broken one, would
  be a character they have to delete before typing.
*/
.cm-lp-grid-live th, .cm-lp-grid-live td { min-width: 3ch; }
.cm-lp-grid-live .cm-lp-grid-empty::after { content: ""; }
.cm-lp-grid-cell:focus {
  outline: none;
  /*
    Inset so it does not move the column: an outline drawn outside the cell
    shifts every row of the table by a pixel as the caret moves along it.
  */
  box-shadow: inset 0 0 0 2px var(--lp-line-strong);
  border-radius: 2px;
}
.cm-lp-grid-controls {
  position: absolute;
  /*
    Inside the padding above rather than outside the box, and against the left
    edge rather than the right: a table wider than the measure scrolls inside
    its own box, and chrome pinned to the far edge of a wide one is chrome
    nobody can reach without scrolling to it first.
  */
  top: -1.5em;
  left: 0;
  display: flex;
  gap: 4px;
  /*
    Out of the way until wanted. Opacity rather than display, so the buttons
    keep their size and the bar does not appear to jump into existence.
  */
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}
.cm-lp-grid-frame:hover .cm-lp-grid-controls,
.cm-lp-grid-frame:focus-within .cm-lp-grid-controls {
  opacity: 1;
  pointer-events: auto;
}
.cm-lp-grid-add {
  font-family: var(--lp-body);
  white-space: nowrap;
  font-size: 0.66em;
  line-height: 1;
  padding: 3px 6px;
  color: var(--lp-muted);
  background: var(--lp-bg);
  border: 1px solid var(--lp-line-strong);
  border-radius: 4px;
  cursor: pointer;
}
.cm-lp-grid-add:hover { color: var(--lp-content); }
/*
  THE HANDLES, which are cells of the table rather than boxes over it.

  The gutter column and the strip above the header are laid out by the table
  itself, so a handle is always beside its own row or above its own column at
  whatever width that column came out. They take room only while the note can
  be edited, and a reader's table has neither.
*/
.cm-lp-grid-gutter, .cm-lp-grid-corner, .cm-lp-grid-colslot {
  padding: 0 !important;
  border: none !important;
  width: 1.2em;
  vertical-align: middle;
  text-align: center;
  background: none;
}
.cm-lp-grid-colslot { width: auto; height: 1.1em; }
.cm-lp-grid-handle {
  font-family: var(--lp-body);
  font-size: 0.8em;
  line-height: 1;
  padding: 1px 2px;
  color: var(--lp-muted);
  background: none;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  /*
    Invisible until the row or column it belongs to is wanted, and *still
    there*: a handle that is display:none cannot be tabbed to and moves the
    table every time a pointer crosses it.
  */
  opacity: 0;
  transition: opacity 120ms ease;
}
.cm-lp-grid-table tr:hover .cm-lp-grid-handle,
.cm-lp-grid-strip:hover .cm-lp-grid-handle,
.cm-lp-grid-frame:focus-within .cm-lp-grid-handle,
.cm-lp-grid-handle:focus { opacity: 1; }
.cm-lp-grid-handle:hover { color: var(--lp-content); background: var(--lp-code-bg); }
/*
  The row or column a menu is about, said on the table rather than only in the
  menu's own wording. The control that this replaced acted on a row nobody
  could see, which is the whole reason the chrome was rewritten.
*/
.cm-lp-grid-target { background: var(--lp-focus-ring); }
.cm-lp-grid-menu {
  z-index: 40;
  min-width: 11em;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--lp-bg);
  border: 1px solid var(--lp-line-strong);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0,0,0,0.14);
  font-family: var(--lp-body);
  font-size: 0.8em;
}
.cm-lp-grid-menu-item {
  appearance: none;
  text-align: left;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: none;
  color: var(--lp-content);
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.cm-lp-grid-menu-item:hover, .cm-lp-grid-menu-item:focus {
  background: var(--lp-code-bg);
  outline: none;
}
/* The alignment a column already has, marked rather than repeated elsewhere. */
.cm-lp-grid-menu-current::after { content: " ✓"; color: var(--lp-muted); }
.cm-lp-grid-menu-destructive { color: var(--lp-danger); }
/*
  A FINGER IS NOT A POINTER, and this chrome is reached by both: the phone
  cannot hover, so a handle appears with the caret there and is then tapped.
  At the pointer size that tap target is about ten pixels, which is under
  every touch floor this app has. Widened where the input is coarse rather
  than everywhere, because on a desktop the same size would be chrome
  shouting over the note.
*/
@media (pointer: coarse) {
  .cm-lp-grid-handle { font-size: 1em; padding: 6px; }
  .cm-lp-grid-gutter, .cm-lp-grid-corner { width: 1.9em; }
  .cm-lp-grid-menu-item { padding: 11px 12px; }
  .cm-lp-grid-add { padding: 7px 10px; }
}
.cm-lp-rule { color: var(--lp-muted); }`;
