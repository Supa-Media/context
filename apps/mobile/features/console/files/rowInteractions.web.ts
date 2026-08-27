import { useCallback, useEffect, useRef } from "react";
import { AUTO_EXPAND_MS, type DragModifier } from "./dnd";
import type { RowInteractionOptions, RowInteractions } from "./rowInteractions";

export type { RowInteractionOptions, RowInteractions };
export { LONG_PRESS_MS } from "./rowInteractions";

/**
 * Right-click and drag on a tree row — the pointer half.
 *
 * ## Why this is a ref and DOM listeners rather than props
 *
 * react-native-web's `Pressable` forwards neither `onContextMenu` nor the
 * HTML5 drag events, and there is no prop spelling for `draggable`. Reaching
 * the underlying node is the only way, and it is a deliberate, contained
 * escape hatch rather than a workaround: the *rules* stay in `dnd.ts`, and
 * everything here is plumbing that turns a DOM event into a call into them.
 *
 * ## `contextmenu` covers both pointers and phone browsers
 *
 * A phone has no right button, but mobile Safari and Chrome both raise
 * `contextmenu` on a long press. So the web build binds one listener and gets
 * the correct gesture on a desktop and on a phone browser, while the native
 * build (`rowInteractions.ts`) uses `onLongPress`. That is why the menu is not
 * gated on width — a touchscreen laptop should get both, and it does.
 *
 * ## Never suppress a menu you are not going to answer
 *
 * `preventDefault()` on `contextmenu` is what stops the *browser's* menu from
 * opening over ours, so it is called only on the path that actually opens
 * ours. `onMenu` is optional, and a row without one — the read-only landing
 * demo, and any surface that has nothing to offer this row — is left entirely
 * alone: right-click gets the browser's own menu, which is the correct answer
 * when the application has none. Suppressing first and deciding afterwards
 * looks harmless and is not: the native menu is gone by the time anything
 * downstream discovers there was nothing to show, so the row silently eats the
 * gesture and the person is left with no menu at all.
 *
 * The check reads `latest.current` rather than closing over the option, so a
 * row that gains or loses its menu while mounted is answered by whatever is
 * true now — the same rule every other option in here follows.
 *
 * ## The `dragover` rules are counter-intuitive and both matter
 *
 * `preventDefault()` on `dragover` is what *permits* a drop; without it the
 * browser refuses every one and the row silently does nothing. So it is called
 * only when `canDrop` is true, which is what makes an illegal target show the
 * `no-drop` cursor instead of a plausible-looking one. And `dragenter` fires
 * for descendants too, so an unbalanced enter/leave pair leaves a row stuck
 * highlighted — the depth counter below is what stops that.
 *
 * ## Every listener is removed again, and `draggable` is written live
 *
 * The ref returns a cleanup — React 19's ref-cleanup contract, which is also
 * what stops React calling the ref a second time with `null`. Without it,
 * anything that hands the same hook a second node (a `<StrictMode>` double
 * mount, or one added dependency below turning the callback's identity
 * unstable) leaves the first set of listeners attached to a live element: two
 * `contextmenu` handlers is a menu that opens twice, and two `drop` handlers is
 * a *doubled move*, which is a data change rather than a cosmetic one.
 *
 * `draggable` is an attribute rather than a listener, so it cannot be read
 * through `latest` at event time the way everything else is. It is written on
 * attach and rewritten on every render instead, because `canDrag` genuinely
 * changes under a mounted row — the console goes read-only, or `privacy.md`
 * appears — and an attribute written once is a row that stays pickable after
 * the answer changed.
 */
