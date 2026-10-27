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
const NESTED_PREFIX = "context:job-nested:";

/**
 * The marker `iconOf` answers for a folder doing `job`. Tex's folder draws
 * Tex, wherever it is nested. One `nested` inside another folder draws in the
 * text colour: only a folder at the top of the workspace is drawn in Tex blue
 * (owner, 2026-10-26: "aren't all the non root folders supposed to be colored
 * black").
 */
export function jobIconMarker(job: RowRole, nested = false): string {
  if (job === "tex") return TEX_FIGURE_ICON;
  return `${nested ? NESTED_PREFIX : PREFIX}${job}`;
}

/** Whether a job's marker is for a folder nested inside another, drawn in the text colour. */
export function isNestedJobIcon(icon: string | null | undefined): boolean {
  return typeof icon === "string" && icon.startsWith(NESTED_PREFIX) && jobOfIcon(icon) !== null;
}

const TWIN_PREFIX = "context:archive-of:";

/**
 * The marker `iconOf` answers for a folder in Archive that mirrors `job`
 * (`archiveOf`): the job's drawing in grey with Archive's box on it. Tex's
 * folder has no drawing of its own, so its copy draws as a plain folder.
 */
export function twinIconMarker(job: RowRole): string | null {
  return job === "tex" ? null : `${TWIN_PREFIX}${job}`;
}

/** The job an Archive copy's marker mirrors, or `null` for anything else. */
export function twinJobOfIcon(icon: string | null | undefined): DrawnJob | null {
  if (typeof icon !== "string" || !icon.startsWith(TWIN_PREFIX)) return null;
  const job = icon.slice(TWIN_PREFIX.length);
  return isRowRole(job) && job !== "tex" ? job : null;
}

/** The drawn job a marker names, or `null` for an emoji (or anything else). */
export function jobOfIcon(icon: string | null | undefined): DrawnJob | null {
  if (typeof icon !== "string") return null;
  const prefix = icon.startsWith(PREFIX) ? PREFIX : icon.startsWith(NESTED_PREFIX) ? NESTED_PREFIX : null;
  if (prefix === null) return null;
  const job = icon.slice(prefix.length);
  return isRowRole(job) && job !== "tex" ? job : null;
}
