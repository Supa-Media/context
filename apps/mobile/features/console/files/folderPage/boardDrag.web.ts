import { useCallback, useEffect, useRef } from "react";
import type { CardDragOptions, ColumnDropOptions, DomRef } from "./boardDragContract";

export type { CardDragOptions, ColumnDropOptions, DomRef } from "./boardDragContract";

/**
 * Dragging a folder page's Board card to another column — the pointer half.
 *
 * HTML5 drag and drop, bound to the DOM node under a react-native-web `View`,
 * for the reason `rowInteractions.web.ts` gives: `Pressable` forwards none of
 * the drag events and has no `draggable` prop. The list block's board
 * (`listBlock/board.ts`) is the same gesture in plain DOM, and this follows
 * it: a card carries its path under its own type, a column only accepts a drag
 * carrying that type (so a file dragged in from the desktop or a tree row is
 * never taken), and a drop is a request — what it writes is decided by
 * `dropValue` in `model.ts` and made through the page's one `choose`.
 *
 * Every listener is let go of again on any re-attach, detach or unmount, and
 * `draggable` is rewritten on every render, both for the reasons argued at
 * length in `rowInteractions.web.ts`: react-native-web discards a ref
 * callback's cleanup, and whether a card can move changes under a mounted one.
 */

const DRAG_TYPE = "application/x-context-folder-card";

function carries(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(DRAG_TYPE);
}

/** A ref that attaches `bind` to one DOM node at a time and always lets go. */
function useDomBinding(bind: (element: HTMLElement) => () => void): { ref: DomRef; node: { readonly current: HTMLElement | null } } {
  const node = useRef<HTMLElement | null>(null);
  const release = useRef<(() => void) | null>(null);
  const latestBind = useRef(bind);
  latestBind.current = bind;
  useEffect(() => () => release.current?.(), []);
  const ref = useCallback((value: unknown) => {
    release.current?.();
    release.current = null;
    node.current = null;
    const element = value as HTMLElement | null;
    if (element === null || typeof element.addEventListener !== "function") return;
    node.current = element;
    const unbind = latestBind.current(element);
    let done = false;
    release.current = () => {
      if (done) return;
      done = true;
      unbind();
      if (node.current === element) node.current = null;
    };
    return release.current;
  }, []);
  return { ref, node };
}

export function useCardDrag(options: CardDragOptions): DomRef {
  const latest = useRef(options);
  latest.current = options;
  const { ref, node } = useDomBinding((element) => {
    element.setAttribute("draggable", latest.current.enabled ? "true" : "false");
    const start = (event: DragEvent) => {
      if (!latest.current.enabled) return;
      event.dataTransfer?.setData(DRAG_TYPE, latest.current.path);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      latest.current.onStart();
    };
    const end = () => latest.current.onEnd();
    element.addEventListener("dragstart", start);
    element.addEventListener("dragend", end);
    return () => {
      element.removeEventListener("dragstart", start);
      element.removeEventListener("dragend", end);
    };
  });
  useEffect(() => {
    node.current?.setAttribute("draggable", latest.current.enabled ? "true" : "false");
  });
  return ref;
}

export function useColumnDrop(options: ColumnDropOptions): DomRef {
  const latest = useRef(options);
  latest.current = options;
  const { ref } = useDomBinding((element) => {
    // `dragenter`/`dragleave` fire for every card inside too; a depth count keeps the column lit.
    let depth = 0;
    const accepts = (event: DragEvent) => latest.current.enabled && carries(event);
    const enter = (event: DragEvent) => {
      if (!accepts(event)) return;
      depth += 1;
      latest.current.onOver(true);
    };
    const over = (event: DragEvent) => {
      if (!accepts(event)) return;
      // Permitting the drop is `preventDefault` here; a column that will not take it leaves the no-drop cursor.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      latest.current.onOver(true);
    };
    const leave = (event: DragEvent) => {
      if (!accepts(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) latest.current.onOver(false);
    };
    const drop = (event: DragEvent) => {
      depth = 0;
      latest.current.onOver(false);
      if (!accepts(event)) return;
      const path = event.dataTransfer?.getData(DRAG_TYPE);
      if (!path) return;
      event.preventDefault();
      latest.current.onDrop(path);
    };
    element.addEventListener("dragenter", enter);
    element.addEventListener("dragover", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragenter", enter);
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
    };
  });
  return ref;
}
