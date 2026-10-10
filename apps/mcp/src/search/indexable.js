/**
 * Which keys the search index holds: notes, minus plumbing and `activity.md`.
 *
 * `activity.md` is left out on purpose: it is a derivative, every line of it
 * restating a path and a name already in the note the line is about, so
 * indexing it would bury a project's note under the feed lines that mention
 * it. `read_activity` is how it is queried.
 *
 * One function for the gateway (`visibleNotes.js`) and the console
 * (`apps/convex/functions/lib/fileOps/search.ts`) alike, so a pass from either
 * side builds the same index and an app search and an AI search cannot come
 * to disagree about what a note is (`apps/convex/__tests__/searchParity.test.ts`).
 */

import { isPlumbing } from "../privacy/engine.js";
import { ACTIVITY_PATH } from "../../../../packages/shared/src/activity.cjs";

/** @param {string} key */
export function isIndexableNote(key) {
  return key.endsWith(".md") && !isPlumbing(key) && key !== ACTIVITY_PATH;
}

/**
 * A folder prefix as the indexes compare it: with its trailing slash.
 *
 * Callers pass a folder (`1-projects`), and the move bookkeeping wants it bare
 * (`noteUnderPrefix`), but every index answers by `startsWith`, so without the
 * slash `1-projects` also matches `1-projects-old/` and a root note named
 * `1-projects-notes.md`. The console adds it the same way (`searchNotes`).
 *
 * @param {string} prefix
 */
export function folderPrefix(prefix) {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
