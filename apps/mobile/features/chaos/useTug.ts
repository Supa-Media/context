import { useEffect, useState } from "react";
import { useReducedMotion } from "../design/useReducedMotion";

/** One haul at the yarn, slack to taut and back, in milliseconds. */
const PULL_MS = 1300;
/** Two hauls, then a breather, so a crowded folder's page fidgets rather than strains nonstop. */
const PULLS = 2;
const REST_MS = 4200;
/** About 24 frames a second is plenty for a figure this size. */
const FRAME_MS = 42;
/** Where the pull rests between bursts, and where it stays for reduced motion. */
const AT_REST = 0.35;

/**
 * How hard Tex is tugging at its yarn right now, 0 to 1, for `Tex`'s `tug`:
 * two hauls, a rest, and again, while `active`. Undefined when not active,
 * so Tex stands as always.
 *
 * Reduced motion holds one still pose: a stressed Tex, not a moving one.
 * Pure timing, kept apart from `Tex` so the drawing never runs a clock.
 */
export function useTug(active: boolean): number | undefined {
  const reduced = useReducedMotion();
  const [tug, setTug] = useState(AT_REST);
  useEffect(() => {
    if (!active || reduced) {
      setTug(AT_REST);
      return undefined;
    }
    const start = Date.now();
    const timer = setInterval(() => setTug(tugAt(Date.now() - start)), FRAME_MS);
    return () => clearInterval(timer);
  }, [active, reduced]);
  return active ? tug : undefined;
}

/** The pull `ms` into the loop: a smooth haul per pull, then resting slack. */
export function tugAt(ms: number): number {
  const cycle = PULL_MS * PULLS + REST_MS;
  const at = ((ms % cycle) + cycle) % cycle;
  if (at >= PULL_MS * PULLS) return AT_REST;
  const s = Math.sin((Math.PI * at) / PULL_MS);
  return AT_REST + (1 - AT_REST) * s * s;
}
