/**
 * Right-click on the empty space of a listing — the native half, which is
 * nothing.
 *
 * A phone reaches a folder's contents through `FolderView` and has no empty
 * space to speak of below them; the gesture that opens a menu there is a long
 * press on a *row*, which `rowInteractions.ts` already carries. So this exists
 * to give the web file a shape to be the other half of, and returns a ref that
 * nothing attaches.
 *
 * See `backgroundMenu.web.ts` for the rules the browser half has to follow.
 */
export interface BackgroundMenu {
  /** Attached to the filler view on web; unused on native. */
  ref?: (node: unknown) => void;
}

/**
 * `onMenu` returns whether it actually opened something. See the web half —
 * the answer decides whether the browser's own menu is suppressed.
 */
export function useBackgroundMenu(
  _onMenu?: (anchor: { x: number; y: number }) => boolean,
): BackgroundMenu {
  return {};
}
