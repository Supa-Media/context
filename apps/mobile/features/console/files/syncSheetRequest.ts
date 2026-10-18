import { useEffect, useRef } from "react";

/**
 * Asking the console to open its sync sheet from a page that cannot reach the
 * console's own state: the count under the phone's Notes title opens the
 * sheet's Downloads block (Dev2, 2026-10-18), and the sheet belongs to
 * `ConsoleFrame`. Nothing listening (a fixture) means nothing opens.
 */
const listeners = new Set<() => void>();

export function requestSyncSheet(): void {
  for (const listener of listeners) listener();
}

/** `ConsoleFrame`: open the sheet when a page asks. */
export function useSyncSheetRequests(open: () => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const listener = () => latest.current();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
