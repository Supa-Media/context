import { useCallback, useEffect, useRef } from "react";
import { AUTO_EXPAND_MS, type DragModifier } from "./dnd";
import { isApplePlatform } from "../../design/applePlatform";
import { anchorUnder, isMenuKey } from "./menuKey";
import type { RowInteractionOptions, RowInteractions } from "./rowInteractionContract";
import type { PickGesture } from "./selection";

export type { RowInteractionOptions, RowInteractions } from "./rowInteractionContract";
export { LONG_PRESS_MS } from "./rowInteractionContract";

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
 * ## Shift is the way back to the browser
 *
 * Even on a row that *does* have a menu, holding shift skips the suppression
 * and lets the platform menu through. This repository is public and
 * self-hosting is a supported path: a console that eats `contextmenu`
 * unconditionally has taken Inspect, View Source and "Copy image" from
 * everybody who works on it, and there is no other gesture that asks for them.
 * VS Code and Figma both spell this escape hatch the same way, so it is the one
 * a person is most likely to already have in their hands.
 *
 * Shift alone, and deliberately not "any modifier": ⌘ or ctrl with a right
 * click is a selection gesture on some platforms and ⌥ is this app's own copy
 * modifier for drags, so treating those as a request for the browser's menu
 * would make the console's own menu unreachable for somebody holding a key out
 * of habit.
 *
 * ## A modified click is caught on its way down, before the row sees it
 *
 * ⌘-click (ctrl-click off a Mac) and shift-click pick rows instead of opening
 * them — see `selection.ts`. react-native-web's `Pressable` fires `onPress`
 * from the `click` event and hands it no modifiers, so the row cannot tell a
 * plain press from a modified one. This listens for `click` in the *capture*
 * phase on the row's outer node, which runs before the event reaches the
 * pressable inside it: a modified click is answered here and stopped, so the
 * note does not also open; a plain one is left alone and opens exactly as
 * before.
 *
 * Which key toggles follows the platform, and has to: on a Mac ctrl-click *is*
 * a right-click, and it is already this row's menu.
 *
 * Shift is also stopped at `mousedown`, where the browser would otherwise
 * start a text selection from the last click to this one — a blue wash across
 * every name in between, drawn over the very range being picked.
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
 * Without a detach, anything that hands the same hook a second node — a
 * `<StrictMode>` double mount, or one added dependency below turning the ref
 * callback's identity unstable — leaves the first set of listeners attached to
 * a live element. Two `contextmenu` handlers is a menu that opens twice, and
 * two `drop` handlers is a *doubled move*, which is a data change rather than a
 * cosmetic one.
 *
 * **React 19's ref-cleanup return is not enough on its own here, and believing
 * it was is how this would look fixed while leaking.** The ref is handed to a
 * react-native-web `View`, which merges it through `mergeRefs`: that wrapper
 * calls `ref(node)` and *discards the return value*, so React only ever sees
 * the wrapper's own `undefined` and goes on detaching the old way — by calling
 * the ref again with `null`. So the detach is held in a ref and run on every
 * call, whatever prompted it:
 *
 *  - `null` — the react-native-web path, and today the only one that fires;
 *  - a *different* node — the re-attach case, where the old element is still
 *    live and still listening;
 *  - the returned cleanup — React's own contract, honoured by any host that
 *    passes the ref through untouched, and by the tests that drive it directly.
 *
 * All three land on the same idempotent `release`, so belt and braces cannot
 * double-remove or double-fire.
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
  /** How to let go of it. Null exactly when `attached` is. */
  const release = useRef<(() => void) | null>(null);

  const clearExpand = useCallback(() => {
    if (expandTimer.current !== null) {
      clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  }, []);

  useEffect(() => clearExpand, [clearExpand]);

  /**
   * The last resort, for a host that neither returns the cleanup nor calls the
   * ref with `null`. Nothing in this app is such a host — but a listener left
   * on a detached row is invisible until the day it is not, and this is one
   * line.
   */
  useEffect(() => () => release.current?.(), []);

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
      // Let go of whatever came before, whether this call is a detach (`null`)
      // or a re-attach to a different element.
      release.current?.();

      const element = node as HTMLElement | null;
      if (element === null || typeof element.addEventListener !== "function") return;

      const onContextMenu = (event: MouseEvent) => {
        const onMenu = latest.current.onMenu;
        // Decide *before* suppressing. See "Never suppress a menu you are not
        // going to answer" above: with no handler this row has no menu, and
        // the browser's own is better than none.
        if (onMenu === undefined) return;
        // Shift is a request for the browser's menu — see "Shift is the way
        // back to the browser" in the header. Return before suppressing, so
        // the platform menu opens and ours does not race it.
        if (event.shiftKey) return;
        /*
          Opened first, suppressed second — and only if it opened.

          `preventDefault()` is what removes the browser's menu, so calling it
          for a handler that then declines leaves the person with no menu at
          all. A tree row always has something to offer and answers `void`,
          which reads as "it opened"; a folder listing's row can genuinely
          have nothing, and says so. The call is still inside the handler, so
          the suppression is in time either way — the same order, and the same
          reasoning, as `rightClick.web.ts`.
        */
        if (onMenu({ x: event.clientX, y: event.clientY }) === false) return;
        event.preventDefault();
        event.stopPropagation();
      };

      /**
       * The keyboard's way into the same menu. See `menuKey.ts`.
       *
       * On the row's own node rather than on the document: `keydown` bubbles
       * from the focused pressable inside, so this hears it exactly when this
       * row is the one focused — and a document listener would have to work out
       * *which* row the menu is about, which is the question focus has already
       * answered.
       */
      const onKeyDown = (event: KeyboardEvent) => {
        const onMenu = latest.current.onMenu;
        // Decide before suppressing, the same rule the pointer path follows.
        if (onMenu === undefined || !isMenuKey(event)) return;
        if (onMenu(anchorUnder(element)) === false) return;
        event.preventDefault();
        event.stopPropagation();
      };

      const onClick = (event: MouseEvent) => {
        const onPick = latest.current.onPick;
        if (onPick === undefined) return;
        const gesture = pickGestureOf(event);
        if (gesture === null) return;
        event.preventDefault();
        event.stopPropagation();
        onPick(gesture);
      };

      const onMouseDown = (event: MouseEvent) => {
        if (latest.current.onPick !== undefined && event.shiftKey) event.preventDefault();
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
       * what makes "everything added is removed" checkable by reading it, rather
       * than a pair of blocks that have to be diffed against each other.
       */
      const listeners: [string, EventListener, boolean?][] = [
        ["click", onClick as EventListener, true],
        ["mousedown", onMouseDown as EventListener],
        ["contextmenu", onContextMenu as EventListener],
        ["keydown", onKeyDown as EventListener],
        ["dragstart", onDragStart as EventListener],
        ["dragenter", onDragEnter as EventListener],
        ["dragover", onDragOver as EventListener],
        ["dragleave", onDragLeave as EventListener],
        ["drop", onDrop as EventListener],
        ["dragend", onDragEnd as EventListener],
      ];

      element.setAttribute("draggable", latest.current.canDrag ? "true" : "false");
      for (const [type, handler, capture] of listeners) {
        element.addEventListener(type, handler, capture === true);
      }
      attached.current = element;

      const detach = () => {
        // Idempotent by identity: three different callers may reach this, and
        // the two that arrive second must do nothing rather than tear down a
        // *newer* attachment that has since taken this one's place.
        if (release.current !== detach) return;
        release.current = null;
        for (const [type, handler, capture] of listeners) {
          element.removeEventListener(type, handler, capture === true);
        }
        if (attached.current === element) attached.current = null;
        // A row torn down mid-drag would otherwise leave both behind: a depth
        // count that never returns to zero, and a timer that fires against a
        // path nothing is showing.
        depth.current = 0;
        clearExpand();
      };

      release.current = detach;
      return detach;
    },
    [clearExpand],
  );

  return { pressableProps: {}, ref };
}

/**
 * Which pick a click is, or `null` for a plain one.
 *
 * Shift wins over ⌘ when both are held, the way it does in Finder: the range
 * is the bigger gesture and the one a person reaching for both most likely
 * meant.
 */
function pickGestureOf(event: MouseEvent): PickGesture | null {
  if (event.button !== 0) return null;
  if (event.shiftKey) return "range";
  if (isApplePlatform() ? event.metaKey : event.ctrlKey) return "toggle";
  return null;
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
