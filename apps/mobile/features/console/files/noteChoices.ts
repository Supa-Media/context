/**
 * The notes a query could mean, best first — the ranking behind the `[[`
 * completion (`linkComplete.ts`) and the Link sheet (`LinkSheet.tsx`).
 *
 * On its own, with no imports, because the two callers sit on opposite sides
 * of the web view: the completion runs inside the editor, and the sheet is
 * native React Native, which must not pull CodeMirror in to rank a list
 * (`editorBundle.test.ts`, "the native path never imports the editor"). One
 * ranking, so a note the sheet offers is the note `[[` would have offered for
 * the same letters, and the target it writes is the same rooted path.
 */

/** One offered note. */
export interface NoteChoice {
  /** The note's own name, without the folder or the extension. */
  readonly label: string;
  /** The folder it is in, or `""` at the root. */
  readonly folder: string;
  /** What is written into the document. */
  readonly insert: string;
}

/** `1-projects/foo/overview.md` → `overview`. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** `1-projects/foo/overview.md` → `1-projects/foo`. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * How many offers to build.
 *
 * A cap rather than the whole bucket, because this list is rebuilt on every
 * keystroke inside a `[[` and an empty query offers everything. Fifty is more
 * than fits on a phone screen twice over, and a query that needs more than
 * fifty candidates is a query that has not been typed yet.
 */
export const MAX_CHOICES = 50;

/**
 * Lowercased with accents taken off, so `cafe` finds `Café notes`.
 *
 * `normalize` is guarded because the Link sheet runs this on Hermes, where it
 * depends on the build's Intl support; without it, accents simply have to be
 * typed, which is what every query did before.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  try {
    return lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    return lower;
  }
}

/** Characters that end a word: spaces, punctuation and the path's own `/`. */
const SEPARATORS = new Set(" \t-_.,;:!?'\"()[]{}/\\|+&#@*~`^=<>%$");

const isDigit = (char: string) => char >= "0" && char <= "9";

/**
 * `Deuteronomy 32`, `deuteronomy-32` and `Deuteronomy32` → `deuteronomy`, `32`.
 *
 * A change between letters and digits starts a word too, so a chapter number
 * run into its book still counts as its own word. Written as a loop rather than
 * a Unicode regex for the same Hermes reason as `fold`: anything that is not a
 * separator is part of a word, whatever script it is in.
 */
function wordsOf(text: string): string[] {
  const words: string[] = [];
  let word = "";
  for (const char of text) {
    if (SEPARATORS.has(char)) {
      if (word !== "") words.push(word);
      word = "";
      continue;
    }
    if (word !== "" && isDigit(char) !== isDigit(word[word.length - 1])) {
      words.push(word);
      word = "";
    }
    word += char;
  }
  if (word !== "") words.push(word);
  return words;
}

/** Every word typed starts some word of `words`, in any order. */
function everyWordStarts(typed: readonly string[], words: readonly string[]): boolean {
  return typed.length > 0 && typed.every((t) => words.some((word) => word.startsWith(t)));
}

/**
 * The typed letters appear in order in the name, beginning at the start of one
 * of its words — so a dropped or skipped letter (`deutronomy`, `dt32`) still
 * finds the note.
 *
 * The word-start anchor is what keeps this from offering every long name: a
 * run of letters picked out of the middle of unrelated words is not something
 * anybody typed on purpose. Three letters at least, for the same reason.
 */
function lettersInOrder(compact: string, words: readonly string[]): boolean {
  if (compact.length < 3) return false;
  const joined = words.join("");
  let start = 0;
  for (const word of words) {
    if (word[0] === compact[0] && isSubsequence(compact, joined.slice(start))) return true;
    start += word.length;
  }
  return false;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return false;
}

/**
 * The notes that could be meant by `query`, best first.
 *
 * Ranked in bands rather than scored, because the bands are the thing a
 * person can predict, from closest to loosest:
 *
 *  0. the name *starts* with what you typed;
 *  1. the name contains it;
 *  2. each word you typed starts a word of the name — `Deut 32` finds
 *     `Deuteronomy 32`, in either order;
 *  3. the path contains it, or the same word starts count the folders' words
 *     — `sermons moses`;
 *  4. the letters you typed appear in order in the name, from the start of one
 *     of its words — `deutronomy 32`, `dt32`.
 *
 * Within a band, alphabetical with numbers read as numbers, so chapter 3 comes
 * before chapter 10 — a stable order matters more than a cleverer one when the
 * list is being rebuilt under a moving caret.
 *
 * The note being edited is never offered. A link from a note to itself is not
 * something somebody is reaching for at a `[[`, and it is the one candidate
 * guaranteed to rank first in every band.
 */
export function noteChoices(
  query: string,
  paths: readonly string[],
  self: string | null,
): NoteChoice[] {
  const needle = fold(query.trim());
  const typed = wordsOf(needle);
  const compact = typed.join("");
  const banded: { band: number; path: string }[] = [];

  for (const path of paths) {
    if (path === self) continue;
    const name = fold(baseName(path));
    const band = bandOf(name, path);
    if (band < 0) continue;
    banded.push({ band, path });
  }

  banded.sort((a, b) =>
    a.band === b.band ? a.path.localeCompare(b.path, undefined, { numeric: true }) : a.band - b.band,
  );
  return banded.slice(0, MAX_CHOICES).map(({ path }) => ({
    label: baseName(path),
    folder: folderOf(path),
    insert: path.replace(/\.md$/, ""),
  }));

  function bandOf(name: string, path: string): number {
    if (needle === "" || name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    const nameWords = wordsOf(name);
    if (everyWordStarts(typed, nameWords)) return 2;
    const folded = fold(path.replace(/\.md$/, ""));
    if (folded.includes(needle) || everyWordStarts(typed, wordsOf(folded))) return 3;
    if (lettersInOrder(compact, nameWords)) return 4;
    return -1;
  }
}