export function useRowInteractions(options: RowInteractionOptions): RowInteractions {
  // The options are read inside listeners that are attached once. A ref keeps
  // them current without tearing every listener down on each render — the tree
  // re-renders on every keystroke in the filter box.
  const latest = useRef(options);
  latest.current = options;

  /**
   * `dragenter`/`dragleave` fire for descendant nodes as well as the row, so a
   * naive pair leaves the row lit after the pointer has gone. Counting depth is
   * the standard fix and the reason it is here rather than a boolean.
   */
  const depth = useRef(0);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The node this hook is currently attached to, or null between attachments. */
  const attached = useRef<HTMLElement | null>(null);

  const clearExpand = useCallback(() => {
    if (expandTimer.current !== null) {
      clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  }, []);

  useEffect(() => clearExpand, [clearExpand]);

  /**
   * Deliberately without a dependency array: `canDrag` is read from `latest`,
   * which React cannot see, so the only correct time to re-check it is every
   * render. One `setAttribute` against a value the browser already holds is
   * cheaper than the bug it removes.
   */
  useEffect(() => {
    attached.current?.setAttribute("draggable", latest.current.canDrag ? "true" : "false");
  });

  const ref = useCallback(
    (node: unknown) => {
      const element = node as HTMLElement | null;
      if (element === null || typeof element.addEventListener !== "function") return;

      const onContextMenu = (event: MouseEvent) => {
        const onMenu = latest.current.onMenu;
        // Decide *before* suppressing. See "Never suppress a menu you are not
        // going to answer" above: with no handler this row has no menu, and
        // the browser's own is better than none.
        if (onMenu === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onMenu({ x: event.clientX, y: event.clientY });
      };

      const onDragStart = (event: DragEvent) => {
        const current = latest.current;
        if (!current.canDrag) {
          event.preventDefault();
          return;
        }
        // `effectAllowed` is what makes the browser offer copy when ⌥ is held;
        // without it a modified drag still reports "move".
        if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "copyMove";
        current.onDragStart(current.path);
      };

      const onDragEnter = (event: DragEvent) => {
        const current = latest.current;
        depth.current += 1;
        if (!current.canDrop) return;
        current.onDragOver(current.path, modifiersOf(event));

        // Hovering a closed folder opens it, so a drop can reach something that
        // was not on screen when the drag began.
        if (expandTimer.current === null) {
          expandTimer.current = setTimeout(() => {
            expandTimer.current = null;
            latest.current.onDragOver(latest.current.path, []);
          }, AUTO_EXPAND_MS);
        }
      };

      const onDragOver = (event: DragEvent) => {
        const current = latest.current;
        if (!current.canDrop) {
          // Say no clearly. Not calling preventDefault is what refuses the
          // drop; the cursor is what tells somebody before they let go.
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "none";
          return;
        }
        // Counter-intuitive and load-bearing: preventDefault *permits* a drop.
        event.preventDefault();
        if (event.dataTransfer !== null) {
          event.dataTransfer.dropEffect = modifiersOf(event).includes("copy") ? "copy" : "move";
        }
      };

      const onDragLeave = () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current > 0) return;
        clearExpand();
        latest.current.onDragLeave(latest.current.path);
      };

      const onDrop = (event: DragEvent) => {
        const current = latest.current;
        depth.current = 0;
        clearExpand();
        if (!current.canDrop) return;
        event.preventDefault();
        event.stopPropagation();
        current.onDrop(current.path, modifiersOf(event));
      };

      const onDragEnd = () => {
        depth.current = 0;
        clearExpand();
        latest.current.onDragEnd();
      };

      /**
       * One table, walked twice. Attaching and detaching from the same list is
       * what makes "seven added, seven removed" checkable by reading it, rather
       * than a pair of blocks that have to be diffed against each other.
       */
      const listeners: [string, EventListener][] = [
        ["contextmenu", onContextMenu as EventListener],
        ["dragstart", onDragStart as EventListener],
        ["dragenter", onDragEnter as EventListener],
        ["dragover", onDragOver as EventListener],
        ["dragleave", onDragLeave as EventListener],
        ["drop", onDrop as EventListener],
        ["dragend", onDragEnd as EventListener],
      ];

      element.setAttribute("draggable", latest.current.canDrag ? "true" : "false");
      for (const [type, handler] of listeners) element.addEventListener(type, handler);
      attached.current = element;

      return () => {
        for (const [type, handler] of listeners) element.removeEventListener(type, handler);
        if (attached.current === element) attached.current = null;
        // A row torn down mid-drag would otherwise leave both behind: a depth
        // count that never returns to zero, and a timer that fires against a
        // path nothing is showing.
        depth.current = 0;
        clearExpand();
      };
    },
    [clearExpand],
  );

  return { pressableProps: {}, ref };
}

/**
 * Which modifiers the drop should honour.
 *
 * `altKey` is ⌥ on a Mac and Alt elsewhere, which is the copy modifier on both
 * — the same key the platform's own file manager uses, so nobody has to learn
 * a new one.
 */
function modifiersOf(event: DragEvent): DragModifier[] {
  return event.altKey ? ["copy"] : [];
}
