/**
 * A website page that names a folder: `folder: features` in `website/features.md`.
 *
 * The folder's notes become pages under that page's address without moving or
 * copying them — `features/forms.md` is `/features/forms` — so a set of notes
 * kept for their own sake can also be published. See `docs/decisions/websites.md`
 * ("A website page can name a folder, and the folder narrows").
 *
 * This module is the pure half: reading the line, refusing the folders no
 * page may name, and giving each note the key it would have if it lived in
 * `website/`, so the route compiler that decides every other address decides
 * these too. What may actually publish is the privacy barrier's to say, at
 * the same clearance as every other page; nothing here widens it.
 */

import { DEFAULT_WEBSITE_ROOT } from "./websiteRoutes";

/** At most this many notes join a site through folder pages, all of them together. */
export const MAX_REFERENCED_WEBSITE_NOTES = 300;

/**
 * The folder a page names, or `null` for none or one no page may name.
 *
 * Refused, rather than read generously: the whole context (`/`, empty),
 * anything outside it or ambiguous (`..`, `.`, a backslash, a control
 * character), Context's own plumbing (a segment starting with `.`, so
 * `.context/`), and `website/` itself or anything under it, whose notes are
 * already the site's. A refused line publishes nothing, the same as no line.
 */
export function websiteFolderReference(markdown: string): string | null {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const lines = normalized.split("\n");
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return null;
  const found = lines
    .slice(1, closing)
    .map((line) => /^folder:[ \t]*(.*)$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  // Twice is ambiguous, and an ambiguous line publishes nothing.
  if (found.length !== 1) return null;
  return websiteFolderPath(unquoted(found[0]!.trim()));
}

function unquoted(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/** A folder a page may name, as a bucket path without slashes at either end; else `null`. */
export function websiteFolderPath(raw: string): string | null {
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  if (/[\u0000-\u001f\u007f\\%?#]/.test(trimmed)) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment.startsWith("."))) return null;
  if (segments[0]!.normalize("NFC").toLowerCase() === DEFAULT_WEBSITE_ROOT) return null;
  return segments.map((segment) => segment.normalize("NFC")).join("/");
}

/**
 * The key a referenced note would have inside `website/`, which is what the
 * route compiler reads: `features/guides/tables.md` under `website/features.md`
 * is `website/features/guides/tables.md`, so `/features/guides/tables`. A
 * folder named from `website/index.md` lands at the site's root, where any
 * page of the site's own outranks it.
 */
export function referencedWebsiteKey(pageKey: string, folder: string, noteKey: string): string | null {
  const prefix = `${folder}/`;
  if (!noteKey.startsWith(prefix)) return null;
  let base = pageKey.replace(/\.md$/i, "");
  if (base.toLowerCase().endsWith("/index")) base = base.slice(0, -"/index".length);
  return `${base}/${noteKey.slice(prefix.length)}`;
}

/** Whether a key is one of the site's own pages rather than a referenced note. */
export function isWebsiteRootKey(objectKey: string): boolean {
  return objectKey.startsWith(`${DEFAULT_WEBSITE_ROOT}/`);
}
