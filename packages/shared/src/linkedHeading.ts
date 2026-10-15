/**
 * A note's first heading is its name (decided by the owner, 2026-10-14; see
 * "A note's title is its name" in
 * `docs/decisions/app-and-console/quick-create-and-activity-feed.md`).
 *
 * The rules for reading that heading and for rewriting it after a rename, in
 * one place, because two sides now apply them: the console's editor (which
 * renames a note when its title is edited) and the control plane's move (which
 * rewrites the heading as part of the rename itself, so no second writer ever
 * races the editor for the same line — the race that merged two titles into
 * "kkingsngs-6" on 2026-10-14, see `docs/decisions/app-and-console/one-name.md`).
 *
 * Pure and dependency-free apart from the comment markers, so the Convex
 * runtime, the browser and the native editor's WebView all load it.
 */

import { MARKER_RE } from "./comments.cjs";

/**
 * A folder's sort number: `1-projects`, `02-intro`. One or two digits and a
 * hyphen, never followed by another digit or a dot (`2026-10-14` is a date),
 * and never the whole name.
 */
const SORT_PREFIX = /^\d{1,2}-(?![\d.])(?=.)/;

/** `1-projects` → `projects`. Only a prefix is ever removed. */
export function withoutSortPrefix(name: string): string {
  return name.replace(SORT_PREFIX, "");
}

function baseNameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/**
 * Files whose name is an address rather than a title: a website page, a
 * folder's about note, the front page, `todo.md`, `privacy.md`. Their heading
 * is free text and never renames them, and a rename never rewrites it.
 */
const ADDRESS_NAMES = /^(index|about|readme|privacy|todo)\.md$/i;

export function nameIsAddress(path: string): boolean {
  if (path === "website" || path.startsWith("website/")) return true;
  const name = baseNameOf(path);
  return ADDRESS_NAMES.test(name) || /\.(html|css)\.md$/i.test(name);
}

/**
 * The document's own title — its first ATX heading — or `null`.
 *
 * Only `#`, and only before anything else has been written: a note whose first
 * line is a paragraph has not been titled, and promoting an `##` from halfway
 * down would name the file after a subsection. Frontmatter is skipped, because
 * the console writes it and the person did not. An empty heading (`# `) is no
 * title.
 */
export function titleFor(text: string): string | null {
  const index = titleLineIndex(text.split("\n"));
  if (index === null) return null;
  const line = text.split("\n")[index]!;
  const heading = /^#\s+(.*)$/.exec(line.trim());
  if (heading === null) return null;
  // A comment on words in the title wraps them in anchors (`comments.cjs`).
  // They are not part of the name: without this, commenting on a linked
  // title would read as retitling it and rename the file after the markers.
  const title = heading[1]!.replace(MARKER_RE, "").trim();
  return title === "" ? null : title;
}

/** The line `titleFor` reads: frontmatter skipped, then blank lines. `null` past the end. */
function titleLineIndex(lines: readonly string[]): number | null {
  let index = 0;
  if (lines[0]?.trim() === "---") {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== "---") index += 1;
    index += 1;
  }
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  return index < lines.length ? index : null;
}

/** The file's stem: its name without `.md` (or `.excalidraw.md`). */
function stemOf(path: string): string {
  return baseNameOf(path).replace(/(\.excalidraw)?\.md$/i, "");
}

/**
 * The note's text with its title following a rename from `from` to `to`, or
 * `null` when nothing should change.
 *
 * The heading becomes the new name, whatever it said before, so the pair is
 * linked from then on: the whole new stem where it carried the sort number,
 * the name without it otherwise. A note with no heading gets none — its name
 * is drawn above it instead — and an address name is never touched.
 */
export function retitled(from: string, to: string, text: string): string | null {
  if (nameIsAddress(from) || nameIsAddress(to)) return null;
  if (!/\.md$/i.test(to) || /\.excalidraw\.md$/i.test(to)) return null;
  const title = titleFor(text);
  if (title === null) return null;
  const old = stemOf(from);
  const next = stemOf(to);
  const replacement = title === old ? next : withoutSortPrefix(next);
  if (replacement === title) return null;
  const lines = text.split("\n");
  const index = titleLineIndex(lines)!;
  const line = lines[index]!;
  const marker = /^(\s*#\s+)/.exec(line)![1]!;
  // A CRLF note keeps its line ending: `split("\n")` leaves the `\r` on it.
  lines[index] = `${marker}${replacement}${line.endsWith("\r") ? "\r" : ""}`;
  return lines.join("\n");
}
