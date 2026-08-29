/**
 * The notes one note explicitly links to.
 *
 * This is an **authorization input**, not a convenience. A share starts at one
 * note and permits reading the notes that note links to; this function decides
 * which paths those are, so anything it over-reports is a note handed to
 * somebody the owner did not mean to hand it to.
 *
 * It is therefore deliberately literal and deliberately narrow:
 *
 *  - It reads **link syntax only**. Not prose that mentions a path, not a bare
 *    string that happens to end in `.md`, not a URL. If it is not a Markdown
 *    link or a wikilink, it is not a link.
 *  - It never invents a path. A link is resolved against the linking note's own
 *    folder and then normalized; anything that escapes the bucket root, names
 *    plumbing, or is not a note is dropped rather than repaired.
 *  - It ignores fenced code. A note that documents this feature by *showing*
 *    `[[private-thing]]` in a code block is not linking to it, and a reader
 *    that could not tell the difference would let anybody with write access to
 *    a shared note widen their own share by pasting a code sample.
 *
 * Pure, and tested directly. It cannot reach a database or a bucket, so what it
 * returns is a function of the text and the path alone — which is what makes
 * `__tests__/noteLinks.test.ts` a real check on an authorization boundary
 * rather than a check on a mock.
 *
 * ## What it does not do
 *
 * It does not decide visibility. Every path it returns is still put through the
 * live `privacy.md` on read, at `team` scope, by `readFile`. A link to a private
 * note resolves to a path here and then reads as absent there — which is the
 * right split: this module answers "did the author link to it", and the
 * manifest answers "may this person see it".
 */

import { isPlumbing } from "./privacy";

/**
 * The most links one note contributes.
 *
 * A bound rather than a guess about how people write: the return value is
 * iterated by an authorization check, and a note holding ten thousand links
 * would make one share read into ten thousand comparisons. Notes that link more
 * than this are index pages, and an index page's tail is not what somebody is
 * trying to reach through a share.
 */
export const MAX_LINKS_PER_NOTE = 200;

/**
 * Fenced and inline code, removed before any link is looked for.
 *
 * Order matters: fences first, because an inline-code run inside a fence is not
 * inline code, and a lone backtick inside a fenced block would otherwise eat
 * the rest of the document. Replaced with nothing rather than skipped, because
 * the only thing this text is used for afterwards is matching.
 */
function stripCode(text: string): string {
  return text
    .replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm, "")
    // An unterminated fence runs to the end of the note. Markdown renderers
    // agree, and the safe reading is that everything after it is code.
    .replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*$/m, "")
    .replace(/`[^`\n]*`/g, "");
}

/**
 * `[text](target)` — the target only, and only when it is not a URL.
 *
 * The character class excludes whitespace and `)`, so a title
 * (`[a](b.md "title")`) ends the match at the space and the title is not
 * mistaken for part of the path.
 */
const MARKDOWN_LINK = /\[[^\]\n]*\]\(\s*<?([^)\s<>]+)>?[^)]*\)/g;

/** `[[target]]` or `[[target|label]]` — Obsidian's form, which this bucket uses. */
const WIKILINK = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;

/**
 * Anything with a scheme, or a protocol-relative URL.
 *
 * Dropped rather than resolved: an external link is not a note in this bucket,
 * and `mailto:`, `data:` and `javascript:` must never be walked back into a
 * path. Matching the scheme shape rather than listing schemes is what keeps a
 * new one from arriving as a bypass.
 */
const HAS_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Resolve one link target against the folder of the note it appeared in.
 *
 * Returns `null` for anything that is not a note in this bucket. The rules are
 * each a specific thing somebody could otherwise reach:
 *
 *  - A scheme or `//` is external.
 *  - A fragment or query is a pointer within a page, not a different note.
 *  - `..` that climbs past the root would name a key outside the bucket; the
 *    walk refuses rather than clamping, because clamping turns `../../x` into
 *    `x`, which is a path the author did not write.
 *  - Plumbing is never a link target, whatever the author typed.
 *
 * A target with no extension gets `.md`, because that is what a wikilink means.
 * A target with a *different* extension is dropped: a share renders Markdown,
 * and a PDF reached through a share is a download nobody authorized.
 */
export function resolveLinkTarget(target: string, fromPath: string): string | null {
  const raw = target.trim();
  if (raw === "" || HAS_SCHEME.test(raw)) return null;

  const withoutFragment = raw.split("#")[0].split("?")[0].trim();
  if (withoutFragment === "") return null;

  // A leading slash means the bucket root, which is where a bare path is
  // resolved from anyway once the segments are walked.
  const absolute = withoutFragment.startsWith("/");
  const base = absolute ? [] : fromPath.split("/").slice(0, -1);

  const segments: string[] = [...base];
  for (const segment of withoutFragment.replace(/^\/+/, "").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Refuse rather than clamp. See the doc comment.
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) return null;
  const path = segments.join("/");

  const last = segments[segments.length - 1];
  const resolved = last.includes(".") ? path : `${path}.md`;
  if (!resolved.toLowerCase().endsWith(".md")) return null;
  if (isPlumbing(resolved)) return null;

  return resolved;
}

/**
 * Every note path this note explicitly links to, deduplicated and bounded.
 *
 * The order is the order they appear, so a truncated result is the head of the
 * document rather than an arbitrary subset — if a note is over the cap, the
 * links a reader meets first are the ones that work.
 */
export function linkedNotePaths(text: string, fromPath: string): string[] {
  const body = stripCode(text);
  const found = new Set<string>();

  for (const pattern of [MARKDOWN_LINK, WIKILINK]) {
    // `lastIndex` is per-regex state and these are module-level literals, so it
    // is reset explicitly — a previous call leaving it mid-string would silently
    // skip the first links of the next note.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      const resolved = resolveLinkTarget(match[1], fromPath);
      if (resolved !== null && resolved !== fromPath) found.add(resolved);
      if (found.size >= MAX_LINKS_PER_NOTE) return [...found];
    }
  }

  return [...found];
}
