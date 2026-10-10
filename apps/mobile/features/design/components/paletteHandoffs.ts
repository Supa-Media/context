/**
 * The palette's two handoff rows, "See all results" and "Ask about", kept out
 * of `Palette.tsx` so the component stays under the file-size review line.
 */

import type { PaletteItem } from "../../console/files/palette";

/**
 * The id of the "See all results" row.
 *
 * A real `PaletteItem` so it lives in the one flat `matches` array the arrows,
 * the scroll arithmetic and Enter all walk — a row rendered outside that list
 * would be a row the keyboard cannot reach, which is the same defect as a
 * button drawn where a phone cannot see it. Prefixed so it cannot collide with
 * a note path or a command name.
 */
export const SEE_ALL_ID = "\u0000see-all";

/** The row, or `null` where there is nothing more to see. */
export function seeAllItem(query: string, offered: boolean): PaletteItem | null {
  const trimmed = query.trim();
  if (!offered || trimmed === "") return null;
  return {
    id: SEE_ALL_ID,
    label: `See all results for “${trimmed}”`,
    detail: "Every workspace you can reach",
    kind: "command",
  };
}

/**
 * The other handoff: hand the query to the agent instead of to search.
 *
 * `SEE_ALL_ID`'s reasoning, for a second destination. The two are genuinely
 * different questions — "find the note called this" and "answer this" — and
 * the palette is where somebody has already typed the words for either.
 *
 * ## Why it is below `See all` and not above
 *
 * Because the palette is a navigator first. Somebody typing `pricing` almost
 * always wants the note, and a row that answers a question costs a model call
 * and several seconds, so it must never be what Enter reaches by accident. The
 * ordering is the whole guard: the cursor rests on the first row, and this is
 * the last one.
 *
 * The one case where it is a good default is the one where nothing matched —
 * and that case needs no special rule, because the two handoff rows are then
 * the only rows and `See all` is still the first of them. A person who wanted
 * an answer presses ↓ once, which is exactly the cost of the second-best
 * guess.
 */
export const ASK_ID = "\u0000ask";

/** The row, or `null` where there is nobody to ask. */
export function askItem(query: string, offered: boolean): PaletteItem | null {
  const trimmed = query.trim();
  if (!offered || trimmed === "") return null;
  return {
    id: ASK_ID,
    label: `Ask about “${trimmed}”`,
    detail: "Answers from your notes, in the panel",
    kind: "command",
  };
}
