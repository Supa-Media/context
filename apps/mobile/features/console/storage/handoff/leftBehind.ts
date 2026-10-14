/**
 * The words for files a finished move left where they were, because they are
 * over the file limit (decided by the owner, 2026-10-14). Pure, so it is
 * tested without a renderer.
 */

import type { LeftBehind } from "../../types";

export const FILE_LIMIT_WORDS = "20 MB";

export function leftBehindTitle(left: LeftBehind): string {
  return left.count === 1 ? "1 file stayed behind" : `${left.count.toLocaleString("en-US")} files stayed behind`;
}

export function leftBehindLine(left: LeftBehind): string {
  const them = left.count === 1 ? "It is" : "They are";
  const where = left.bucket === "" ? "the storage it moved from" : left.bucket;
  return `${them} over the ${FILE_LIMIT_WORDS} file limit, so the move left ${left.count === 1 ? "it" : "them"} in ${where}. Nothing was deleted.`;
}

/** The names shown, and how many more there are past them. */
export function leftBehindMore(left: LeftBehind): string | null {
  const more = left.count - left.keys.length;
  return more > 0 ? `and ${more.toLocaleString("en-US")} more` : null;
}
