export interface ResizeEdgeProps {
  /** The column's name, for the edge's label. */
  name: string;
  /** Being dragged now: the bar stays drawn. */
  active: boolean;
  /** The colour of the bar on hover and while dragging. */
  color: string;
  onStart: () => void;
  /** How far the pointer has moved since the press, in pixels. */
  onMove: (moved: number) => void;
  onEnd: () => void;
  /** A double-click: fit the column to its values. */
  onFit: () => void;
  onHover: (over: boolean) => void;
}
