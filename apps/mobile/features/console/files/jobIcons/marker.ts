/**
 * A built-in folder's drawn icon, spelled as a folder icon.
 *
 * Every surface that draws a folder's glyph asks `FileBrowser.iconOf` and
 * hands the answer to `EmojiGlyph`. A folder with a job answers with this
 * marker instead of an emoji, so every one of them draws the job's icon
 * (`JobIcon`) without each learning about jobs, the way `TEX_FIGURE_ICON`
 * draws Tex. Drawn, never written: it is not an emoji and not a `:name:`, so
 * it can never be stored as somebody's choice, and the server refuses any icon
 * on a built-in folder anyway (`folderIcons.set`).
 */

import { isRowRole, type RowRole } from "@context/shared/src/folderRoles.cjs";
import { TEX_FIGURE_ICON } from "@context/shared/src/folderIcons.cjs";
import type { DrawnJob } from "./geometry";

const PREFIX = "context:job:";

/** The marker `iconOf` answers for a folder doing `job`. Tex's folder draws Tex, wherever it is nested. */
export function jobIconMarker(job: RowRole): string {
  return job === "tex" ? TEX_FIGURE_ICON : `${PREFIX}${job}`;
}

/** The drawn job a marker names, or `null` for an emoji (or anything else). */
export function jobOfIcon(icon: string | null | undefined): DrawnJob | null {
  if (typeof icon !== "string" || !icon.startsWith(PREFIX)) return null;
  const job = icon.slice(PREFIX.length);
  return isRowRole(job) && job !== "tex" ? job : null;
}
