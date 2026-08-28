import type { DragModifier } from "./dnd";

/** The contract shared by the native and browser gesture implementations. */
export interface RowInteractionOptions {
  path: string;
  onMenu?: (anchor: { x: number; y: number }) => void;
  canDrag: boolean;
  canDrop: boolean;
  onDragStart: (path: string) => void;
  onDragOver: (path: string, modifiers: readonly DragModifier[]) => void;
  onDragLeave: (path: string) => void;
  onDrop: (path: string, modifiers: readonly DragModifier[]) => void;
  onDragEnd: () => void;
}

export interface RowInteractions {
  /** Spread onto the row's `Pressable`. */
  pressableProps: {
    onLongPress?: () => void;
    delayLongPress?: number;
  };
  /** Attached to the row's outer view on web; unused on native. */
  ref?: (node: unknown) => void;
}

/** Deliberately quicker than React Native's 500ms default. */
export const LONG_PRESS_MS = 400;
