/**
 * The names a meeting summary is told this workspace uses.
 *
 * Speech recognition hears the word it knows: a call about Tex came back as
 * "Text" and "Texas", and the summary copied it (the owner, 2026-10-17). The
 * cheapest list of what a workspace calls things is its own folder names, so
 * the summary is handed those, and told to spell a misheard one their way.
 *
 * Only folders this caller can see: each comes from a note key that passes
 * `canSee` for the request's own scope, the same test `orient`'s map uses, so a
 * team member's summary never learns the name of a folder the owner keeps
 * private. Names only, never a note's title or text. The summary is written
 * into the same workspace the names came from.
 */

import { isVisibleNote } from "../orient/survey.js";
import { servedListingStore } from "../tree/served.js";
import { MAX_NAMES } from "../../../../packages/meetings/src/summary.js";

/** Folders every workspace has, which name nothing anybody says. */
const GENERIC = new Set([
  "inbox", "projects", "areas", "resources", "archive", "teams", "products", "clients",
  "website", "meetings", "sessions", "memories", "transcripts", "attachments", "assets", "images",
  "notes", "files", "misc", "other", "docs", "drafts", "templates", "tests", "results", "setups",
]);

/** `1-projects` → `projects`; `public-worship` → `public worship`; null for a generic or odd one. */
export function folderName(segment) {
  const plain = String(segment).replace(/^\d+[-_. ]+/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (plain.length < 2 || plain.length > 60 || plain.startsWith(".")) return null;
  if (GENERIC.has(plain.toLowerCase())) return null;
  if (/^\d[\d -]*$/.test(plain)) return null; // a date folder
  return plain;
}

/**
 * Up to `MAX_NAMES` folder names from the visible tree, shallowest first.
 * Best effort: a tree that cannot answer gives none, and the summary is
 * written with the built-in names only.
 *
 * @param {object} store
 * @param {object} scope
 * @param {{rules: object, overrides: object}} privacy
 * @returns {Promise<string[]>}
 */
export async function workspaceNames(store, scope, privacy) {
  let objects;
  try {
    objects = await servedListingStore(store).treeEntries();
  } catch {
    return [];
  }
  const depth = new Map();
  for (const { key } of objects ?? []) {
    if (typeof key !== "string" || !isVisibleNote(key, scope, privacy.rules, privacy.overrides)) continue;
    const folders = key.split("/").slice(0, -1);
    folders.forEach((segment, level) => {
      const name = folderName(segment);
      if (!name) return;
      const known = depth.get(name.toLowerCase());
      if (!known || level < known.level) depth.set(name.toLowerCase(), { name, level });
    });
  }
  return [...depth.values()]
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
    .slice(0, MAX_NAMES)
    .map(({ name }) => name);
}
