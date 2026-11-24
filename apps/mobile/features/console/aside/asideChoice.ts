import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_ASIDE_TAB, type AsideTab } from "./tabs";

/**
 * The right panel's chosen tab, kept outside the panel's own component.
 *
 * Opening the folded strip at `medium` moves the panel from its column to an
 * overlay (`frame.ts`), which mounts a new `AsidePanel`. Kept in component
 * state, the press on the strip's Tex icon was lost in that move and the panel
 * opened on Meetings, a second press away (Dev2, 2026-11-20: "no matter if you
 * click the calendar button or the tex button, it takes you to meetings").
 * Kept here, the tab a person pressed survives the move.
 *
 * The things that take the tab on their own (New meeting, the map opening, a
 * note clicked on the map) are remembered here as well, so a remount does not
 * replay them: each takes the tab once, when it changes.
 */
let chosen: AsideTab = DEFAULT_ASIDE_TAB;
const seen: { started: number | null; vaultAt: number | null; mapOpen: boolean; noteKey: string | null; areaShown: boolean } = {
  started: null,
  vaultAt: null,
  mapOpen: false,
  noteKey: null,
  areaShown: false,
};
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function chooseAsideTab(tab: AsideTab): void {
  if (tab === chosen) return;
  chosen = tab;
  for (const listener of [...listeners]) listener();
}

/** The chosen tab and the way to choose one, shared by every mount of the panel. */
export function useAsideChoice(): [AsideTab, (tab: AsideTab) => void] {
  const tab = useSyncExternalStore(subscribe, () => chosen, () => chosen);
  return [tab, useCallback((next: AsideTab) => chooseAsideTab(next), [])];
}

/**
 * Whether a value that takes the tab has changed since any mount last saw it.
 * Records the new value, so the next mount of the panel sees it as old.
 */
export function changedSinceSeen<K extends keyof typeof seen>(key: K, value: (typeof seen)[K]): boolean {
  if (seen[key] === value) return false;
  seen[key] = value;
  return true;
}

/** Back to a fresh console: Meetings, and nothing seen. For tests. */
export function forgetAsideChoice(): void {
  chosen = DEFAULT_ASIDE_TAB;
  seen.started = null;
  seen.vaultAt = null;
  seen.mapOpen = false;
  seen.noteKey = null;
  seen.areaShown = false;
}
