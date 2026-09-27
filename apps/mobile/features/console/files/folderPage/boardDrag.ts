import type { CardDragOptions, ColumnDropOptions, DomRef } from "./boardDragContract";

export type { CardDragOptions, ColumnDropOptions, DomRef } from "./boardDragContract";

/**
 * Dragging a Board card — the native half, which does nothing.
 *
 * The same split and the same reasoning as `rowInteractions.ts`: a card that
 * follows a finger with no drop feedback is worse than none, and on a phone
 * the card's own status button opens the menu that moves it (a sheet under a
 * thumb). The web half is `boardDrag.web.ts`.
 */
const none: DomRef = () => undefined;

export function useCardDrag(_options: CardDragOptions): DomRef {
  return none;
}

export function useColumnDrop(_options: ColumnDropOptions): DomRef {
  return none;
}
