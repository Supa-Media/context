import type { ZoomLevel } from "../types";

/**
 * Which of the zoom control's stops carry their name. Two stops closer than
 * `minGap` of the track would print one name over the other, so the later
 * one keeps only its dot — unless it is the level the camera is at, which
 * always says where you are. The dot stays pressable either way, with its
 * name for a screen reader.
 */
export function tickLabels(
  levels: readonly ZoomLevel[],
  stops: Partial<Record<ZoomLevel, number>>,
  here: ZoomLevel,
  minGap: number,
): Set<ZoomLevel> {
  const shown: ZoomLevel[] = [];
  for (const level of [...levels].sort((a, b) => (stops[a] ?? 0) - (stops[b] ?? 0))) {
    const last = shown[shown.length - 1];
    if (last === undefined || (stops[level] ?? 0) - (stops[last] ?? 0) >= minGap) shown.push(level);
    else if (level === here) shown[shown.length - 1] = level;
  }
  return new Set(shown);
}
