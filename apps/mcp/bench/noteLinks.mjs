/**
 * THE LINKS A TURN LEFT BETWEEN NOTES (Dev2, 2026-11-20: "define what good connection notes look like and how that can
 * be reliably scored"; chose "score, then finder + connect step").
 *
 * Tex's note-taking is scored on the notes it leaves behind, not on its reply. A turn's links are read from the bench
 * workspaces before and after it (`world.mjs` `links()`), with the same `linkRowsOf` the tree's link facts use
 * (`src/tree/links.js`), one line at a time so each link keeps the line it sits on: that line is where its reason is.
 * Only links that touch a note the turn wrote are kept (its own links, and other notes' links to it), so a result stays
 * small and a link nobody touched never counts for or against the turn.
 *
 * A label grades them with code lines (`codeLines.mjs` "link"): `link Ruth 4 and Judges 19 (thread)` must find a link
 * each way, each on a line that says why; `must not: link Ruth 4 to New Chapter Study` must find none made this turn.
 * Whether a reason is grounded stays a judge line, which reads these links in the request (`judge.mjs`).
 */

import { linkRowsOf } from "../src/tree/links.js";

/** Navigation words that say where a link goes but not why: a line of only these and links gives no reason. */
const NAV_WORDS = new Set([
  "previous", "prev", "next", "chapter", "book", "see", "also", "related", "link", "links", "linked", "to", "from",
  "back", "up", "index", "parent", "connections", "connection", "and", "the", "a", "an", "of", "in", "none",
]);

/** A note's name as a label line names it: its last path segment, no `.md`, lower case. */
export function nameOf(pathOrName) {
  const last = String(pathOrName ?? "").split("/").pop() ?? "";
  return last.replace(/\.md$/i, "").trim().toLowerCase();
}

/**
 * The words a link's line gives besides its links and navigation words: the reason, or "" when it gives none.
 * `[[Judges 19]]: same pro-Judah reading as the genealogy` gives a reason; `Previous: [[Ruth 3]]` gives none.
 */
export function reasonOf(line) {
  const words = String(line ?? "")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w !== "" && !NAV_WORDS.has(w));
  return words.length >= 3 ? words.join(" ") : "";
}

/** Each link one note's text holds, with the line it is on: `{ to, kind, line }`, each target once per line. */
function linksIn(path, text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    if (!raw.includes("[[") && !raw.includes("](")) continue;
    for (const [kind, to] of linkRowsOf(path, raw)) out.push({ to, kind, line: raw.trim().slice(0, 240) });
  }
  return out;
}

/**
 * The links that touch a note this turn wrote, in one workspace: `{ workspace, from, to, line, isNew }`. `was` and
 * `now` are path to text (`bucketSnapshot.mjs`); `skip(path)` drops the bench's plumbing. `isNew` is true when that
 * line with that link was not in the note before the turn.
 */
export function turnLinks(workspace, was, now, skip = () => false) {
  const notes = [...now].filter(([path]) => /\.md$/i.test(path) && !skip(path));
  const changed = new Set(notes.filter(([path, text]) => was.get(path) !== text).map(([path]) => path));
  if (changed.size === 0) return [];
  const changedNames = new Set([...changed].map(nameOf));
  const rows = [];
  for (const [path, text] of notes) {
    const before = new Set(linksIn(path, was.get(path) ?? "").map((l) => `${l.to}\u0000${l.line}`));
    for (const link of linksIn(path, text)) {
      const touches = changed.has(path) || changed.has(link.to) || changedNames.has(nameOf(link.to));
      if (!touches) continue;
      rows.push({ workspace, from: path, to: link.to, line: link.line, isNew: !before.has(`${link.to}\u0000${link.line}`) });
    }
  }
  return rows;
}

/** The links from note `a` to note `b` (by name), as a label line names them. */
export function linksBetween(links, a, b) {
  return (links ?? []).filter((l) => nameOf(l.from) === a && nameOf(l.to) === b);
}
