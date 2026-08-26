/**
 * HTML → text, written as a character scanner rather than a set of regexes.
 *
 * This runs on the body of a message a stranger sent. That rules out the usual
 * approach:
 *
 * - **No regex.** The idiomatic `<(script|style)[^>]*>[\s\S]*?<\/\1>` family
 *   nests quantifiers, and a body of a few hundred unclosed `<script` opens is
 *   enough to make an engine explore exponentially many ways to fail. A single
 *   left-to-right pass has one way to consume each character and therefore one
 *   running time: O(n), always, for every input.
 * - **No DOM, no parser library.** Nothing here builds a tree, resolves an
 *   entity table by reference, follows a `<base>`, or fetches a stylesheet. The
 *   scanner has no way to reach the network and no external-entity concept to
 *   abuse — the HTML analogue of the XXE class simply has no surface here.
 * - **Bounded twice.** The caller caps the input; this function caps the
 *   output. Neither cap depends on the other, so a decompression-style
 *   expansion (a megabyte of `&nbsp;` becoming markup-free text) still cannot
 *   produce more than `maxChars`.
 *
 * What it deliberately does *not* preserve:
 *
 * - **Link targets.** `<a href>` becomes its text and nothing else. A URL is
 *   the single most useful thing to smuggle into someone's notes — it renders
 *   as friendly text, points somewhere else, and an agent reading the note may
 *   follow it. If link capture is ever wanted it should be a policy option with
 *   its own argument, not a default.
 * - **Images, iframes, objects, embeds, SVG, MathML.** Dropped whole, including
 *   `alt` text: an `alt` is attacker-authored prose in a place a reader does
 *   not expect prose.
 * - **Anything inside `<head>`.** Including `<title>`, which is not body text.
 */

/** Elements whose *content* is not text and must be skipped, not emitted. */
const OPAQUE_ELEMENTS = new Set([
  "script",
  "style",
  "head",
  "title",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "applet",
  "frameset",
  "canvas",
]);

/** Elements that end a line when they open or close. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "div", "dd", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/**
 * The named entities worth resolving, and no more.
 *
 * A full HTML5 named-entity table is ~2200 entries whose only effect here would
 * be to widen what a sender can produce without typing it. Numeric references
 * are handled generically below and cover everything else.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  pound: "£",
  euro: "€",
  deg: "°",
};

/**
 * Resolve one character reference starting at `source[start]` (which is `&`).
 *
 * Returns the resolved text and how many characters were consumed, or `null` to
 * mean "this ampersand is just an ampersand". Bounded: a reference longer than
 * 32 characters is not a reference.
 */
function readEntity(source: string, start: number): { text: string; length: number } | null {
  const semicolon = source.indexOf(";", start + 1);
  if (semicolon < 0 || semicolon - start > 32) return null;
  const body = source.slice(start + 1, semicolon);
  if (!body) return null;

  if (body[0] === "#") {
    const digits = body[1] === "x" || body[1] === "X" ? body.slice(2) : body.slice(1);
    const radix = body[1] === "x" || body[1] === "X" ? 16 : 10;
    if (!digits || digits.length > 8) return null;
    if (radix === 16 ? !/^[0-9a-fA-F]+$/.test(digits) : !/^[0-9]+$/.test(digits)) return null;
    const code = parseInt(digits, radix);
    // Surrogates and out-of-range values are not characters; a lone surrogate
    // in a note is a string that cannot be encoded to UTF-8 later.
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    // A numeric reference is a normal way to write a control character. Refuse
    // rather than resolve: nothing downstream wants one.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return null;
    if (code === 0x7f) return null;
    return { text: String.fromCodePoint(code), length: semicolon - start + 1 };
  }

  const named = NAMED_ENTITIES[body.toLowerCase()];
  return named === undefined ? null : { text: named, length: semicolon - start + 1 };
}

/**
 * Convert HTML to plain text.
 *
 * @param html      the source, already capped by the caller
 * @param maxChars  hard cap on the returned string
 */
