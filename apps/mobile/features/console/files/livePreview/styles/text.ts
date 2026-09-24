/**
 * Frontmatter, inline marks, code and its highlighting, html
 * previews, quotes and callouts, links, bullets and checkboxes.
 *
 * One consecutive slice of `livePreviewStyles`, moved out of `livePreview.ts`
 * verbatim and in its original order; `../../livePreview.ts` joins the slices
 * back into the identical string. Order matters to the cascade, so a rule is
 * never moved between slices.
 */
export const textStyles = `
/*
  A note's metadata, drawn as metadata. Not hidden: the buffer is the Markdown,
  and a block the editor refuses to show is a block you cannot fix. See
  frontmatterRange above for what this replaced. (No backticks in this comment:
  it is inside a template literal and one would end the string.)
*/
.cm-lp-frontmatter {
  font-family: var(--lp-mono);
  font-size: 0.82em;
  line-height: 1.7;
  color: var(--lp-muted);
}
/*
  A dictated phrase the engine has not settled on yet.

  Grey and italic because that is what "heard, not written" has to look like:
  the reader has to be able to tell at a glance which words are in their file
  and which are the machine still thinking. It is a widget, so it is not in
  the document and cannot be selected, copied or saved — see dictate.ts.
*/
.cm-dictation-interim {
  color: var(--lp-muted);
  font-style: italic;
  white-space: pre-wrap;
}
.cm-lp-strong { font-weight: 650; color: var(--lp-heading); }
.cm-lp-em { font-style: italic; }
.cm-lp-strike { text-decoration: line-through; opacity: 0.7; }
.cm-lp-code {
  font-family: var(--lp-mono);
  font-size: 0.92em;
  background: var(--lp-code-bg);
  border-radius: 4px;
  padding: 0.1em 0.32em;
}
.cm-lp-fence {
  font-family: var(--lp-mono);
  font-size: 0.92em;
  background: var(--lp-code-bg);
}
/*
  R3 in the sweep: a fence in one of the three languages the bundle already
  carries (see FENCE_LANGUAGES) is coloured with tokens this file already has
  rather than a new one — see fenceHighlightStyle's own comment for why.
*/
.cm-lp-code-keyword { color: var(--lp-link); }
.cm-lp-code-string { color: var(--lp-heading); }
.cm-lp-code-comment { color: var(--lp-muted); font-style: italic; }
/*
  A rendered html-preview fence. See HtmlPreviewWidget for what is inside the
  frame and why nothing inside it can run.

  ## The height is fixed, and that is a gap rather than a choice

  Nothing here can measure the frame. Sizing an iframe to its content means
  script inside it reporting a height out, and script inside it is the one thing
  this feature never allows; the frame is also cross-origin by construction, so
  the host cannot reach in and read it either. So the box is a number, and it
  errs tall: a diagram drawn short leaves empty space under it, and a diagram
  drawn tall loses its bottom third. The second is the failure a reader notices.

  ## overflow: hidden is not tidying

  The markup in the fence may have been emailed in by a stranger, and a layout
  that escapes its box draws over real console UI — a toolbar, a save state, a
  privacy control. The clip is on the wrapper, so nothing the frame's own CSS
  does can widen it, and max-height keeps the box inside the viewport on a phone
  where 620px is most of the screen.

  pointer-events: none on the frame is what lets a click reach the editor and
  reveal the source. See the widget's comment.
*/
.cm-lp-preview {
  overflow: hidden;
  margin: 0.5em 0;
  border: 1px solid var(--lp-code-bg);
  border-radius: 8px;
  background: var(--lp-code-bg);
}
.cm-lp-preview-frame {
  display: block;
  width: 100%;
  height: 620px;
  max-height: 80vh;
  border: 0;
  pointer-events: none;
}
.cm-lp-quote { color: var(--lp-muted); font-style: italic; }
/*
  A CALLOUT — an Obsidian blockquote that opens with [!type].

  A box rather than the quote's italic muted run, because that is the whole
  point of the syntax: the author is setting this apart from the prose around
  it. The callout's own lines override the quote styling they inherit, since
  every line of one is also a Blockquote and would otherwise be drawn as an
  aside inside its own box.

  NO PER-TYPE COLOUR, deliberately, and it is the restraint this file already
  states about its palette: Obsidian has thirteen callout types and thirteen
  colours, and each one here would be another --lp-* token crossing the WebView
  bridge for a distinction the box and the title already carry. The icon in the
  report that prompted this is not Obsidian's either — it is the plugin's own
  stylesheet, which Context does not load into the trusted realm.

  The left bar is the one piece of the quote's vocabulary kept, so a callout
  still reads as a quoted block rather than as a code fence.
*/
.cm-lp-callout {
  background: var(--lp-code-bg);
  border-left: 3px solid var(--lp-line-strong);
  color: var(--lp-content);
  font-style: normal;
  padding-left: 10px;
}
.cm-lp-callout .cm-lp-quote { color: inherit; font-style: inherit; }
/* Rounded at the ends, so a run of lines reads as one box. */
.cm-lp-callout-head { border-top-right-radius: 6px; padding-top: 2px; }
/* The title line carries the weight; the type stands in when there is none. */
.cm-lp-callout-head .cm-lp-quote { color: var(--lp-heading); font-weight: 600; }
.cm-lp-callout-type { color: var(--lp-heading); font-weight: 600; font-style: normal; }
.cm-lp-link { color: var(--lp-link); text-decoration: underline; }
/*
  A list item's indent is arithmetic rather than taste, and it is not here: the
  padding and the negative text-indent are one number set per line by the
  decoration, because it depends on how wide that item's own marker is, so the
  first line starts at the margin with its marker and every wrapped line clears
  it. See hangingIndents. What is here is only the marker's colour.
*/
.cm-lp-list-mark { color: var(--lp-muted); }
/*
  Both widgets hold the width of the characters they replaced, so the hanging
  indent above stays true on a wrapped line. A bullet stands in for one
  character and a checkbox for three.

  ## text-indent: 0 is not tidying, it is the whole of "bullets look broken"

  The hanging indent is padding-left:Nch with text-indent:-Nch on the line,
  which puts the first line's content back at the margin and every wrapped line
  clear of the marker. TEXT-INDENT IS INHERITED, and both of these are
  inline-level boxes with their own inner line box — so each widget applied the
  line's negative indent a second time, inside itself. Measured in a browser at
  390pt: the bullet glyph drew at -20.4px, a full indent OUTSIDE the reading
  margin, while the text after it started correctly at 10.2px. A bullet adrift
  in the left gutter, a third of an inch from the line it belongs to — and a
  nested item, whose indent is twice as deep, drew its bullet off the left edge
  of the screen entirely.

  An ordered list was never affected and that is the tell: "1." is real text,
  not a widget, so it took the indent once and landed correctly. Only what was
  replaced went wrong.
*/
.cm-lp-bullet {
  display: inline-block;
  width: 1ch;
  text-indent: 0;
  color: var(--lp-muted);
}
/*
  The checkbox, and the reason it is drawn rather than written.

  It used to be the character U+2610, which is text: it takes the body font's
  weight, it is a different shape in every font that has it, plenty of fonts do
  not have it at all, and none of them looks like something you press. A border
  and a radius do not depend on a font being installed and do not change weight
  when the text around them does.

  The outer span is the three columns the source characters occupied and the box
  is centred in them, so a list mixing tasks and plain items keeps its text in
  one column.
*/
.cm-lp-task {
  display: inline-flex;
  align-items: center;
  /* Inherited text-indent, for .cm-lp-bullet's reason. */
  text-indent: 0;
  justify-content: center;
  width: 3ch;
  cursor: pointer;
  /* The press is the whole point; the system callout is the other thing that
     answers a long press over it. */
  -webkit-touch-callout: none;
}
.cm-lp-task-box {
  position: relative;
  box-sizing: border-box;
  width: 0.95em;
  height: 0.95em;
  border: 1.5px solid var(--lp-muted);
  border-radius: 3px;
  /* A hair below the text baseline, where a checkbox sits beside a line of
     prose rather than floating in the middle of it. */
  transform: translateY(0.04em);
}
.cm-lp-task-on .cm-lp-task-box {
  background: var(--lp-link);
  border-color: var(--lp-link);
}
/*
  The tick: two borders on a rotated box, which is the construction that needs
  no font and no image. Drawn in the editor background so it reads as cut out of
  the filled square rather than painted on it.
*/
.cm-lp-task-on .cm-lp-task-box::after {
  content: "";
  position: absolute;
  left: 0.27em;
  top: 0.09em;
  width: 0.17em;
  height: 0.40em;
  border: solid var(--lp-bg);
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(45deg);
}
/*
  A finished task, drawn as finished — the half of a checkbox that a one-column
  glyph could never carry. This is what lets somebody skim a list and see what
  is left without reading it.
*/
.cm-lp-task-done {
  color: var(--lp-muted);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}`;
