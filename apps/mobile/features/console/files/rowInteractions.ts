import type { DragModifier } from "./dnd";

/**
 * Right-click, long-press and drag on a tree row — the native half.
 *
 * A `.ts` / `.web.ts` pair, the same split this repo already uses for the
 * clipboard, the fonts and the sign-out redirect. The split exists because the
 * two platforms disagree about the *gesture*, not about the rule: a pointer
 * raises a menu with a right button and drags with a pressed one, and a
 * touchscreen has neither. What both call afterwards is the same `menu.ts` and
 * the same `dnd.ts`, so a refusal cannot exist on one surface and be missing on
 * the other.
 *
 * On native this returns `onLongPress` and nothing else. Drag-and-drop between
 * rows on a touchscreen wants a real gesture handler with an animated pick-up,
 * and doing it badly — a row that follows a finger with no drop feedback — is
 * worse than not having it, because there is no cursor to say the drop is
 * refused. Long-press → action sheet → "Move to…" reaches the same
 * `moveEntry`, and it is the interaction a phone user expects anyway. The
 * options a native build cannot honour are accepted and ignored rather than
 * removed from the type, so the call sites stay identical.
 */
export interface RowInteractionOptions {
  path: string;
  /**
   * Raise the menu. The anchor is where the pointer was; touch ignores it.
   *
   * Optional, and its absence is the whole answer: a row with no menu — the
   * read-only landing demo, a surface with nothing to offer this row — gets no
   * gesture wired for one, rather than a gesture that fires into nothing. Both
   * halves honour that, and each in the way its platform needs: this one
   * offers no `onLongPress`, and the web half leaves `contextmenu`
   * un-suppressed so the browser's own menu still opens.
   */
  onMenu?: (anchor: { x: number; y: number }) => void;
  /** False for `privacy.md`, and for a read-only console. */
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
  /** Attached to the row's outer view on web; unused here. */
  ref?: (node: unknown) => void;
}

/**
 * 400ms rather than React Native's 500ms default.
 *
 * Long enough not to fire while somebody is scrolling the tree with a drag,
 * short enough that the sheet does not feel like it is deciding whether to
 * appear. iOS's own context menus sit around here.
 */
export const LONG_PRESS_MS = 400;

export function useRowInteractions(options: RowInteractionOptions): RowInteractions {
  const onMenu = options.onMenu;
  // A long press with nowhere to send it would open nothing *and* swallow the
  // tap that was meant to select the row.
  if (onMenu === undefined) return { pressableProps: {} };

  return {
    pressableProps: {
      onLongPress: () => onMenu({ x: 0, y: 0 }),
      delayLongPress: LONG_PRESS_MS,
    },
  };
}
