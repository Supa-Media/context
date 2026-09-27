/** What a Board card and column hand the drag hooks; see `boardDrag.web.ts`. */

/** A ref callback for a `View`, answered with the DOM node on web. */
export type DomRef = (node: unknown) => (() => void) | void;

export interface CardDragOptions {
  /** The card's item path, which the drag carries. */
  path: string;
  /** Only an owner or editor picks a card up. */
  enabled: boolean;
  onStart(): void;
  onEnd(): void;
}

export interface ColumnDropOptions {
  enabled: boolean;
  /** A card is over the column, or has left it. */
  onOver(over: boolean): void;
  /** A card was let go of here. */
  onDrop(path: string): void;
}
