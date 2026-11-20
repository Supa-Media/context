/**
 * Whether Tex is writing in a note open in this window, for the presence
 * pile. The pile is drawn in the note's head and path bar, far from the
 * editor that runs Tex, so the fact travels through this small store rather
 * than down two component trees. Counted, so two editors running at once
 * do not hide the face when the first one finishes.
 */
import { useSyncExternalStore } from "react";

let running = 0;
const listeners = new Set<() => void>();

/** One editor's runs started (true) or all finished (false). */
export function setTexWriting(value: boolean): void {
  running = Math.max(0, running + (value ? 1 : -1));
  for (const listener of listeners) listener();
}

export function texWritingNow(): boolean {
  return running > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTexWriting(): boolean {
  return useSyncExternalStore(subscribe, texWritingNow, texWritingNow);
}
