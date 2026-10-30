/**
 * The order of ⌘K's rows once it searches every workspace.
 *
 * Dev2 asked (2026-10-09) for one ranked list, and it was drawn in the
 * server's order with the loaded name matches folded in. The search review
 * (2026-10-27) found what that cost: the names drawn at once were reordered
 * under the cursor when the server answered, a second or more later. The
 * tune-up Dev2 picked (boards M1 and M2) keeps one list and stops it moving:
 *
 *  - a command whose name beats every note's stays on top: typing "new note"
 *    is a command, not a search;
 *  - then the notes whose names hold what was typed, in the order they were
 *    drawn. They come from the loaded folders and from the tree's names in
 *    every workspace (`functions/nameSearch.ts`), so they are on screen from
 *    the first letter. A row the search also found carries its snippet and
 *    its reason, and keeps its highlighted letters;
 *  - then the search's rows, in its order: notes with the words inside them,
 *    and below them what meaning joined (`withMeaningRows`);
 *  - then whatever else the loaded names matched only loosely, letters in
 *    order rather than words, which are the least likely answer.
 *
 * So what is on screen while the search runs is the top of the final list,
 * and the search's answer arrives below it.
 *
 * Pure, so the order is a test rather than a screenshot.
 */

import { paletteKey, type Match, type PaletteItem } from "../../console/files/palette";

/** The words a name must hold: lowercase, split on anything but letters and digits. */
function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/**
 * A name holds what was typed: every word is in it, the last one as the
 * start of a word since it is still being typed. "one s" holds for "One
 * search bar"; "osb" does not, though its letters are in order.
 */
export function holdsName(query: string, item: PaletteItem): boolean {
  const words = wordsOf(query);
  if (words.length === 0) return false;
  const names = [item.label, item.name ?? ""].map((name) => name.toLowerCase());
  return names.some((name) => {
    const parts = wordsOf(name);
    return words.every((word, index) =>
      index === words.length - 1 ? parts.some((part) => part.startsWith(word)) : name.includes(word),
    );
  });
}

export function mergeRanked(local: readonly Match[], server: readonly PaletteItem[], query = ""): Match[] {
  const fromServer = new Map(server.map((item) => [paletteKey(item), item]));
  const bestNote = local.reduce(
    (best, match) => (match.item.kind === "command" ? best : Math.max(best, match.score)),
    Number.NEGATIVE_INFINITY,
  );
  const leading = local.filter((match) => match.item.kind === "command" && match.score > bestNote);
  const placed = new Set(leading.map((match) => paletteKey(match.item)));

  const names: Match[] = [];
  for (const match of local) {
    const key = paletteKey(match.item);
    if (placed.has(key) || match.item.kind !== "note" || !holdsName(query, match.item)) continue;
    placed.add(key);
    const found = fromServer.get(key);
    names.push({
      ...match,
      item:
        found === undefined
          ? { ...match.item, why: match.item.why ?? ("name" as const) }
          : // The loaded label, because its ranges index into it.
            { ...found, label: match.item.label },
    });
  }

  const answered: Match[] = [];
  for (const item of server) {
    const key = paletteKey(item);
    if (placed.has(key)) continue;
    placed.add(key);
    answered.push({ item, score: 0, ranges: [] });
  }

  const rest = local
    .filter((match) => !placed.has(paletteKey(match.item)))
    .map((match) =>
      match.item.kind === "note" && match.item.why === undefined
        ? { ...match, item: { ...match.item, why: "name" as const } }
        : match,
    );

  return [...leading, ...names, ...answered, ...rest];
}

/** The id of the folded "more about the same topic" row; prefixed so it cannot be a note path. */
export const SAME_TOPIC_ID = "\u0000same-topic";

/**
 * Notes found only by meaning, folded into one row at the first of them,
 * when anything else matched (board M2: "2 more about the same topic").
 * With nothing else, they are the answer and stay open; `open` unfolds them.
 */
export function foldSameTopic(rows: readonly Match[], open: boolean): Match[] {
  const topic = rows.filter((match) => match.item.meaningOnly === true);
  const others = rows.some((match) => match.item.kind === "note" && match.item.meaningOnly !== true);
  if (open || topic.length === 0 || !others) return [...rows];
  const at = rows.findIndex((match) => match.item.meaningOnly === true);
  const titles = topic.map((match) => match.item.label);
  const fold: Match = {
    item: {
      id: SAME_TOPIC_ID,
      label: `${topic.length} more about the same topic`,
      detail: titles.join(", "),
      kind: "command",
    },
    score: 0,
    ranges: [],
  };
  const kept = rows.filter((match) => match.item.meaningOnly !== true);
  return [...kept.slice(0, at), fold, ...kept.slice(at)];
}
