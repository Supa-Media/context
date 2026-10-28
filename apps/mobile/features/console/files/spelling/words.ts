/**
 * Which runs of a note's text are words to spell, as a pure function of the text.
 *
 * The checker is our own (see `README` in this folder's `extension.ts`), so the
 * question "is this prose?" is ours to answer too, and the browser's answer was
 * the wrong one for a Markdown note: it underlined code spans, addresses, tags
 * and identifiers, which is the cost the old `spellcheck="true"` comment in
 * `editorSetup.ts` said it was accepting. Board 5 (2026-10-27) lists what is
 * left alone, and this module is that list.
 *
 * Two layers, because they know different things:
 *
 *  - **This file** looks at characters. A chunk of text between spaces that
 *    holds a digit, an `@`, a `#`, a slash, a colon, an underscore, an `=` or
 *    an inner `.` is an address, a handle, a tag, a path, a version or an
 *    identifier — never prose. A word in capitals is an acronym, and a word
 *    with a capital in the middle (`iPhone` aside, which the dictionary knows)
 *    is a name somebody typed on purpose.
 *  - **`extension.ts`** looks at the syntax tree, for what only the parser
 *    can see: inside a fenced block, a code span, a URL, an HTML tag, the
 *    front matter, a `[[note link]]`.
 *
 * Kept free of CodeMirror and of the dictionary so every rule here is a plain
 * node test (`__tests__/spellingWords.test.ts`).
 */

export interface WordRange {
  /** Offset of the word's first character, in the text the caller passed plus `offset`. */
  from: number;
  to: number;
  /** The word as typed, with a curly apostrophe made straight for the dictionary. */
  word: string;
}

/** A letter, in any script, or a combining mark that belongs to one. */
const LETTER = /[\p{L}\p{M}]/u;

/**
 * Characters that make a whole chunk something other than prose.
 *
 * `.` is not here: a full stop ends sentences, so only an *inner* one counts
 * (`e.g.`, `notes.md`, `context.lc`), which `hasInnerDot` asks separately.
 */
const NOT_PROSE = /[\p{N}@#/\\:_=<>{}|~^$%&+*`]/u;

/** Punctuation a word can sit inside of without being part of it. */
const EDGE = /^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu;

/** What may open a word: emphasis, quotes, brackets, Spanish marks. */
const WRAP_LEAD = /^[*_~"'\u201C\u201D\u2018\u2019([\u00A1\u00BF]+/u;

/** What may close one: emphasis, quotes, brackets and sentence punctuation. */
const WRAP_TRAIL = /[*_~"'\u201C\u201D\u2018\u2019)\].,;:!?\u2026]+$/u;

/** Apostrophes, straight and curly, which join `don't` into one word. */
const APOSTROPHE = /['’]/u;

/**
 * Every word worth checking in one line of text.
 *
 * `offset` is the line's position in the document, so the ranges come back in
 * document coordinates and the caller never adds it twice.
 */
export function wordsIn(text: string, offset = 0): WordRange[] {
  const words: WordRange[] = [];
  /*
    A link's address is not prose, and it is glued to the link's text with no
    space: `[the plan](notes/plan.md)` is one chunk. Blank the address out
    (same length, so offsets hold) and the text before it is checked alone.
  */
  const line = text.replace(/\]\([^)\s]*\)/gu, (address) => "]" + " ".repeat(address.length - 1));
  const chunk = /\S+/gu;
  for (let match = chunk.exec(line); match !== null; match = chunk.exec(line)) {
    const raw = match[0];
    const start = match.index;
    /*
      Emphasis markers, quotes and brackets are Markdown or punctuation around
      a word, not part of it: `**bold**`, `(aside)`, `"quoted"`, `end.` Strip
      exactly those from both ends first, and only then ask whether what is
      left is prose — otherwise every bolded word would read as holding a `*`,
      while `@seyi` and `#tag` must keep the mark that disqualifies them.
    */
    const lead = WRAP_LEAD.exec(raw)?.[0].length ?? 0;
    const trail = WRAP_TRAIL.exec(raw.slice(lead))?.[0].length ?? 0;
    const core = raw.slice(lead, raw.length - trail);
    if (core === "") continue;
    const coreStart = lead;
    if (NOT_PROSE.test(core) || hasInnerDot(core)) continue;
    // Hyphenated compounds are checked part by part: `well-known` is two words.
    let at = 0;
    for (const part of core.split(/[-‐‑–—]/u)) {
      const from = offset + start + coreStart + at;
      at += part.length + 1;
      const word = part.replace(EDGE, "");
      if (word === "" || !worthSpelling(word)) continue;
      const inner = part.indexOf(word);
      words.push({ from: from + inner, to: from + inner + word.length, word: word.replace(/’/gu, "'") });
    }
  }
  return words;
}

/** `e.g.`, `notes.md`, `context.lc`: a dot with a letter on each side. */
function hasInnerDot(core: string): boolean {
  return /[\p{L}\p{M}]\.[\p{L}\p{M}]/u.test(core);
}

/**
 * Whether one word, already stripped of punctuation, is a word to look up.
 *
 * A single letter is never misspelled. Capitals throughout (`NASA`, `PR`) are
 * an acronym; a capital after a lower-case letter (`GitHub`, `useState`) is a
 * name or an identifier somebody typed on purpose, and underlining it is the
 * noise that makes people turn checking off.
 */
export function worthSpelling(word: string): boolean {
  const letters = [...word].filter((ch) => LETTER.test(ch));
  if (letters.length < 2) return false;
  if (word.split(APOSTROPHE).some((piece) => piece === "")) return false;
  const lettersOnly = letters.join("");
  if (lettersOnly === lettersOnly.toUpperCase() && lettersOnly !== lettersOnly.toLowerCase()) return false;
  if (/\p{Ll}\p{Lu}/u.test(word)) return false;
  return true;
}

/**
 * Ranges inside `[[…]]` on one line, which name a note rather than say anything.
 *
 * The note-link syntax is drawn by a decoration rather than parsed into the
 * tree, so `extension.ts` cannot ask the parser for it; it is found here, by
 * the same pairing the link extension uses.
 */
export function noteLinkRanges(text: string, offset = 0): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const link = /\[\[[^\]\n]*\]\]/gu;
  for (let match = link.exec(text); match !== null; match = link.exec(text)) {
    ranges.push({ from: offset + match.index, to: offset + match.index + match[0].length });
  }
  return ranges;
}
