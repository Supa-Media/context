import {
  LONG_PRESS_MS,
  type RowInteractionOptions,
  type RowInteractions,
} from "./rowInteractionContract";

export type { RowInteractionOptions, RowInteractions } from "./rowInteractionContract";
export { LONG_PRESS_MS } from "./rowInteractionContract";

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
