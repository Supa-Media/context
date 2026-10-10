/**
 * One ranked list out of the palette's two halves, once the search has answered.
 *
 * Before ⌘K searched every workspace, the palette drew what the browser had
 * loaded first and the search's answer under it, ranked separately (see
 * `PaletteSearch` in `Palette.tsx`). That kept a fuzzy name match above "the
 * note that actually says this", and it meant ⌘K's order was not the order an
 * AI client's `search_notes` gives for the same words. Dev2 asked for one
 * ranked list (2026-10-09), so a search that says it is `ranked` is drawn in
 * its own order, which is the shared server order:
 *
 *  - a command whose name beats every loaded note's stays on top — typing
 *    "new note" is a command, not a search;
 *  - then the search's rows, in its order. A row that is also a loaded name
 *    match keeps that match's highlighted letters and label, so nothing is
 *    lost by the merge;
 *  - then whatever the loaded names found that the search did not — a note
 *    whose name matches and whose words did not reach the index yet — tagged
 *    as found by its name.
 *
 * Pure, so the order is a test rather than a screenshot.
 */

import { paletteKey, type Match, type PaletteItem } from "../../console/files/palette";

export function mergeRanked(local: readonly Match[], server: readonly PaletteItem[]): Match[] {
  const loaded = new Map(local.map((match) => [paletteKey(match.item), match]));
  const bestNote = local.reduce(
    (best, match) => (match.item.kind === "command" ? best : Math.max(best, match.score)),
    Number.NEGATIVE_INFINITY,
  );
  const leading = local.filter((match) => match.item.kind === "command" && match.score > bestNote);
  const placed = new Set(leading.map((match) => paletteKey(match.item)));

  const answered: Match[] = [];
  for (const item of server) {
    const key = paletteKey(item);
    if (placed.has(key)) continue;
    placed.add(key);
    const mine = loaded.get(key);
    answered.push(
      mine === undefined
        ? { item, score: 0, ranges: [] }
        : // The loaded label, because its ranges index into it.
          { item: { ...item, label: mine.item.label }, score: mine.score, ranges: mine.ranges },
    );
  }

  const rest = local
    .filter((match) => !placed.has(paletteKey(match.item)))
    .map((match) =>
      match.item.kind === "note" && match.item.why === undefined
        ? { ...match, item: { ...match.item, why: "name" as const } }
        : match,
    );

  return [...leading, ...answered, ...rest];
}
