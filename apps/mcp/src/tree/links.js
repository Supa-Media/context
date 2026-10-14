/**
 * The tree's links, parsed: which paths and bare names one note's text points
 * at, and what a bare link to a note is written as.
 *
 * The Convex control plane keeps these as the tree's link facts
 * (`apps/convex/functions/lib/nodes/gatewayFacts.ts`), and a move asks it
 * "which notes point at this" (`tree/facts.js`) instead of reading every note.
 * Parsed by the same `parseLinks` and `linkTargetOf` a rewrite runs
 * (`links.js`), so the notes found are the notes a rewrite would change.
 *
 * The search database's `tree_links` and `tree_link_sources` tables that held
 * these first were retired in phase 7 of
 * `docs/decisions/app-and-console/convex-tree.md` (`tree/retired.js`).
 */

import { linkTargetOf, parseLinks } from "../links.js";

/**
 * The links one note's text holds, as `[kind, target]` pairs, each once.
 * `kind` is `path` for a link that names a path (relative links resolved
 * against the note's own folder) and `name` for a bare `[[name]]`, which names
 * a note only once the whole bucket says which one carries it, so it is
 * resolved when read, never stored resolved.
 */
export function linkRowsOf(path, text) {
  if (typeof text !== "string" || text === "") return [];
  const seen = new Set();
  const rows = [];
  for (const link of parseLinks(text)) {
    const target = linkTargetOf(link, path);
    if (target === null) continue;
    const value = target.kind === "path" ? target.path : target.name;
    if (value === "" || value === path) continue;
    const key = `${target.kind}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([target.kind, value]);
  }
  return rows;
}

/** `1-projects/x/overview.md` → `overview`: what a bare link to it is written as. */
export function bareNameOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}
