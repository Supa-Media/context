/**
 * Folder lists of projects: group headings, sub-projects under a twisty, the
 * progress bar, and the menu a status or an owner opens. Split from
 * `lists.ts`, which draws every list, and appended after it.
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
  padding: 18px 0 6px;
  color: var(--lp-content);
  font-size: 0.85em;
  font-weight: 600;
}
.cm-lp-list-group:first-child {
  padding-top: 4px;
}
.cm-lp-list-group-count {
  color: var(--lp-muted);
  opacity: 0.75;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.cm-lp-list-group + .cm-lp-list-row {
  border-top-color: var(--lp-line-strong);
}
.cm-lp-list-row {
  position: relative;
}
.cm-lp-list-twisty {
  flex: none;
  align-self: center;
  width: 18px;
  height: 22px;
  margin: 0 -8px 0 -4px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--lp-muted);
  font: inherit;
  font-size: 0.7em;
  cursor: pointer;
}
.cm-lp-list-twisty:hover {
  background: var(--lp-code-bg);
  color: var(--lp-content);
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
  background: var(--lp-link);
}
.cm-lp-list-sub {
  padding-left: 26px;
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
  width: 12px;
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
  THE VALUE MENU.

  What a status or an owner opens for someone who can change it: the words
  the listed notes already use, a field for a new one, and "No status" to
  clear. It floats over the rows, so unlike the caption's popover it is an
  opaque page-coloured card with a shadow, the one lifted surface in a list.
*/
.cm-lp-list-edit {
  border: 0;
  margin: -2px -6px;
  padding: 2px 6px;
  border-radius: 5px;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.cm-lp-list-value.cm-lp-list-edit {
  width: calc(5.5em + 12px);
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
  background: var(--lp-code-bg);
  color: var(--lp-content);
  opacity: 1;
}
.cm-lp-list-edit:focus-visible {
  outline: 2px solid var(--lp-link);
  outline-offset: 1px;
}
.cm-lp-list-unset {
  opacity: 0.45;
}
.cm-lp-list-menu {
  position: absolute;
  z-index: 5;
  min-width: 180px;
  max-width: 260px;
  box-sizing: border-box;
  padding: 5px;
  border: 1px solid var(--lp-line-strong);
  border-radius: 10px;
  background: var(--lp-bg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  color: var(--lp-content);
  font-size: 13px;
  line-height: 1.4;
}
.cm-lp-list-menu-busy {
  opacity: 0.6;
  pointer-events: none;
}
.cm-lp-list-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cm-lp-list-menu-item:hover,
.cm-lp-list-menu-item:focus-visible {
  background: var(--lp-code-bg);
  outline: none;
}
.cm-lp-list-menu-check {
  flex: none;
  width: 14px;
  color: var(--lp-link);
}
.cm-lp-list-menu-clear {
  color: var(--lp-muted);
}
.cm-lp-list-menu-new {
  display: block;
  width: 100%;
  box-sizing: border-box;
  height: 30px;
  margin-top: 4px;
  padding: 0 8px;
  border: 1px solid var(--lp-line);
  border-radius: 6px;
  background: transparent;
  color: var(--lp-content);
  font: inherit;
}
.cm-lp-list-menu-new:focus {
  outline: 2px solid var(--lp-link);
  outline-offset: -1px;
}
.cm-lp-list-menu-problem:not(:empty) {
  padding: 6px 8px 2px;
  color: var(--lp-danger);
}
/*
  A phone, at the width lists.ts writes out and listBlock.test.ts holds: the
  sub-project indent survives the taller rows, and progress is its count
  alone, so a title keeps the room.
*/
@media (max-width: 879.98px) {
  .cm-lp-list-sub { padding-left: 26px; }
  .cm-lp-list-progress-bar { display: none; }
  .cm-lp-list-menu { max-width: calc(100vw - 32px); }
  .cm-lp-list-menu-item { padding: 10px 8px; }
  .cm-lp-list-menu-new { height: 36px; font-size: 16px; }
}
`;
