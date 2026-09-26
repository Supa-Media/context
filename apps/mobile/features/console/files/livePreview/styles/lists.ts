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
.cm-lp-list-cap:focus-visible,
.cm-lp-list-open .cm-lp-list-cap {
  background: var(--lp-line);
  color: var(--lp-content);
  opacity: 1;
}
.cm-lp-list-cap:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
}
.cm-lp-list-rows:not(:empty):not(.cm-lp-list-rows-board) {
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
  last sits against the edge, so dates end on one. The track is wide enough for
  an agent's name ("Seyi's Claude") rather than cutting it to "Seyi's Clau...".
*/
.cm-lp-list-value {
  flex: none;
  width: 8em;
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
  short note and the rows it changes stay in view below it.

  The page's own ground with one hairline, like a form, rather than a filled
  slab: a settings sheet, label on the left and the choice on the right, in
  sentence case. Fields are the app's Input (the well, a strong hairline, the
  petrol ring on focus) and chosen chips are its selected choice (petrol edge,
  petrol wash) rather than a solid fill.
*/
.cm-lp-list-panel {
  max-width: 480px;
  box-sizing: border-box;
  margin: 2px 0 16px;
  padding: 14px 16px 10px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 10px;
  background: var(--lp-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  color: var(--lp-content);
  font-size: 13px;
  line-height: 1.4;
}
.cm-lp-list-panel:focus {
  outline: none;
}
.cm-lp-list-panel-section {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  column-gap: 12px;
  align-items: start;
}
.cm-lp-list-panel-section > * {
  grid-column: 2;
}
.cm-lp-list-panel-section > .cm-lp-list-panel-label {
  grid-column: 1;
  grid-row: 1 / span 9;
}
.cm-lp-list-panel-section + .cm-lp-list-panel-section {
  margin-top: 10px;
}
.cm-lp-list-panel-label {
  line-height: 30px;
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
  padding: 0 10px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 8px;
  background: transparent;
  color: var(--lp-content);
  font: inherit;
  -webkit-appearance: none;
  appearance: none;
}
.cm-lp-list-panel-field::placeholder {
  color: var(--lp-muted);
  opacity: 0.6;
}
.cm-lp-list-panel-field:focus {
  outline: none;
  border-color: var(--lp-link);
  box-shadow: 0 0 0 3px var(--lp-focus-ring);
}
/*
  A select drawn as a quiet button rather than the platform's grey lozenge:
  no fill until hovered, and a chevron made of two gradient halves in the
  muted ink, since a data: SVG could not follow the theme's colour.
*/
.cm-lp-list-panel-select {
  flex: none;
  max-width: 60%;
  padding: 0 26px 0 10px;
  border-color: var(--lp-line);
  background-color: transparent;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--lp-muted) 50%),
    linear-gradient(135deg, var(--lp-muted) 50%, transparent 50%);
  background-position:
    calc(100% - 14px) 13px,
    calc(100% - 10px) 13px;
  background-size: 4px 4px;
  background-repeat: no-repeat;
  cursor: pointer;
}
.cm-lp-list-panel-select:hover {
  border-color: var(--lp-line-strong);
  background-color: var(--lp-line);
}
.cm-lp-list-panel-select option {
  background: var(--lp-bg);
  color: var(--lp-content);
}
.cm-lp-list-panel-condition .cm-lp-list-panel-select {
  max-width: 34%;
}
.cm-lp-list-panel button:focus-visible,
.cm-lp-list-panel-check input:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
}
.cm-lp-list-panel-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: var(--lp-content);
  cursor: pointer;
}
.cm-lp-list-panel-check input {
  appearance: none;
  flex: none;
  width: 16px;
  height: 16px;
  margin: 0;
  border: 1px solid var(--lp-line-strong);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.cm-lp-list-panel-check input:checked {
  background: var(--lp-link);
  border-color: var(--lp-link);
  box-shadow: inset 0 0 0 3px var(--lp-bg);
}
.cm-lp-list-panel button {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.cm-lp-list-panel-remove {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--lp-muted);
  font-size: 16px;
  line-height: 1;
}
.cm-lp-list-panel-remove:hover {
  color: var(--lp-content);
  background: var(--lp-line);
}
.cm-lp-list-panel .cm-lp-list-panel-quiet {
  height: 30px;
  padding: 0;
  color: var(--lp-muted);
  text-align: left;
}
.cm-lp-list-panel .cm-lp-list-panel-quiet:hover {
  color: var(--lp-link);
}
.cm-lp-list-panel-add {
  justify-self: start;
}
.cm-lp-list-panel-row + .cm-lp-list-panel-add {
  margin-top: 2px;
}
.cm-lp-list-panel-add::before {
  content: "+";
  display: inline-block;
  width: 1em;
  margin-right: 4px;
  font-size: 15px;
  text-align: center;
}
.cm-lp-list-panel .cm-lp-list-panel-flip {
  height: 30px;
  padding: 0 8px;
  border-radius: 8px;
  color: var(--lp-muted);
  white-space: nowrap;
}
.cm-lp-list-panel .cm-lp-list-panel-flip::after {
  content: " \\21C5";
  opacity: 0.6;
}
.cm-lp-list-panel .cm-lp-list-panel-flip:hover {
  color: var(--lp-content);
  background: var(--lp-line);
}
.cm-lp-list-panel-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}
.cm-lp-list-panel .cm-lp-list-panel-chip {
  height: 26px;
  padding: 0 11px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 13px;
  color: var(--lp-muted);
}
.cm-lp-list-panel .cm-lp-list-panel-chip:hover {
  color: var(--lp-content);
  background: var(--lp-line);
}
.cm-lp-list-panel .cm-lp-list-panel-chip-on,
.cm-lp-list-panel .cm-lp-list-panel-chip-on:hover {
  border-color: var(--lp-link);
  background: var(--lp-focus-ring);
  color: var(--lp-link);
  font-weight: 500;
}
.cm-lp-list-panel .cm-lp-list-panel-chip:disabled {
  opacity: 0.45;
  background: transparent;
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
  margin: 14px -16px 0;
  padding: 8px 16px 0;
  border-top: 1px solid var(--lp-line);
}
/* Quiet: every change is already in the note, so this closes rather than saves. */
.cm-lp-list-panel .cm-lp-list-panel-done {
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
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
  .cm-lp-list-panel-section { grid-template-columns: minmax(0, 1fr); }
  .cm-lp-list-panel-section > * { grid-column: 1; }
  .cm-lp-list-panel-section > .cm-lp-list-panel-label { grid-row: auto; line-height: 1.4; margin-bottom: 6px; }
  .cm-lp-list-panel-select { height: 36px; background-position: calc(100% - 14px) 16px, calc(100% - 10px) 16px; }
  .cm-lp-list-panel-condition { flex-wrap: wrap; }
  .cm-lp-list-panel-condition > .cm-lp-list-panel-field:first-child { flex: 1 0 100%; }
  .cm-lp-list-panel-condition .cm-lp-list-panel-select { max-width: none; }
  .cm-lp-list-panel-field { height: 36px; font-size: 16px; }
  .cm-lp-list-value:not(:last-child) { display: none; }
}
`;
