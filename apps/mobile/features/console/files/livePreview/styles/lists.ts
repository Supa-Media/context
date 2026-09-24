/**
 * Folder lists drawn from their block: a caption, then one hairline row per
 * note. The last slice of `livePreviewStyles`, and the one slice that opens
 * on its comment rather than a newline: the image slice before it already
 * ends on one.
 */
export const listStyles = `/*
  A FOLDER LIST, DRAWN IN THE NOTE.

  No card and no fill: the rows are the note's own hairlines and type, so the
  list reads as part of the page rather than a panel dropped onto it. The
  title is the one thing read; the caption, the values and the foot are a
  step quieter. Quieter by opacity rather than a new token, the idiom
  .cm-lp-form-status-quiet already uses, because on the desktop --lp-muted and
  --lp-content are the same ink.
*/
.cm-lp-list {
  margin: 0 0 10px;
}
.cm-lp-list-cap {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin: -3px 0 4px -6px;
  padding: 3px 8px 3px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--lp-muted);
  opacity: 0.8;
  font: inherit;
  font-size: 0.78em;
  cursor: pointer;
}
.cm-lp-list-cap:hover,
.cm-lp-list-cap:focus-visible {
  background: var(--lp-code-bg);
  color: var(--lp-content);
  opacity: 1;
}
.cm-lp-list-cap:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
}
.cm-lp-list-rows:not(:empty) {
  border-bottom: 1px solid var(--lp-line);
}
/* A list, not prose: its own line height rather than the paragraph's. */
.cm-lp-list-row {
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 9px 0;
  line-height: 1.45;
  border-top: 1px solid var(--lp-line);
  color: var(--lp-content);
  text-decoration: none;
  cursor: pointer;
}
.cm-lp-list-row:hover .cm-lp-list-title,
.cm-lp-list-row:focus-visible .cm-lp-list-title {
  color: var(--lp-link);
}
.cm-lp-list-row:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 2px;
  border-radius: 4px;
}
.cm-lp-list-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
  Every column but the last is a fixed track, so owners start on one line; the
  last sits against the edge, so dates end on one.
*/
.cm-lp-list-value {
  flex: none;
  width: 5.5em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  color: var(--lp-muted);
  opacity: 0.75;
  font-size: 0.85em;
  font-variant-numeric: tabular-nums;
}
.cm-lp-list-value:last-child {
  width: auto;
  min-width: 5.5em;
  max-width: 30%;
  text-align: right;
}
.cm-lp-list-foot:not(:empty) {
  padding-top: 8px;
  color: var(--lp-muted);
  opacity: 0.75;
  font-size: 0.85em;
}
/* Muted, like a form that will not parse: the author's to fix, not an alarm. */
.cm-lp-list-broken .cm-lp-list-foot {
  opacity: 1;
}
.cm-lp-list-why {
  margin-top: 4px;
  font-family: var(--lp-mono);
  font-size: 0.9em;
  opacity: 0.75;
}
/*
  A phone: taller rows for a thumb, and only the last value beside the title.
  The width is layout.narrowBreakpoint written out, because this sheet also
  ships in the native editor bundle, which cannot import the design tokens;
  listBlock.test.ts holds the two together.
*/
@media (max-width: 879.98px) {
  .cm-lp-list-row { padding: 12px 0; }
  .cm-lp-list-value:not(:last-child) { display: none; }
}
`;
