import { useEffect, useState } from "react";

/**
 * "Open this tag on Home", from a phone's search (board 04 of the phone Home
 * artboards): pressing "Tagged launch" goes Home with the launch chip on.
 *
 * Search and Home are not parent and child — search is an overlay over
 * whatever page is open, and Home may not be mounted yet when a tag is
 * pressed — so the ask is left here for Home to take: at once if it is on
 * screen, or when it next mounts. Taken once; a later visit to Home starts
 * on All again, as it always has.
 */
let pending: string | null = null;
const listeners = new Set<(tag: string) => void>();

export function showTagOnHome(tag: string): void {
  pending = tag;
  for (const listener of listeners) listener(tag);
}

/** Home's tag chip, starting from (and taking) a tag search asked for. */
export function useHomeTag(): [string | null, (tag: string | null) => void] {
  const [tag, setTag] = useState<string | null>(() => {
    const asked = pending;
    pending = null;
    return asked;
  });
  useEffect(() => {
    const listener = (asked: string) => {
      pending = null;
      setTag(asked);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [tag, setTag];
}
