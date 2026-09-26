/**
 * Folder lists of projects: group headings, sub-projects under a twisty, the
 * progress bar, the menu a status or an owner opens, and the board. Split
 * from `lists.ts`, which draws every list, and appended after it.
 */
export const listProjectStyles = `/*
  PROJECTS AND GROUPS.

  A group is a quiet heading over its rows with a count, not a band of colour:
  status has no colour anywhere, so "No status" can stand out by being last
  rather than by being red. Sub-projects hang off a hairline guide one level
  in, and a project's progress is the one fill in the list, in link ink.
*/
.cm-lp-list-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 22px 0 6px;
  color: var(--lp-heading);
  font-size: 0.85em;
  font-weight: 600;
}
.cm-lp-list-group:first-child {
  padding-top: 4px;
}
.cm-lp-list-group-count {
  color: var(--lp-muted);
  opacity: 0.7;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.cm-lp-list-row {
  position: relative;
}
/* A drawn chevron that turns, the file tree's own gesture, not a text triangle. */
.cm-lp-list-twisty {
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin: 0 -8px 0 -5px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--lp-muted);
  opacity: 0.75;
  cursor: pointer;
}
.cm-lp-list-twisty svg {
  display: block;
  transition: transform 0.12s ease;
}
.cm-lp-list-twisty[aria-expanded="true"] svg {
  transform: rotate(90deg);
}
.cm-lp-list-twisty:hover {
  background: var(--lp-line);
  color: var(--lp-content);
  opacity: 1;
}
.cm-lp-list-twisty:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
}
.cm-lp-list-twisty:disabled {
  visibility: hidden;
}
.cm-lp-list-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.cm-lp-list-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cm-lp-list-progress {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: center;
  color: var(--lp-muted);
  opacity: 0.75;
  font-size: 0.78em;
  font-variant-numeric: tabular-nums;
}
.cm-lp-list-progress-bar {
  display: inline-block;
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: var(--lp-line-strong);
  overflow: hidden;
}
.cm-lp-list-progress-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--lp-link);
}
.cm-lp-list-sub {
  padding-left: 32px;
  font-size: 0.94em;
}
.cm-lp-list-sub::before,
.cm-lp-list-sub::after {
  content: "";
  position: absolute;
  left: 5px;
  background: var(--lp-line-strong);
}
.cm-lp-list-sub::before {
  top: 0;
  bottom: 0;
  width: 1px;
}
.cm-lp-list-sub-last::before {
  bottom: 50%;
}
.cm-lp-list-sub::after {
  top: 50%;
  width: 14px;
  height: 1px;
}
.cm-lp-list-own {
  flex: none;
  color: var(--lp-muted);
  opacity: 0.75;
  font-size: 0.8em;
}
.cm-lp-list-sub .cm-lp-list-name {
  color: var(--lp-muted);
}
.cm-lp-list-sub:hover .cm-lp-list-name {
  color: var(--lp-link);
}
/*
  A project's own status beside its name repeats the heading it sits under,
  so where there is a pointer it waits for the row to be hovered or focused:
  the handle is there when reached for and silent otherwise. A sub-project
  keeps its status, since it is not in a group of its own, and a finger with
  no hover keeps every handle.
*/
@media (hover: hover) {
  .cm-lp-list-row:not(.cm-lp-list-sub) > .cm-lp-list-title > .cm-lp-list-own {
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .cm-lp-list-row:not(.cm-lp-list-sub):hover > .cm-lp-list-title > .cm-lp-list-own,
  .cm-lp-list-row:not(.cm-lp-list-sub):focus-within > .cm-lp-list-title > .cm-lp-list-own,
  .cm-lp-list-row > .cm-lp-list-title > .cm-lp-list-own[aria-expanded="true"] {
    opacity: 0.75;
  }
}
/*
  THE VALUE MENU.

  What a status or an owner opens for someone who can change it: the words
  the listed notes already use, "No status" to clear, and a field for a new
  one. It is the app's own popover menu (Menu.web.tsx) in CSS: a raised
  surface one step off the page, a strong hairline, 10px corners, 6px of
  padding, 28px rows with 6px corners, a check gutter, and the petrol wash
  under the pointer or the keyboard.
*/
.cm-lp-list-edit {
  border: 0;
  margin: -2px -6px;
  padding: 2px 6px;
  border-radius: 6px;
  background: transparent;
  color: var(--lp-muted);
  font: inherit;
  cursor: pointer;
}
.cm-lp-list-value.cm-lp-list-edit {
  width: calc(8em + 12px);
  font-size: 0.85em;
}
.cm-lp-list-value.cm-lp-list-edit:last-child {
  width: auto;
}
.cm-lp-list-own.cm-lp-list-edit {
  font-size: 0.8em;
}
.cm-lp-list-edit:hover,
.cm-lp-list-edit[aria-expanded="true"] {
  background: var(--lp-line);
  color: var(--lp-content);
  opacity: 1;
}
.cm-lp-list-edit:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
  opacity: 1;
}
.cm-lp-list-unset {
  opacity: 0.45;
}
.cm-lp-list-menu {
  position: absolute;
  z-index: 5;
  min-width: 200px;
  max-width: 280px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 10px;
  background: var(--lp-bg);
  isolation: isolate;
  box-shadow: 0 16px 40px -12px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.08);
  color: var(--lp-content);
  font-family: var(--lp-body);
  font-size: 13px;
  line-height: 1.4;
}
/*
  Raised one step off the page the way surface3 is, in either theme: the
  hairline ink at half strength over the page, laid under the rows.
*/
.cm-lp-list-menu::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--lp-line);
  opacity: 0.6;
  pointer-events: none;
}
.cm-lp-list-menu-busy {
  opacity: 0.6;
  pointer-events: none;
}
.cm-lp-list-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.cm-lp-list-menu-item > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cm-lp-list-menu-item:hover,
.cm-lp-list-menu-item:focus-visible {
  background: var(--lp-focus-ring);
  color: var(--lp-link);
  outline: none;
}
.cm-lp-list-menu-check {
  flex: none;
  width: 12px;
  color: var(--lp-link);
  font-size: 12px;
  text-align: center;
}
.cm-lp-list-menu-on {
  color: var(--lp-heading);
  font-weight: 500;
}
/* Clearing is a different kind of choice from picking a word: a rule sets it off. */
.cm-lp-list-menu-clear {
  position: relative;
  margin-top: 9px;
  color: var(--lp-muted);
}
.cm-lp-list-menu-clear::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 4px;
  right: 4px;
  height: 1px;
  background: var(--lp-line);
}
/* The new word is typed in a row of its own, aligned with the words above it. */
.cm-lp-list-menu-new {
  display: block;
  width: 100%;
  box-sizing: border-box;
  height: 28px;
  margin-top: 4px;
  padding: 0 10px 0 30px;
  border: 1px solid var(--lp-line);
  border-radius: 6px;
  background: transparent;
  color: var(--lp-content);
  font: inherit;
  -webkit-appearance: none;
  appearance: none;
}
.cm-lp-list-menu-new::placeholder {
  color: var(--lp-muted);
  opacity: 0.7;
}
.cm-lp-list-menu-new:focus {
  outline: none;
  border-color: var(--lp-link);
  box-shadow: 0 0 0 3px var(--lp-focus-ring);
}
.cm-lp-list-menu-problem:not(:empty) {
  padding: 6px 10px 2px;
  color: var(--lp-danger);
}
/*
  THE BOARD.

  The same rows as columns of cards. A column is its group heading and a
  stack; a card is the page's own ground with a hairline, a notch lifted, the
  title on top and its values beneath. The only fill is the petrol wash of
  the column a card is being dragged over.
*/
.cm-lp-board {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(150px, 1fr);
  gap: 10px;
  margin: 0 -8px;
  padding: 0 8px 10px;
  overflow-x: auto;
  align-items: start;
  /*
    Its own scroller, never the note's width: without this the columns' widest
    content becomes .cm-content's minimum and the whole note scrolls sideways.
  */
  contain: inline-size;
}
.cm-lp-board-col {
  min-width: 0;
  min-height: 96px;
  margin: 0 -6px;
  padding: 0 6px 6px;
  border-radius: 10px;
  transition: background 0.12s ease;
}
.cm-lp-board-over {
  background: var(--lp-focus-ring);
}
.cm-lp-board-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 2px 10px;
  color: var(--lp-heading);
  font-size: 0.85em;
  font-weight: 600;
}
.cm-lp-board-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cm-lp-list-row.cm-lp-board-card {
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 10px 12px 11px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 10px;
  background: var(--lp-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  line-height: 1.35;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.cm-lp-list-row.cm-lp-board-card[draggable="true"] {
  cursor: grab;
}
.cm-lp-list-row.cm-lp-board-card:hover {
  box-shadow: 0 4px 14px -6px rgba(0, 0, 0, 0.18);
}
.cm-lp-board-card > .cm-lp-list-title {
  flex: 1 0 100%;
  flex-wrap: wrap;
  row-gap: 4px;
  white-space: normal;
}
.cm-lp-board-card .cm-lp-list-name {
  flex: 1 0 100%;
  color: var(--lp-heading);
}
.cm-lp-board-card .cm-lp-list-value,
.cm-lp-board-card .cm-lp-list-value:last-child {
  width: auto;
  min-width: 0;
  max-width: 100%;
  text-align: left;
}
.cm-lp-board-card .cm-lp-list-value:last-child:not(:first-of-type) {
  margin-left: auto;
}
/*
  On a card the status repeats the column, so it waits in the bottom corner,
  across from the owner and out of the title's way, until the card is hovered or reached by the keyboard; it is
  still the button that moves a card for a hand that cannot drag.
*/
@media (hover: hover) {
  .cm-lp-board-card .cm-lp-list-own {
    position: absolute;
    right: 6px;
    bottom: 8px;
    margin: 0;
  }
}
.cm-lp-board-dragging {
  opacity: 0.4;
}
.cm-lp-board-empty {
  padding: 16px 12px;
  border: 1px dashed var(--lp-line-strong);
  border-radius: 10px;
  color: var(--lp-muted);
  opacity: 0.7;
  font-size: 0.8em;
  text-align: center;
}
/*
  A phone, at the width lists.ts writes out and listBlock.test.ts holds: the
  sub-project indent survives the taller rows, progress is its count alone,
  so a title keeps the room, the menu's rows are a thumb's height, and a
  board is columns a thumb swipes through, one and a bit at a time.
*/
@media (max-width: 879.98px) {
  .cm-lp-list-sub { padding-left: 32px; }
  .cm-lp-list-progress-bar { display: none; }
  .cm-lp-list-twisty { width: 28px; height: 28px; margin: 0 -10px 0 -9px; }
  .cm-lp-board { grid-auto-columns: 82%; scroll-snap-type: x mandatory; margin: 0 -16px; padding: 0 16px 10px; scroll-padding-inline: 16px; }
  .cm-lp-board-col { scroll-snap-align: start; }
  .cm-lp-list-row.cm-lp-board-card { padding: 12px 14px; }
  .cm-lp-board-card .cm-lp-list-value:not(:last-child) { display: inline; }
  .cm-lp-list-menu { max-width: calc(100vw - 32px); }
  .cm-lp-list-menu-item { height: 44px; font-size: 16px; }
  .cm-lp-list-menu-new { height: 40px; font-size: 16px; }
}
`;
