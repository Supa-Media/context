/**
 * How `safeArea.test.ts` measures a mounted tree in jsdom: padding, scrollers and where a scroller's viewport
 * begins. Pure DOM reads, no React; split out to keep that file under the size limit.
 */

export function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Whether this element can scroll its own overflow. */
export function scrolls(node: Element): boolean {
  const overflowY = window.getComputedStyle(node).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

export function ownPadding(node: Element): { top: number; bottom: number } {
  const style = window.getComputedStyle(node);
  return { top: px(style.paddingTop), bottom: px(style.paddingBottom) };
}

/** Every element between this one and the container, nearest first. */
export function ancestorsOf(node: Element, container: Element): Element[] {
  const chain: Element[] = [];
  let current = node.parentElement;
  while (current !== null && current !== container) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

/**
 * The distance from the top of a surface to its first line, at rest.
 *
 * A `ScreenScroll` is now two boxes rather than one: the marked `View` carries
 * the system's band, and the `ScrollView` inside it carries our chrome on its
 * content container. Both count towards where the first line lands, so the
 * spine is walked — but only *through a scroller*, which is what stops this
 * quietly crediting a surface with the padding of whatever happens to be its
 * first child.
 */
export function paddingOf(element: Element): { top: number; bottom: number } {
  const total = ownPadding(element);
  const scroller = element.firstElementChild;
  if (scroller === null || !scrolls(scroller)) return total;
  for (const node of [scroller, scroller.firstElementChild]) {
    if (!(node instanceof Element)) continue;
    const padding = ownPadding(node);
    total.top += padding.top;
    total.bottom += padding.bottom;
  }
  return total;
}

/**
 * How far down the glass a scroller's viewport begins.
 *
 * **Only what is outside it counts.** Content inside a scroll container is
 * clipped at that container's padding box, so it can ride up to exactly this
 * point and no further — which makes this the highest position any word on the
 * screen can reach, and the only number the notch can be compared against once
 * somebody has swiped. Padding on the scroller's own `style` does not count
 * either, and that is not an oversight: a scroll container's content scrolls
 * *into* its padding-top band and is clipped at the border box, so a
 * `paddingTop` there buys a resting offset and nothing else.
 */
export function viewportTopOf(scroller: Element, container: Element): number {
  return ancestorsOf(scroller, container).reduce((total, node) => {
    const style = window.getComputedStyle(node);
    return total + px(style.paddingTop) + px(style.marginTop) + px(style.borderTopWidth);
  }, 0);
}
