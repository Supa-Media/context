import { createElement, Fragment, useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

/**
 * THE FILE TREE'S TOOLS, DRAWN IN THE TITLE ROW ABOVE IT.
 *
 * The row over the tree used to hold the sidebar toggle and nothing else, and
 * the owner called it a waste of space (2026-09-28). They chose to move the
 * tree's own tools up into it — filter, new, view — with no `Notes` label,
 * which is what their artboard's option A drew.
 *
 * The tools belong to the tree: their state (the filter's query, the menus,
 * the folder a new note lands in) lives in `Explorer`, while the row is drawn
 * by the frame's top bar, a different branch of the tree. So the frame hands
 * `Explorer` this slot, `Explorer` puts its toolbar in it on every render, and
 * the bar draws whatever is in it. Only the outlet re-renders when the slot
 * changes, never the tree that filled it.
 *
 * `null` from `FrameApi.columnTools` means there is no title row to put them
 * in (a phone, a drawer, a folded tree, or no frame at all), and the tree
 * keeps its header in the column.
 */
export interface ColumnToolsSlot {
  set(node: ReactNode): void;
  get(): ReactNode;
  subscribe(listener: () => void): () => void;
}

export function createColumnToolsSlot(): ColumnToolsSlot {
  let current: ReactNode = null;
  const listeners = new Set<() => void>();
  return {
    set(node) {
      if (node === current) return;
      current = node;
      for (const listener of listeners) listener();
    },
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What the title row draws: the slot's current contents. */
export function ColumnToolsOutlet({ slot }: { slot: ColumnToolsSlot }) {
  const node = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return createElement(Fragment, null, node);
}

/**
 * Put `node` in the title row while there is one, and take it out when the
 * caller unmounts or the row goes away.
 *
 * A layout effect with no dependencies, so the row carries the same render as
 * the tree before the browser paints: a filter keystroke reaches the field in
 * the bar in the same frame it would have reached a field in the column.
 */
export function useColumnTools(slot: ColumnToolsSlot | null, node: ReactNode): void {
  useLayoutEffect(() => {
    slot?.set(node);
  });
  useEffect(() => () => slot?.set(null), [slot]);
}
