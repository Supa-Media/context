/**
 * Which recorded changes re-check the tree table, and how.
 *
 * `recordChange` is the one call every gateway write makes afterwards, so it
 * is where the table hears about them. A change to the tree's shape — a note
 * created, moved, archived, a folder moved — has every path it names
 * re-checked as a note and as a folder (`touchTree`). A write that only puts
 * text in a note has that key alone re-checked, except a save of an existing
 * note's body (`update_note`), whose new version reaches the table inside the
 * search projection's own database call (`writeProjection.js`) instead: the
 * live editor commits every typing pause, and a listing per pause is cost with
 * nothing to show for it.
 */

import { createD1Client } from "../search/d1/client.js";
import { sendsTreeHint } from "../activity/changes.js";
import { touchTree } from "./touch.js";

/** Writes that put text in a note, which may be a note that was not there before. */
const WRITES = new Set([
  "create_note",
  "remember_fact",
  "save_context",
  "meeting_note",
  "propose_note",
  "rewrite_references",
  "inbox_capture",
  "inbox_update",
  "calendar_sync",
  "approve_proposal",
]);

/** What to re-check for this change, or null for nothing. */
export function treeTouchOf(action, paths, details) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const named = paths.filter((path) => typeof path === "string");
  if (named.length === 0) return null;
  if (sendsTreeHint(action, details)) return { paths: named };
  if (WRITES.has(action)) return { files: named };
  return null;
}

/** This context's database, or null where fast search has none. */
export function treeClientOf(store) {
  const descriptor = store?.searchIndex;
  if (!descriptor || typeof descriptor !== "object") return null;
  try {
    return createD1Client(descriptor);
  } catch {
    return null;
  }
}

/** Re-check what a change touched. Never throws: see `touchTree`. */
export async function keepTreeTable(store, touch) {
  if (!touch) return;
  const client = treeClientOf(store);
  if (client === null) return;
  try {
    await touchTree(store, client, touch);
  } catch {
    // A derivative one change behind; the next sweep repairs it.
  }
}
