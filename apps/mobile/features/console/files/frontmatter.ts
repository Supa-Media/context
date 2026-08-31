/**
 * Frontmatter, for showing rather than for editing.
 *
 * A captured note arrives with a YAML block at the top — `captured:`,
 * `source:`, `trust:`, sometimes a dozen more lines — and the editor renders
 * the file through a plain `TextInput`, so on a phone that block *is* the first
 * screen. The note itself starts below the fold. Obsidian answers this with a
 * collapsed Properties row; this module is the reading half of that answer.
 *
 * Three things about it are deliberate.
 *
 * **It never writes.** There is no `setProperty`, no serializer, no "tidy the
 * YAML" pass, and that is the whole safety argument. Plain files stay canonical
 * (see `CLAUDE.md`), the buffer in the editor is the file, and a display-only
 * reader cannot corrupt a document it half-understands. The parser below is a
 * long way short of YAML — no anchors, no block scalars, no flow maps — and a
 * reader that is wrong about a line merely shows that line oddly. A *writer*
 * that was wrong about the same line would rewrite somebody's note into
 * something they did not type.
 *
 * **The boundary is decided in one place.** `splitNote` does not look for
 * fences itself; it asks `stripFrontmatter` — the parser the share viewer has
 * always used — where the body starts, and takes the frontmatter to be exactly
 * the prefix that was removed. A second implementation here would be a second
 * opinion about the same bytes, and the day the two disagreed the disagreement
 * would land in a file we wrote back to the customer's bucket.
 *
 * **The round trip is by construction, not by care.** `frontmatter + body` is
 * `source` for every input, because `frontmatter` is defined as
 * `source.slice(0, source.length - body.length)` and `stripFrontmatter` only
 * ever returns a suffix. No input needs a special case: CRLF, an unterminated
 * `---`, an empty block, a body full of horizontal rules, the empty string.
 * That is asserted as a property over a table in `__tests__/frontmatter.test.ts`
 * rather than as one lucky example.
 */

import { stripFrontmatter } from "../../share/markdown";

/** The frontmatter block and the body it precedes, as they sit in the file. */
export interface SplitNote {
  /** The raw frontmatter block INCLUDING its `---` fences, or `""` when there is none. */
  frontmatter: string;
  /** Everything after the closing fence. Byte-for-byte the rest of the file. */
  body: string;
}

/** One `key: value` line from the frontmatter, for the Properties list. */
export interface Property {
  key: string;
  value: string;
}

/**
 * Cut a note into its frontmatter block and its body.
 *
 * `splitNote(s).frontmatter + splitNote(s).body === s`, always. See the file
 * comment for why that is a property of how this is written rather than of how
 * carefully it was written.
 *
 * What counts as frontmatter is `stripFrontmatter`'s judgement and not this
 * module's, which includes one case worth knowing: a note that opens with a
 * horizontal rule and has another one further down has the text between them
 * treated as a block. That is the share viewer's long-standing behaviour, the
 * two surfaces now agree about it, and the cost here is a Properties row with
 * nothing parseable in it rather than a lost paragraph — the body is still
 * returned byte for byte, and the file is never rewritten.
 */
export function splitNote(source: string): SplitNote {
  const body = stripFrontmatter(source);
  return { frontmatter: source.slice(0, source.length - body.length), body };
}

/**
 * The `key: value` lines inside a frontmatter block, in file order.
 *
 * Deliberately a shallow scalar reader, and never a writer. Fence lines, blank
 * lines and anything without a colon are skipped; the first colon splits, so a
 * value that contains one (an ISO timestamp, a URL) survives whole; surrounding
 * double or single quotes are dropped because they are YAML's syntax rather
 * than part of what the note says.
 *
 * Everything else is passed through as raw text. A nested map's children appear
 * as flat rows and a list's items disappear, which is honest for a row whose
 * job is to get metadata off the reader's first screen, and would be
 * indefensible if anything downstream serialized these back.
 */
export function properties(frontmatter: string): Property[] {
  const found: Property[] = [];
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("---")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === "") continue;
    found.push({ key, value: unquote(trimmed.slice(colon + 1).trim()) });
  }
  return found;
}

/** Drop the quotes YAML wrote, never anything the value itself contains. */
function unquote(value: string): string {
  const quote = value.charAt(0);
  const quoted = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
  return quoted ? value.slice(1, -1) : value;
}

/**
 * The title the frontmatter claims, if it claims one.
 *
 * `title` first because it is the one a person writes on purpose; then
 * `subject`, which is what an ingested email carries and is the closest thing
 * that note has to a name; then `name`. `null` when none of them is present or
 * all of them are empty, which leaves the caller to say what a note with no
 * stated title should be called — this function refuses to guess.
 */
export function frontmatterTitle(frontmatter: string): string | null {
  const rows = properties(frontmatter);
  for (const key of ["title", "subject", "name"]) {
    const value = rows.find((row) => row.key === key)?.value.trim();
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * What to call this note at the top of the screen.
 *
 * Three rungs, in the order of how much somebody meant them. The frontmatter's
 * title was written to name the note. A body's opening `# Heading` is the
 * document naming itself. The filename is what is left, and for a captured note
 * it is often a content hash — `0-inbox/email/3efac11d….md` — which is exactly
 * why the first two rungs exist.
 *
 * It never returns an empty string. A heading row with nothing in it reads as a
 * broken screen rather than as an unnamed note, so the last resort is the raw
 * basename and then the path itself, which is always *something*.
 */
export function noteHeading(source: string, path: string): string {
  const { frontmatter, body } = splitNote(source);

  const stated = frontmatterTitle(frontmatter);
  if (stated !== null) return stated;

  const heading = firstHeading(body);
  if (heading !== null) return heading;

  const basename = path.slice(path.lastIndexOf("/") + 1);
  const withoutExtension = basename.replace(/\.md$/i, "").trim();
  if (withoutExtension !== "") return withoutExtension;
  return basename !== "" ? basename : path;
}

/**
 * The text of the body's first level-1 ATX heading, or `null`.
 *
 * Fenced code is skipped, because a note holding a shell script would otherwise
 * be titled after its shebang comment — and because `share/markdown.ts` reads
 * the same lines as code rather than as headings, so the two surfaces would
 * disagree about the same file. A trailing run of `#`s is ATX's optional
 * closing sequence and is dropped — but only when whitespace precedes it, or
 * `# C#` would be titled `C`. An empty heading names nothing, so the scan
 * carries on past it.
 */
function firstHeading(body: string): string | null {
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^\s*#(?:\s+(.*))?$/.exec(line);
    if (match === null) continue;
    const text = (match[1] ?? "").replace(/\s+#+\s*$/, "").trim();
    if (text !== "") return text;
  }
  return null;
}
