import { useEffect, useRef } from "react";

/**
 * The most rows one change may add and still ease in, one by one.
 *
 * A note somebody else created, or two, arriving in a list you are looking at
 * is the case the ease is for. Forty rows at once is a folder being opened or
 * a workspace being switched: nothing was pushed out from under the reader,
 * the whole list is new, and forty rows growing together reads as the list
 * wobbling rather than as anything arriving.
 */
export const MAX_ARRIVALS = 3;

/**
 * Which of `keys` were not in the list the last time it was drawn.
 *
 * Empty on the first render, since a list that loads with its rows is not
 * rows arriving; empty when anything also left, since a rename or a move is a
 * row changing place rather than one pushing in; and empty when more than
 * `MAX_ARRIVALS` came at once. Meant for
 * `<Reveal open appear={arrived.has(key)}>`: `appear` is read once, when the
 * row mounts, so it does not matter that the key stops counting as new on the
 * next render.
 *
 * The previous list is only replaced once a render commits, so a render React
 * discards (or draws twice, in development) answers the same.
 */
export function useArrivals(keys: readonly string[]): ReadonlySet<string> {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const current = new Set(keys);

  useEffect(() => {
    seen.current = current;
  });

  const previous = seen.current;
  if (previous === null) return EMPTY;
  // Something also left: a rename or a move, which is one row changing its
  // name in place, not a new one pushing in.
  for (const key of previous) if (!current.has(key)) return EMPTY;
  const arrived = new Set<string>();
  for (const key of keys) {
    if (previous.has(key)) continue;
    arrived.add(key);
    if (arrived.size > MAX_ARRIVALS) return EMPTY;
  }
  return arrived;
}

const EMPTY: ReadonlySet<string> = new Set();
