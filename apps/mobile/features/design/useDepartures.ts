import { useEffect, useRef, useState } from "react";
import { motion } from "./tokens/motion";
import { MAX_ARRIVALS } from "./useArrivals";

/** A list as it should be drawn: its rows, and the few just gone from it, still in place while they close. */
export type WithDepartures<T> = { readonly items: readonly T[]; readonly leaving: ReadonlySet<string> };

type Gone<T> = { readonly key: string; readonly item: T; readonly after: string | null };

/**
 * `items`, with the rows that were just removed from it kept where they were
 * for `motion.layoutMs`, so `<Reveal open={!leaving.has(key)}>` can close
 * them rather than the list closing over them in one frame.
 *
 * `useArrivals`' mirror, by the same rules: a note deleted, or two, from a
 * list you are looking at is the case it is for. Nothing is kept on the first
 * render; nor when anything also arrived, since a rename or a move is a row
 * changing in place rather than one leaving; nor when more than
 * `MAX_ARRIVALS` went at once, which is a folder being left rather than
 * notes being deleted from it. A removed row comes back after the nearest
 * row above it that stayed, or first when none did; a row that returns while
 * it is closing is simply in the list again.
 *
 * Its previous list is only replaced once a render commits, so a render React
 * discards (or draws twice, in development) answers the same.
 */
export function useDepartures<T>(items: readonly T[], keyOf: (item: T) => string): WithDepartures<T> {
  const seen = useRef<readonly T[] | null>(null);
  const [kept, setKept] = useState<readonly Gone<T>[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const fresh = departuresOf(seen.current, items, keyOf);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    seen.current = items;
    if (fresh.length === 0) return undefined;
    setKept((before) => [...before.filter((each) => !fresh.some((gone) => gone.key === each.key)), ...fresh]);
    // Not cleared by the next render: the row closes on its own clock, whatever else changes.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setKept((before) => before.filter((each) => !fresh.includes(each)));
    }, motion.layoutMs);
    timers.current.add(timer);
    return undefined;
  });

  // Fresh ones first: on the render that removes them they are not in `kept` yet.
  const present = new Set(items.map(keyOf));
  const gone = [...fresh, ...kept.filter((each) => !fresh.some((other) => other.key === each.key))].filter(
    (each) => !present.has(each.key),
  );
  if (gone.length === 0) return { items, leaving: EMPTY };

  const merged: T[] = [];
  const at = (anchor: string | null) => {
    for (const each of gone) if (each.after === anchor) merged.push(each.item);
  };
  at(null);
  for (const item of items) {
    merged.push(item);
    at(keyOf(item));
  }
  return { items: merged, leaving: new Set(gone.map((each) => each.key)) };
}

function departuresOf<T>(previous: readonly T[] | null, items: readonly T[], keyOf: (item: T) => string): Gone<T>[] {
  if (previous === null) return [];
  const before = new Set(previous.map(keyOf));
  const now = new Set(items.map(keyOf));
  // Something also arrived: a rename or a move, which is one row changing in place, not one leaving.
  for (const key of now) if (!before.has(key)) return [];
  const gone: Gone<T>[] = [];
  let after: string | null = null;
  for (const item of previous) {
    const key = keyOf(item);
    if (now.has(key)) {
      after = key;
      continue;
    }
    gone.push({ key, item, after });
    if (gone.length > MAX_ARRIVALS) return [];
  }
  return gone;
}

const EMPTY: ReadonlySet<string> = new Set();
