/**
 * Folder lists drawn from their block: a caption, then one hairline row per
 * note. It opens on its comment rather than a newline, since the image slice
 * before it already ends on one; `listProjects.ts` follows it the same way.
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
  position: relative;
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
  The caption's popover: the block's filters as fields. It opens in the flow,
  between the caption and the rows, so it can never be clipped by the end of a
  short note and the rows it changes stay in view below it. The same surface
  as the image alt field, and the one place a list uses a card.
*/
.cm-lp-list-open .cm-lp-list-cap {
  color: var(--lp-content);
  opacity: 1;
}
.cm-lp-list-panel {
  max-width: 460px;
  box-sizing: border-box;
  margin: 2px 0 14px;
  padding: 14px 16px 12px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 10px;
  background: var(--lp-code-bg);
  color: var(--lp-content);
  font-size: 13px;
  line-height: 1.4;
}
.cm-lp-list-panel:focus {
  outline: none;
}
.cm-lp-list-panel-section + .cm-lp-list-panel-section {
  margin-top: 14px;
}
.cm-lp-list-panel-label {
  margin-bottom: 5px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--lp-muted);
  opacity: 0.8;
}
.cm-lp-list-panel-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cm-lp-list-panel-row + .cm-lp-list-panel-row {
  margin-top: 6px;
}
.cm-lp-list-panel-field {
  flex: 1;
  min-width: 0;
  height: 30px;
  box-sizing: border-box;
  padding: 0 9px;
  border: 1px solid var(--lp-line);
  border-radius: 7px;
  background: transparent;
  color: var(--lp-content);
  font: inherit;
}
.cm-lp-list-panel-field:hover,
.cm-lp-list-panel-field:focus {
  border-color: var(--lp-line-strong);
}
.cm-lp-list-panel-select option {
  background: var(--lp-code-bg);
  color: var(--lp-content);
}
.cm-lp-list-panel-select {
  flex: none;
  max-width: 45%;
  padding-right: 4px;
  cursor: pointer;
}
.cm-lp-list-panel-condition .cm-lp-list-panel-select {
  max-width: 34%;
}
.cm-lp-list-panel-field:focus-visible,
.cm-lp-list-panel button:focus-visible,
.cm-lp-list-panel-check input:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
}
.cm-lp-list-panel-check {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  color: var(--lp-muted);
  cursor: pointer;
}
.cm-lp-list-panel-check input {
  appearance: none;
  flex: none;
  width: 14px;
  height: 14px;
  margin: 0;
  border: 1px solid var(--lp-line-strong);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.cm-lp-list-panel-check input:checked {
  background: var(--lp-link);
  border-color: var(--lp-link);
  box-shadow: inset 0 0 0 2px var(--lp-code-bg);
}
.cm-lp-list-panel button {
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.cm-lp-list-panel-remove {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--lp-muted);
  font-size: 15px;
  line-height: 1;
}
.cm-lp-list-panel-remove:hover {
  color: var(--lp-content);
  background: var(--lp-line);
}
.cm-lp-list-panel-quiet {
  padding: 4px 0;
  color: var(--lp-muted);
}
.cm-lp-list-panel-quiet:hover {
  color: var(--lp-link);
}
.cm-lp-list-panel-add {
  margin-top: 2px;
}
.cm-lp-list-panel .cm-lp-list-panel-flip {
  height: 30px;
  padding: 0 8px;
  border-radius: 7px;
  color: var(--lp-muted);
}
.cm-lp-list-panel .cm-lp-list-panel-flip::after {
  content: " \\21C5";
  opacity: 0.6;
}
.cm-lp-list-panel .cm-lp-list-panel-flip:hover {
  color: var(--lp-content);
  background: var(--lp-line);
}
.cm-lp-list-panel-add::before {
  content: "+ ";
}
.cm-lp-list-panel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cm-lp-list-panel .cm-lp-list-panel-chip {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--lp-line);
  border-radius: 13px;
  color: var(--lp-muted);
}
.cm-lp-list-panel .cm-lp-list-panel-chip-on {
  border-color: var(--lp-link);
  background: var(--lp-link);
  color: var(--lp-code-bg);
  font-weight: 600;
}
.cm-lp-list-panel .cm-lp-list-panel-chip:disabled {
  opacity: 0.45;
  cursor: default;
}
.cm-lp-list-panel-hint,
.cm-lp-list-panel-problem:not(:empty) {
  margin-top: 8px;
  font-size: 12px;
  color: var(--lp-muted);
}
.cm-lp-list-panel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
}
/* Quiet: every change is already in the note, so this closes rather than saves. */
.cm-lp-list-panel .cm-lp-list-panel-done {
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  color: var(--lp-content);
  font-weight: 500;
}
.cm-lp-list-panel .cm-lp-list-panel-done:hover {
  background: var(--lp-line);
}
/*
  A phone: taller rows for a thumb, and only the last value beside the title.
  The width is layout.narrowBreakpoint written out, because this sheet also
  ships in the native editor bundle, which cannot import the design tokens;
  listBlock.test.ts holds the two together.
*/
@media (max-width: 879.98px) {
  .cm-lp-list-row { padding: 12px 0; }
  .cm-lp-list-panel { max-width: none; }
  .cm-lp-list-panel-condition { flex-wrap: wrap; }
  .cm-lp-list-panel-condition > .cm-lp-list-panel-field:first-child { flex: 1 0 100%; }
  .cm-lp-list-panel-condition .cm-lp-list-panel-select { max-width: none; }
  .cm-lp-list-panel-field { height: 36px; font-size: 16px; }
  .cm-lp-list-value:not(:last-child) { display: none; }
}
`;
