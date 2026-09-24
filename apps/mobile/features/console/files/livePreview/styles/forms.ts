/**
 * Forms drawn from their declaration: the fields, the submit row, and the
 * responses table.
 *
 * One consecutive slice of `livePreviewStyles`, moved out of `livePreview.ts`
 * verbatim and in its original order; `../../livePreview.ts` joins the slices
 * back into the identical string. Order matters to the cascade, so a rule is
 * never moved between slices.
 */
export const formStyles = `
/*
  A FORM, DRAWN FROM ITS DECLARATION.

  Every colour here is one of the --lp-* properties the host already sets from
  the palette in force, so the form follows the theme without this file naming a
  single value — the rule the rest of these styles follow. --lp-code-bg is the
  one that does the most work: it is a translucent ink rather than a fixed grey,
  so it darkens a light ground and lightens a dark one, which is exactly what a
  field's fill and a card's hairline both want.

  The card is the same object as the note around it rather than a panel floating
  over it: one hairline, the page's own background, and the reading measure. A
  raised surface would be a second document inside the note, which is what the
  diagram frame beside it is and what a form is not.
*/
.cm-lp-form {
  /*
    A real hairline. This was --lp-code-bg, which is the code fence's FILL:
    #F5F5F5 on a #FFFFFF ground, so in light mode the card had no visible edge
    at all and the form read as loose controls dropped into the note. --lp-line
    is the palette's own separator and is the same value every hairline in the
    app is drawn in.
  */
  border: 1px solid var(--lp-line);
  /*
    ONE GUTTER, DECLARED ONCE.

    Every band inside measures its own edge from this, and so does the first and
    last cell of the response table — which is the only way rows that scroll
    sideways can line up with a heading that does not. It was 14px written out
    in four rules and 9 / 11 / 14 vertically in three of them, and no two bands
    agreeing on where their edge was is the whole of "the spacing looks off".

    Deliberately NOT --lp-form-gutter. In this file --lp-* names a value the
    host supplies over the bridge, and two tests hold every one of them to
    themeVars and to the guest's own :root for a reason worth keeping: an
    undeclared custom property does not fall back, it invalidates the whole
    declaration that names it. This is a layout constant declared on the only
    element whose descendants read it, so it is not that kind of property and
    does not borrow that prefix.
  */
  --form-gutter: 14px;
  /*
    One radius family — 10 on the card, 8 on the field, 8 on the button. It was
    12 / 9 / 11, three radii no two of which agreed, which is what made a small
    card read as three unrelated objects stacked up.
  */
  border-radius: 10px;
  /* The padding belongs to the three bands inside, so their rules can run edge
     to edge. */
  overflow: hidden;
  margin: 0.6em 0;
  font-family: var(--lp-body);
  font-size: 0.94em;
  line-height: 1.45;
  color: var(--lp-content);
}
/*
  WHAT THIS BOX IS, AND WHERE WHAT YOU TYPE GOES.

  See FormWidget.drawHead. The destination is the half that earns the strip:
  responses live in a sister note by design, and a reader had no way to learn
  which one before pressing Submit.
*/
.cm-lp-form-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px var(--form-gutter);
  border-bottom: 1px solid var(--lp-line);
  background: var(--lp-code-bg);
}
.cm-lp-form-kind {
  font-family: var(--lp-mono);
  font-size: 0.72em;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lp-muted);
}
.cm-lp-form-dest { font-size: 0.82em; color: var(--lp-muted); }
.cm-lp-form-dest-path { font-family: var(--lp-mono); color: var(--lp-content); }
.cm-lp-form-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: var(--form-gutter);
}
.cm-lp-form-row { display: flex; flex-direction: column; gap: 6px; }
/* The label and its character count, on one line. */
.cm-lp-form-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
/*
  A field's name is its label verbatim, with underscores spaced out. Sentence
  case is left alone rather than title-cased: the author wrote the name, and a
  form that renames somebody's field on screen is a form whose error messages
  are about a field they cannot find.
*/
.cm-lp-form-label {
  /*
    Small, spaced and upper-case: a field name is a label rather than a
    sentence, and at 0.85em in sentence case it read as body copy that happened
    to be grey — the note's own prose and the form's chrome in the same voice.
    The name itself is still verbatim; see drawField.
  */
  font-size: 0.76em;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--lp-muted);
}
/*
  The word rather than an asterisk. An asterisk has to be learned, is invisible
  to a screen reader that announces punctuation differently, and at 0.85em is
  three pixels of ink carrying the difference between a form that submits and
  one that is refused.
*/
.cm-lp-form-required {
  font-weight: 500;
  /* Not upper-cased with the name: it is a note about the field, not part of
     what the field is called. */
  text-transform: none;
  letter-spacing: 0.02em;
  color: var(--lp-muted);
  opacity: 0.85;
}
.cm-lp-form-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-family: var(--lp-body);
  color: var(--lp-content);
  background: var(--lp-code-bg);
  /*
    A real border at rest rather than a transparent one. A filled slab with no
    edge is a block of colour; the edge is what says "you type in here", and
    without it the only thing distinguishing a field from a code span was its
    width.
  */
  border: 1px solid var(--lp-line-strong);
  border-radius: 8px;
  padding: 8px 10px;
  /* Safari draws its own rounded fill over the one above without this. */
  -webkit-appearance: none;
  appearance: none;
}
.cm-lp-form-input::placeholder { color: var(--lp-muted); opacity: 0.7; }
/* The two controls that are meaningless at full width and a target at 18px. */
.cm-lp-form-input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--lp-link); }
.cm-lp-form-input[type="date"], .cm-lp-form-input[type="number"] { width: auto; min-width: 10em; }
.cm-lp-form-input:focus {
  outline: none;
  border-color: var(--lp-link);
  /*
    A ring as well as the border. The border alone moves one pixel of colour on
    focus, which is not enough to find the field you just tabbed to — and this
    is the control a keyboard user reaches Submit through.
  */
  box-shadow: 0 0 0 3px var(--lp-focus-ring);
}
textarea.cm-lp-form-input { resize: vertical; min-height: 5em; }
/*
  Right-aligned under the box it counts, in the muted ink: it is a fact about
  the room left rather than a message, and reading order should reach the next
  field before it.
*/
.cm-lp-form-count {
  font-size: 0.76em;
  color: var(--lp-muted);
  /* Digits that change under the reader's eye must not move the label. */
  font-variant-numeric: tabular-nums;
}
.cm-lp-form-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px var(--form-gutter);
  /* The action is separated from the fields rather than being the next thing
     in the stack — pressing it is not the same kind of act as filling one in. */
  border-top: 1px solid var(--lp-line);
}
/*
  The app's primary button, in CSS: the accent fill, white ink, 11px corners and
  a 15px label. It is the one filled thing in the note, which is what a button
  in a document should be.
*/
.cm-lp-form-submit {
  font: inherit;
  font-family: var(--lp-body);
  font-weight: 600;
  color: #ffffff;
  background: var(--lp-link);
  border: none;
  border-radius: 8px;
  padding: 7px 16px;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}
.cm-lp-form-submit:focus-visible { outline: 2px solid var(--lp-link); outline-offset: 2px; }
.cm-lp-form-submit:disabled { opacity: 0.45; cursor: default; }
.cm-lp-form-status { font-size: 0.88em; color: var(--lp-muted); }
.cm-lp-form-status-ok { color: var(--lp-link); font-weight: 600; }
/*
  A refusal is drawn in the muted ink at full weight rather than in red. There
  is no --lp-danger, and inventing a hex here would be the one colour in this
  file that does not follow the theme — the failure the file's own header names.
  Weight carries it, and the words carry the rest.
*/
.cm-lp-form-status-bad { color: var(--lp-content); font-weight: 600; }
.cm-lp-form-status-quiet { opacity: 0.75; }
/*
  The sister file's rows, as the card's fourth band.

  Its own padding and no margin, because the card is now edge-to-edge bands
  separated by rules (see .cm-lp-form) rather than one padded box — a margin
  here would inset the rule and leave the rows flush against the border. The
  title takes the same small upper-case voice as a field label, so the two
  headings inside one card agree.
*/
/*
  THE BAND IS PADDED; THE TABLE INSIDE IT IS NOT.

  The heading and the status line carry the card's gutter themselves so the
  scroll box can run wall to wall. A scroll inset by the card's padding leaves
  a dead strip on each side that the rows slide *under*, which reads as the
  table being clipped rather than as there being more of it to the right.
*/
.cm-lp-form-responses {
  border-top: 1px solid var(--lp-line);
  padding: var(--form-gutter) 0;
}
.cm-lp-form-responses-title {
  font-weight: 600;
  font-size: 0.76em;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--lp-muted);
  margin: 0 var(--form-gutter) 10px;
}
.cm-lp-form-responses-status {
  color: var(--lp-muted);
  font-size: 0.88em;
  margin: 0 var(--form-gutter);
}
.cm-lp-form-responses-scroll {
  overflow-x: auto;
  /*
    A sideways swipe over the table scrolls the table and stops there. Without
    this it chains to the page once the last column is reached, which on iOS is
    the back gesture — leaving the note to read one more column is not a trade
    anybody is offering.
  */
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}
/*
  THE TABLE IS AS WIDE AS ITS COLUMNS NEED.

  This was width: 100%, and with seven columns inside a card the width of the
  reading measure the browser's only move is to shrink every one of them until
  the whole thing fits: a handle broken across two lines mid-word, a timestamp
  taking four, one response 190px tall, and every column equally unreadable in
  service of showing all of them at once.

  max-content asks for the width the columns actually want and lets the box
  above scroll to the rest of it — which is what Notion does, and what the owner
  asked for by pointing at it. min-width is the other half: when the columns
  do NOT need the whole card, the rules still run its full width instead of the
  table huddling against the left edge.
*/
.cm-lp-form-responses-table {
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.cm-lp-form-responses-table th,
.cm-lp-form-responses-table td {
  border-bottom: 1px solid var(--lp-line);
  /*
    A rule between columns as well as between rows. On a table narrow enough to
    fit, row rules alone are enough; on one you scroll, the vertical rule is
    what tells you which column you have arrived at once its heading is off the
    left edge.
  */
  border-right: 1px solid var(--lp-line);
  padding: 7px 12px;
  text-align: left;
  vertical-align: top;
}
/* The gutter the band gave up, carried by the columns at each end so the rows
   line up with the heading above them. */
.cm-lp-form-responses-table th:first-child,
.cm-lp-form-responses-table td:first-child { padding-left: var(--form-gutter); }
/* ...and no rule on the last column, which would otherwise hang in the card's
   own padding with nothing to its right to separate. */
.cm-lp-form-responses-table th:last-child,
.cm-lp-form-responses-table td:last-child {
  padding-right: var(--form-gutter);
  border-right: none;
}
.cm-lp-form-responses-table th { color: var(--lp-muted); font-size: 0.88em; font-weight: 600; }
/*
  AN ANSWER WRAPS; A FACT ABOUT IT DOES NOT.

  Notion clips a cell to one line and gives you the row to open when you need
  the rest. This table has no row to open, and the answers are the entire point
  of the feature — a feature request truncated at 40 characters in the list of
  feature requests is the list not working. So the cap is on the column's
  *width*, at about a reading measure, and the text wraps inside it.
*/
.cm-lp-form-cell-value {
  /*
    24em is about one phone-width of column: at this table's size that is 324px
    against the ~350px a 390pt phone gives the card, so the answer is readable
    before any sideways scroll and the columns about it are one swipe away.

    The vw term is what makes the swipe DISCOVERABLE. At 24em flat the column
    filled a phone exactly, the next one started precisely at the card's edge,
    and a table with more to the right looked identical to one without — the
    scrollbar that says so on a desktop is a transient overlay on a phone and
    is not there at rest. Capped a little under the viewport, the next column
    always peeks, which is the same hint Notion leaves at the right edge. On
    anything wider than a phone the em term wins and the note keeps its
    measure.
  */
  max-width: min(24em, 72vw);
  /* A pasted URL or a 40-character token has nowhere to break, and one would
     otherwise push every column after it off the card on its own. */
  overflow-wrap: anywhere;
}
/*
  A handle broken across two lines mid-word is the screenshot this came from.
  A handle, an ISO timestamp and a row of buttons are each one token: wrapping
  buys nothing and is paid for in the height of every row.
*/
.cm-lp-form-cell-meta { white-space: nowrap; }
.cm-lp-form-cell-at { color: var(--lp-muted); font-variant-numeric: tabular-nums; }
/*
  THE VOTES CELL IS ONE LINE, BECAUSE IT SETS EVERY ROW'S HEIGHT.

  The voters and the two buttons were stacked, which made the tallest cell in
  the table one that holds no answer — every row paid two lines for it whatever
  it contained. Side by side they cost width instead, and width is the thing
  this table now has: it scrolls.
*/
/* On the text's baseline rather than the buttons' box, so the voters line up
   with By and At across the row instead of riding half a button lower. */
.cm-lp-form-votes { display: flex; align-items: baseline; gap: 10px; }
/*
  A REFUSAL LANDS HERE, AND A SENTENCE IN A NOWRAP CELL WOULD SET THE TABLE'S
  WIDTH.

  When a vote is declined the gateway's message replaces the voters (see
  drawResponses), and when a delete is declined it replaces the button's label.
  Inside a cell that never wraps, and a table that is now as wide as its widest
  content, one sentence would push every column to its right off the card and
  keep them there. So these two — the only places server text reaches a meta
  column — wrap inside a cap of their own. The buttons beside them still do
  not: their labels are short and fixed.
*/
.cm-lp-form-voters { color: var(--lp-muted); white-space: normal; max-width: 18em; }
.cm-lp-form-vote-controls { display: flex; gap: 6px; }
.cm-lp-form-response-controls { display: flex; gap: 6px; }
/*
  The row's own buttons, sized as chrome rather than as the content.

  At font: inherit with a 4/8 pad these were body size, and the two in a Votes
  cell made it taller than the response it belongs to — a whole row of height
  spent on controls in a table whose job is to be scanned. They are still the
  full 8mm target on the axis that matters for a thumb.
*/
.cm-lp-form-vote,
.cm-lp-form-response-action {
  font: inherit;
  font-size: 0.86em;
  line-height: 1.35;
  border: 1px solid var(--lp-line-strong);
  border-radius: 6px;
  padding: 4px 9px;
  color: var(--lp-link);
  background: transparent;
  cursor: pointer;
  /*
    And the labels wrap, inside a cap. Their own are short and fixed, but a
    declined delete replaces this one with the gateway's refusal — inside a
    column that never wraps, in a table now as wide as its widest content, one
    sentence would push every column to its right off the card and keep them
    there. Same reason, and same shape, as the cap on the voters above.
  */
  white-space: normal;
  max-width: 14em;
}
.cm-lp-form-vote:disabled,
.cm-lp-form-response-action:disabled { opacity: 0.45; cursor: default; }
.cm-lp-form-vote-remove { color: var(--lp-muted); }
.cm-lp-form-delete { color: var(--lp-muted); }
/*
  "We can't display because the formatting is off", which is what the owner
  asked for. Dashed rather than solid so it reads as a gap in the note that
  something should fill, and muted rather than loud: a form that will not parse
  is the author's problem to fix and nobody else's to be alarmed by.
*/
.cm-lp-form-broken {
  border-style: dashed;
  border-color: var(--lp-line-strong);
  color: var(--lp-muted);
  /* No head, no fields, no foot — so this one carries its own padding. */
  padding: 14px;
}
.cm-lp-form-broken-title { font-weight: 600; color: var(--lp-content); }
.cm-lp-form-broken-why { font-family: var(--lp-mono); font-size: 0.85em; margin-top: 4px; }
.cm-lp-form-hint { font-size: 0.85em; margin-top: 6px; }`;
