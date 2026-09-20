/**
 * Where a floating box goes, given where the pointer was.
 *
 * Lifted out of `Menu.web.tsx` when the editor's table-size picker became the
 * second thing that opens at a pointer and has to survive the edges of the
 * window. The rule it encodes is the one that decides whether a context menu
 * feels broken, and `Menu.web.tsx`'s own header is where it is argued:
 *
 * > A menu opened near an edge must flip, not clip. Right-clicking the last row
 * > of the tree, or a row near the right edge of the window, is not an edge
 * > case — it is where the interesting rows are. A popover that renders
 * > down-right unconditionally puts "Delete forever…" underneath the bottom of
 * > the window where no amount of scrolling reaches it, because the popover is
 * > `fixed` and the page behind it does not scroll it into view.
 *
 * A second copy of that arithmetic beside the picker is the version that gets
 * fixed once. Nothing here imports React or react-native, so it is checkable in
 * plain node — which is the point, because every branch in it is a window edge
 * nobody is looking at when they test in the middle of a large screen.
 */

/** Never closer to the edge of the window than this. */
export const MARGIN = 8;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Place a box of `size` at `x, y`, flipping rather than clipping.
 *
 * `across` is for a submenu, which does not start at the pointer: its natural
 * place is *beside* its parent, so when it flips it must flip back across the
 * parent's whole width rather than across a point. The caller passes that
 * width.
 *
 * `minHeight` is the floor a box may not be squeezed below when the window is
 * shorter than it — one row, for a menu — after which it scrolls inside itself
 * rather than shrinking to nothing.
 */
export function place(
  x: number,
  y: number,
  size: { width: number; height: number },
  view: Viewport,
  options: { across?: number; minHeight?: number } = {},
): Box {
  const { across = 0, minHeight = 0 } = options;
  const height = Math.min(size.height, Math.max(minHeight, view.height - MARGIN * 2));

  let left = x;
  if (left + size.width > view.width - MARGIN) left = x - size.width - across;
  // A window narrower than the box has no side that fits; sit against the left
  // edge rather than off either one.
  if (left < MARGIN) left = Math.max(MARGIN, Math.min(x, view.width - MARGIN - size.width));

  let top = y;
  if (top + height > view.height - MARGIN) top = y - height;
  if (top < MARGIN) top = MARGIN;

  return { left, top, width: size.width, height };
}
