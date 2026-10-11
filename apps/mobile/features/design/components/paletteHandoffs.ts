/**
 * The palette's handoff row, "See all results", kept out of `Palette.tsx` so
 * the component stays under the file-size review line.
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
