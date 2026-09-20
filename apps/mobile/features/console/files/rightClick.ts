/**
 * A right-click target that is not a tree row — the native half, which is
 * nothing.
 *
 * The tree's own rows go through `rowInteractions`, which carries the drag
 * wiring as well; this is for everything else that has a menu and nothing to
 * pick up: the empty space under a listing, a row in the folder view, a
 * breadcrumb segment, a tab.
 *
 * A phone has neither a right button nor any of those surfaces laid out for a
 * pointer, and the gesture that opens a menu there is a long press on a row,
 * which `rowInteractions.ts` already carries. So this exists to give the web
 * file a shape to be the other half of, and returns a ref nothing attaches.
 *
 * See `rightClick.web.ts` for the rules the browser half has to follow.
 */
export interface RightClick {
  /** Attached to the filler view on web; unused on native. */
  ref?: (node: unknown) => void;
}

/**
 * `onMenu` returns whether it actually opened something. See the web half —
 * the answer decides whether the browser's own menu is suppressed.
 */
export function useRightClick(
  _onMenu?: (anchor: { x: number; y: number }) => boolean,
): RightClick {
  return {};
}
