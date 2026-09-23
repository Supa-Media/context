import type { DragModifier } from "./dnd";
import type { PickGesture } from "./selection";

/** The contract shared by the native and browser gesture implementations. */
export interface RowInteractionOptions {
  path: string;
  /**
   * Open this row's menu, and say whether one actually opened.
   *
   * `false` means "there was nothing to show", and the web half then leaves
   * the platform's own menu alone rather than suppressing it for a popover
   * that never appears — the rule `rightClick.web.ts` states at length under
   * "It decides before it suppresses, and needs an answer to do so".
   *
   * `void` is the common answer and means the same as `true`: a *tree* row
   * always has something to offer, so `FileTree` has never had to say so. A
   * folder **listing** does not — `menu.ts` returns an empty list for a
   * read-only console — which is why the answer exists at all.
   */
  onMenu?: (anchor: { x: number; y: number }) => boolean | void;
  /**
   * A ⌘/ctrl-click or a shift-click: add this row to a multi-selection, or
   * pick the range up to it, instead of opening it. See `selection.ts`.
   *
   * Absent where there is no selection to add to, and then a modified click
   * is an ordinary click. Web-only in practice — a touchscreen has no
   * modifier keys, so the native half accepts and ignores it.
   */
  onPick?: (gesture: PickGesture) => void;
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
