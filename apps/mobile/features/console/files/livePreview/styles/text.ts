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
  A cast block (the homepage's demo script), folded to one row while nobody
  is in it. Drawn like the frontmatter it folds like: small, muted, the mono
  face for the count. A press opens it; see castBlock.ts.
*/
.cm-lp-cast-block { padding: 0.25em 0; }
.cm-lp-cast {
  display: flex;
  align-items: baseline;
  gap: 0.45em;
  padding: 0.35em 0.6em;
  border-radius: 6px;
  background: var(--lp-code-bg);
  color: var(--lp-muted);
  font-size: 0.9em;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
}
.cm-lp-cast-name { font-weight: 600; color: var(--lp-heading); }
.cm-lp-cast-count { font-family: var(--lp-mono); font-size: 0.92em; }
/*
  The join box (joinBlock.ts) keeps its children's margins inside it. The
  homepage's card has a bottom margin, and without a formatting context of its
  own that margin collapsed out of the box, where CodeMirror's measure of the
  widget never saw it. Every line below was then drawn lower than the editor
  believed, and a click on the page's last line resolved past the end of the
  note (every footer link opened the devlog, 2026-09-30).
*/
.cm-lp-join { display: flow-root; }
.cm-lp-join > .cm-lp-cast { margin: 0.25em 0; }
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
/*
  ==highlighted== words: a marker-pen fill and nothing else. No underline and
  no pointer, which is what a comment's wash carries, so the two never read as
  each other even when they overlap.
*/
.cm-lp-mark {
  background: var(--lp-mark);
  border-radius: 2px;
  padding: 0.05em 0;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
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
.cm-lp-preview-block { padding: 0.5em 0; }
.cm-lp-preview {
  overflow: hidden;
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
  A CALLOUT — an Obsidian blockquote that opens with [!type] — drawn as a
  quiet card (design A, picked by the owner 2026-09-30 over a quote and a
  foldable box).

  A raised card, one step up from the note, rather than the near-black well it
  used to sit in: that read as a hole in the page. The box is line decorations,
  so the head line carries the top edge and the tail line the bottom one, and a
  one-line callout carries both.

  The head is one quiet line: the type's icon and name, small and muted, then
  the title in the heading's weight. A title that is a link loses its underline
  and gains a trailing arrow instead — two underlined things side by side was
  most of what looked wrong.

  With the caret anywhere inside, the edge turns the link colour and the head
  line is drawn as the Markdown it is, small and mono, so what somebody is
  editing is what they see. See the engaged pass in decorations.ts.

  Still NO PER-TYPE COLOUR: each would be another --lp-* token crossing the
  WebView bridge. The icon is a stroke in currentColor, which crosses nothing.
*/
.cm-lp-callout {
  background: var(--lp-raised);
  border-left: 1px solid var(--lp-line-strong);
  border-right: 1px solid var(--lp-line-strong);
  color: var(--lp-content);
  font-style: normal;
}
/*
  The card's inner padding has to outrank the two hosts' own reset of every
  line's padding (#root .cm-line on the phone, .cm-lp-root .cm-line on the
  web). :is() takes the id's weight, so this wins on both without either host
  knowing about callouts.
*/
:is(#root, .cm-lp-root) .cm-line.cm-lp-callout { padding-left: 16px; padding-right: 16px; }
:is(#root, .cm-lp-root) .cm-line.cm-lp-callout-head { padding-top: 10px; }
:is(#root, .cm-lp-root) .cm-line.cm-lp-callout-tail { padding-bottom: 12px; }
.cm-lp-callout .cm-lp-quote { color: inherit; font-style: inherit; }
.cm-lp-callout-head {
  border-top: 1px solid var(--lp-line-strong);
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
}
.cm-lp-callout-tail {
  border-bottom: 1px solid var(--lp-line-strong);
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}
.cm-lp-callout.cm-lp-callout-editing { border-color: var(--lp-link); }
/* The title carries the weight; the type rides in front of it, quietly. */
.cm-lp-callout-head .cm-lp-quote { color: var(--lp-heading); font-weight: 600; }
.cm-lp-callout-head .cm-lp-link { color: var(--lp-heading); text-decoration: none; }
.cm-lp-callout-badge {
  color: var(--lp-muted);
  font-size: 0.82em;
  font-style: normal;
  font-weight: 400;
}
.cm-lp-callout-icon { display: inline-block; margin-right: 6px; vertical-align: -0.15em; }
.cm-lp-callout-icon svg { display: block; }
.cm-lp-callout-badge-dot { margin: 0 8px; }
.cm-lp-callout-label .cm-lp-callout-icon { color: var(--lp-muted); }
.cm-lp-callout-type { color: var(--lp-heading); font-weight: 600; font-style: normal; }
.cm-lp-callout-arrow { color: var(--lp-muted); display: inline-block; margin-left: 4px; vertical-align: -0.05em; }
.cm-lp-callout-arrow svg { display: block; }
/* Clicked in: the head line is its own Markdown, small and mono. */
.cm-lp-callout-source,
.cm-lp-callout-source .cm-lp-quote,
.cm-lp-callout-source .cm-lp-link {
  color: var(--lp-muted);
  font-family: var(--lp-mono);
  font-size: 0.85em;
  font-weight: 400;
  text-decoration: none;
}
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
