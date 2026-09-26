/**
 * `as: board`: the same rows as a grouped list, drawn as columns of cards.
 *
 * Nothing about a board is stored anywhere but the block. Its columns are the
 * group's values — the ones the rows have, and the ones the rest of the listed
 * notes use, so "paused" is somewhere to drop a card even while nothing is
 * paused — in the order a grouped list draws them, with "No status" last and
 * only while something is in it. Dragging a card to another column is the
 * value menu's choice made with a hand: the host writes that one frontmatter
 * line, and the card moves at once.
 *
 * A drag is a pointer's shortcut and never the only way: every card carries
 * its own value as the same button the list draws, so a keyboard or a phone
 * (where HTML drag and drop does not reach) moves it through the menu.
 *
 * Plain DOM, drawn by the list widget, for the reason `panel.ts` gives.
 */

import { valueChoices } from "./valueMenu";
import { groupLabel } from "./words";
import type { ListConfig, ListNote, ListRow } from "./model";

export interface BoardHost {
  /** The notes the rows came from, for the columns nothing is in yet. */
  readonly notes: readonly ListNote[];
  /** Whether a card can be moved at all. */
  readonly canMove: boolean;
  /** A card's face: its title, progress and values, as the list draws them. */
  drawCard(row: ListRow): HTMLElement;
  /** A card was dropped on a column; `null` is the unset column. */
  move(path: string, value: string | null): void;
}

const DRAG_TYPE = "application/x-context-list-card";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The columns a board draws, in order; `""` is the unset column. */
export function boardColumns(rows: readonly ListRow[], notes: readonly ListNote[], key: string): string[] {
  const present = rows.map((row) => row.group ?? "");
  const known = new Set(present.filter((value) => value !== "").map((value) => value.toLowerCase()));
  const columns = present.filter((value, index) => value !== "" && present.indexOf(value) === index);
  // valueChoices is already in group order; merge the unused words in at their place.
  const order = valueChoices(notes, key);
  for (const word of order) if (!known.has(word.toLowerCase())) columns.push(word);
  const rank = (value: string) => {
    const at = order.findIndex((word) => word.toLowerCase() === value.toLowerCase());
    return at === -1 ? order.length + columns.indexOf(value) : at;
  };
  columns.sort((a, b) => rank(a) - rank(b));
  if (present.includes("")) columns.push("");
  return columns;
}

export function drawBoard(rows: readonly ListRow[], config: ListConfig, host: BoardHost): HTMLElement {
  const key = config.group ?? "status";
  const board = el("div", "cm-lp-board");
  board.setAttribute("role", "list");
  for (const column of boardColumns(rows, host.notes, key)) {
    const cards = rows.filter((row) => (row.group ?? "").toLowerCase() === column.toLowerCase());
    const lane = el("section", "cm-lp-board-col");
    lane.setAttribute("role", "listitem");
    lane.dataset.value = column;
    const head = el("div", "cm-lp-board-head", groupLabel(key, column));
    head.append(el("span", "cm-lp-list-group-count", String(cards.length)));
    const body = el("div", "cm-lp-board-cards");
    for (const row of cards) body.append(card(row, host));
    if (cards.length === 0) body.append(el("div", "cm-lp-board-empty", "Nothing here"));
    lane.append(head, body);
    if (host.canMove) acceptDrops(lane, column, host);
    board.append(lane);
  }
  return board;
}

function card(row: ListRow, host: BoardHost): HTMLElement {
  const face = host.drawCard(row);
  face.classList.add("cm-lp-board-card");
  if (host.canMove) {
    face.draggable = true;
    face.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData(DRAG_TYPE, row.path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      face.classList.add("cm-lp-board-dragging");
    });
    face.addEventListener("dragend", () => face.classList.remove("cm-lp-board-dragging"));
  }
  return face;
}

function acceptDrops(lane: HTMLElement, column: string, host: BoardHost): void {
  const carries = (event: DragEvent) => event.dataTransfer?.types.includes(DRAG_TYPE) === true;
  lane.addEventListener("dragover", (event) => {
    if (!carries(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    lane.classList.add("cm-lp-board-over");
  });
  lane.addEventListener("dragleave", (event) => {
    if (!lane.contains(event.relatedTarget as Node | null)) lane.classList.remove("cm-lp-board-over");
  });
  lane.addEventListener("drop", (event) => {
    lane.classList.remove("cm-lp-board-over");
    const path = event.dataTransfer?.getData(DRAG_TYPE);
    if (!path) return;
    event.preventDefault();
    host.move(path, column === "" ? null : column);
  });
}
