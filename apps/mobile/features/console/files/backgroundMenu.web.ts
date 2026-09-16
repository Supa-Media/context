import { useCallback, useRef } from "react";
import type { BackgroundMenu } from "./backgroundMenu";

export type { BackgroundMenu } from "./backgroundMenu";

/**
 * Right-click on the empty space of a listing.
 *
 * The same DOM escape hatch `rowInteractions.web.ts` uses and for the same
 * reason — react-native-web forwards no `onContextMenu` — but the rules around
 * *when to suppress* are different enough to be worth stating, because this
 * listener sits behind every row in the pane and a mistake here breaks the
 * rows rather than the background.
 *
 * ## It must not answer a gesture that was meant for a row
 *
 * A row's own handler calls `stopPropagation()`, so an answered right-click
 * never reaches here. The two cases that *do* bubble through are precisely the
 * two a row declines: a row with no menu at all, and a shift-held gesture. Both
 * must go on declining, so this checks shift itself rather than assuming the
 * row above it already dealt with it — a listener that inherits a rule by
 * accident stops honouring it the moment the row above changes.
 *
 * ## It decides before it suppresses, and needs an answer to do so
 *
 * `preventDefault()` is what removes the browser's menu, so calling it before
 * knowing whether ours will open is how a person ends up with *no* menu: a
 * read-only console has nothing to offer on empty space (`menu.ts` returns an
 * empty list), and a bordered rectangle with nothing in it is not the fallback
 * — the browser's own menu is.
 *
 * `rowInteractions` answers this by checking whether a handler exists at all,
 * which is enough there because a row always has something to offer. Empty
 * space does not, and emptiness is only known once `menu.ts` has run. So
 * `onMenu` reports back: it returns `true` when it opened a menu, and only then
 * is the platform's suppressed. The call is still inside the handler, so
 * `preventDefault` is in time.
 */
export function useBackgroundMenu(
  onMenu?: (anchor: { x: number; y: number }) => boolean,
): BackgroundMenu {
  // Read inside a listener attached once, so the ref keeps it current without
  // tearing the listener down on every render of the tree.
  const latest = useRef(onMenu);
  latest.current = onMenu;

  const release = useRef<(() => void) | null>(null);

  const ref = useCallback((node: unknown) => {
    // Let go of whatever came before, whether this is a detach (`null`) or a
    // re-attach to a different element. See `rowInteractions.web.ts` for why
    // all three detach paths land on one idempotent release.
    release.current?.();

    const element = node as HTMLElement | null;
    if (element === null || typeof element.addEventListener !== "function") return;

    const onContextMenu = (event: MouseEvent) => {
      const handler = latest.current;
      if (handler === undefined) return;
      // Shift is a request for the browser's menu, here as on a row.
      if (event.shiftKey) return;
      if (!handler({ x: event.clientX, y: event.clientY })) return;
      event.preventDefault();
      event.stopPropagation();
    };

    element.addEventListener("contextmenu", onContextMenu as EventListener);

    const detach = () => {
      if (release.current !== detach) return;
      release.current = null;
      element.removeEventListener("contextmenu", onContextMenu as EventListener);
    };
    release.current = detach;
    return detach;
  }, []);

  return { ref };
}
