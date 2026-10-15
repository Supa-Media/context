/**
 * What a note's front matter says about publishing it on a website, kept in
 * the tree's facts (`propsOf`) so a public list asks the tree whether a page
 * still publishes instead of opening it (Dev2, 2026-10-14: names and front
 * matter go through the tree; only a note's content comes from storage).
 *
 * The control plane's own checks (`apps/convex/functions/lib/websites/
 * changes.ts`) use this same function, so the facts and a live read can never
 * disagree about what restricts a page.
 */

import { isEncryptedNote } from "../encryption/format.js";

/** The front matter lines a parser would read, closed or not. */
function frontMatterLines(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return [];
  const lines = normalized.split("\n");
  const closing = lines.indexOf("---", 1);
  return lines.slice(1, closing < 0 ? undefined : closing);
}

/** Each `audience` / `draft` line as it was written, value trimmed. */
function controls(text) {
  const found = [];
  for (const line of frontMatterLines(text)) {
    const match = /^\s*(audience|draft)\b[ \t]*:?[ \t]*(.*)$/.exec(line);
    if (match !== null) found.push({ key: match[1], value: (match[2] ?? "").trim() });
  }
  return found;
}

/**
 * Whether these bytes ask for anything narrower than "serve this to anyone".
 *
 * Read the two controls that mean "stop publishing this" — `audience` and
 * `draft` — rather than the composed route status, because the status cannot
 * carry them: any other flaw in the page (a missing title, an emptied body, a
 * route clash) makes the status `problem`, and `problem` outranks both. Taking
 * a page private and clearing it to rewrite it is one save, and that save is
 * exactly a restriction the status hides.
 *
 * Scan the frontmatter the parser would have read, whether or not it is
 * closed: a half-typed `audience:` lives in an unclosed block. Only `public`
 * and `false` are permissive, and only exactly — a value the parser rejects is
 * an instruction we failed to read, never consent to keep serving.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function websiteTextRestricts(text) {
  if (isEncryptedNote(text)) return true;
  return controls(text).some(({ key, value }) => (key === "audience" ? value !== "public" : value !== "false"));
}

/**
 * The flags the facts keep: `restricts` as above, and `draft` for any `draft`
 * line that is not exactly `false` (a draft is withheld from every audience,
 * members included).
 *
 * @param {string} text
 * @returns {{ draft: boolean, restricts: boolean }}
 */
export function siteFlagsOf(text) {
  return {
    draft: controls(text).some(({ key, value }) => key === "draft" && value !== "false"),
    restricts: websiteTextRestricts(text),
  };
}
