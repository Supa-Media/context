import { useSyncExternalStore } from "react";

/**
 * What a phone does to the rows picked on a folder page (board 16 of the
 * phone Home artboards, approved by the owner on 2026-09-30): Move, Tags,
 * Pin and Archive along the bottom, in place of search and the new-note
 * button, and everything else the tree's selection menu offers behind More.
 *
 * Each is present only where `menu.ts` would offer it for these rows (or,
 * for Tags and Pin, where this device can write tags and keep pins), and a
 * missing one is drawn dimmed rather than moved, so the four stay where a
 * thumb learned them.
 */
export interface BulkActions {
  move?: () => void;
  tags?: () => void;
  /** `pinned`: every picked row is on Home already, so the button unpins. */
  pin?: { pinned: boolean; run: () => void };
  archive?: () => void;
  /** The tree's own selection menu over the picked rows. */
  more: (anchor: { x: number; y: number }) => void;
}

export interface SelectBar {
  count: number;
  actions: BulkActions;
}

/*
  The folder page and the bottom bar are not parent and child: the bar is
  `AppFrame`'s bottom slot, drawn over the page. So the page in select mode
  leaves its bar here, and the bottom bar draws it while it is set. One page
  selects at a time, and it clears this when it leaves the mode or unmounts.
*/
let current: SelectBar | null = null;
const listeners = new Set<() => void>();

export function showSelectBar(bar: SelectBar | null): void {
  if (bar === current) return;
  current = bar;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The picked rows' bar, while a folder page is selecting; `null` otherwise. */
export function useSelectBar(): SelectBar | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
