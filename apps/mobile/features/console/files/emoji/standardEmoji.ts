/**
 * The standard emoji the `:` menu offers, and the search over them.
 *
 * The table is GitHub's shortcode list (`standardEmoji.generated.ts`), so the
 * names are the ones people already type in Slack and GitHub. Parsed once, on
 * first use: nobody who never types `:` pays for it.
 */

import { STANDARD_EMOJI_TABLE } from "./standardEmoji.generated";

export interface StandardEmoji {
  /** The character itself, which is what a note stores. */
  readonly char: string;
  /** Its shortcodes, the first being the one to show. */
  readonly names: readonly string[];
  readonly tags: readonly string[];
  readonly description: string;
}

let parsed: { all: StandardEmoji[]; byName: Map<string, StandardEmoji> } | null = null;

function table(): { all: StandardEmoji[]; byName: Map<string, StandardEmoji> } {
  if (parsed !== null) return parsed;
  const all: StandardEmoji[] = [];
  const byName = new Map<string, StandardEmoji>();
  for (const line of STANDARD_EMOJI_TABLE.split("\n")) {
    const [char, names, tags, description] = line.split("\t");
    if (char === undefined || names === undefined) continue;
    const emoji: StandardEmoji = {
      char,
      names: names.split(","),
      tags: tags === undefined || tags === "" ? [] : tags.split(" "),
      description: description ?? "",
    };
    all.push(emoji);
    for (const name of emoji.names) if (!byName.has(name)) byName.set(name, emoji);
  }
  parsed = { all, byName };
  return parsed;
}

/** The standard emoji a shortcode names, or `undefined`. */
export function standardEmojiNamed(name: string): StandardEmoji | undefined {
  return table().byName.get(name);
}

/**
 * Standard emoji matching what was typed after `:`, best first, each with the
 * shortcode that matched.
 *
 * Ranked by where the query landed: a whole name, then the start of a name,
 * then inside a name, then the start of a tag or of a word in the description.
 * Ties keep the table's own order, which is Unicode's — the familiar faces
 * before the obscure symbols.
 */
export function searchStandardEmoji(
  query: string,
  limit: number,
): Array<{ emoji: StandardEmoji; name: string }> {
  const needle = query.toLowerCase();
  if (needle === "") return [];
  const ranked: Array<{ emoji: StandardEmoji; name: string; rank: number; order: number }> = [];
  table().all.forEach((emoji, order) => {
    let best: { name: string; rank: number } | null = null;
    for (const name of emoji.names) {
      const rank = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : null;
      if (rank !== null && (best === null || rank < best.rank)) best = { name, rank };
    }
    if (best === null && needle.length >= 3) {
      const words = [...emoji.tags, ...emoji.description.split(" ")];
      if (words.some((word) => word.startsWith(needle))) best = { name: emoji.names[0], rank: 3 };
    }
    if (best !== null) ranked.push({ emoji, ...best, order });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, limit).map(({ emoji, name }) => ({ emoji, name }));
}