export function htmlToText(html: string, maxChars: number): string {
  const out: string[] = [];
  let length = 0;
  let full = false;

  /** Append, refusing to grow past the cap. Once full, everything is a no-op. */
  const emit = (text: string) => {
    if (full || !text) return;
    if (length + text.length > maxChars) {
      out.push(text.slice(0, maxChars - length));
      length = maxChars;
      full = true;
      return;
    }
    out.push(text);
    length += text.length;
  };

  /** A structural newline. Never more than two in a row survive normalisation. */
  const newline = () => emit("\n");

  let index = 0;
  /** Non-empty while inside an element whose content is discarded. */
  let opaque = "";

  while (index < html.length && !full) {
    const char = html[index]!;

    if (char !== "<") {
      if (opaque) {
        index += 1;
        continue;
      }
      if (char === "&") {
        const entity = readEntity(html, index);
        if (entity) {
          emit(entity.text);
          index += entity.length;
          continue;
        }
      }
      // A newline in the *source* is whitespace, not a line break — that is
      // what HTML means by it. Only a structural `newline()` produces a real
      // one, so the line structure of the output comes from the markup rather
      // than from how the sender happened to wrap their file. (The cost is
      // `<pre>`, whose line breaks are lost. Formatting is discarded anyway.)
      emit(char === "\n" || char === "\r" ? " " : char);
      index += 1;
      continue;
    }

    // A comment or a doctype/CDATA-ish bogus comment. Skipped whole; an
    // unterminated one swallows the rest of the document, which is exactly what
    // a browser does and the safest reading of "the author meant to hide this".
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", index) || html.startsWith("<?", index)) {
      const end = html.indexOf(">", index + 2);
      index = end < 0 ? html.length : end + 1;
      continue;
    }

    // Read the tag name without a regex: `<` then an optional `/` then name
    // characters. A `<` that is not followed by a name is a literal `<`, which
    // is how mail written by hand ("a < b") survives.
    let cursor = index + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (cursor < html.length && /[A-Za-z0-9]/.test(html[cursor]!)) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    if (!name) {
      if (!opaque) emit("<");
      index += 1;
      continue;
    }

    // Skip to the end of the tag, honouring quoted attribute values so a `>`
    // inside `title="a > b"` does not end it early.
    let quote = "";
    while (cursor < html.length) {
      const tagChar = html[cursor]!;
      if (quote) {
        if (tagChar === quote) quote = "";
      } else if (tagChar === '"' || tagChar === "'") {
        quote = tagChar;
      } else if (tagChar === ">") {
        break;
      }
      cursor += 1;
    }
    const tagEnd = cursor < html.length ? cursor + 1 : html.length;

    if (opaque) {
      // Only the matching close tag gets us out. A `<div>` inside `<script>` is
      // script, not markup.
      if (closing && name === opaque) opaque = "";
      index = tagEnd;
      continue;
    }

    if (!closing && OPAQUE_ELEMENTS.has(name)) {
      // A self-closing form (`<svg/>`) never opens a region.
      const selfClosing = html[tagEnd - 2] === "/";
      if (!selfClosing) opaque = name;
      index = tagEnd;
      continue;
    }

    if (name === "br") newline();
    else if (name === "li" && !closing) emit("\n- ");
    else if (BLOCK_ELEMENTS.has(name)) newline();

    index = tagEnd;
  }

  return normalizeWhitespace(out.join(""));
}

/**
 * Collapse the whitespace an HTML document is full of, without joining words.
 *
 * A single pass, no regex: runs of spaces and tabs become one space, runs of
 * newlines become at most two, and every line is trimmed.
 */
function normalizeWhitespace(text: string): string {
  const lines: string[] = [];
  let line = "";
  let space = false;
  let blanks = 0;

  const endLine = () => {
    const trimmed = line.trim();
    line = "";
    space = false;
    if (trimmed) {
      blanks = 0;
      lines.push(trimmed);
      return;
    }
    blanks += 1;
    if (blanks === 1) lines.push("");
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\n") {
      endLine();
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || char === "\f" || char === "\v") {
      space = true;
      continue;
    }
    if (space && line) line += " ";
    space = false;
    line += char;
  }
  endLine();

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  while (lines.length && lines[0] === "") lines.shift();
  return lines.join("\n");
}
