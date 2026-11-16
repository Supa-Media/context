/**
 * HTML → text for mail, written as a character scanner rather than a set of
 * regexes. Shared by every path that turns an email's HTML into words a
 * person or a model reads: mail sent to a personal workspace's address
 * (`infra/email-worker/src/html.ts`) and Gmail, synced or read live
 * (`apps/mcp/src/communications/gmail/parsing.js`, which the control plane's
 * `read_email` route runs too).
 *
 * This runs on the body of a message a stranger sent. That rules out the usual
 * approach:
 *
 * - **No regex over the markup.** The idiomatic
 *   `<(script|style)[^>]*>[\s\S]*?<\/\1>` family nests quantifiers, and a body
 *   of a few hundred unclosed `<script` opens is enough to make an engine
 *   explore exponentially many ways to fail. A single left-to-right pass has
 *   one way to consume each character and therefore one running time: O(n),
 *   always, for every input.
 * - **No DOM, no parser library.** Nothing here builds a tree, resolves an
 *   entity table by reference, follows a `<base>`, or fetches a stylesheet.
 * - **Bounded twice.** The caller caps the input; this function caps the
 *   output, so a megabyte of `&nbsp;` still cannot produce more than
 *   `maxChars`.
 *
 * LINK ADDRESSES (the owner, 2026-11-16). By default a link becomes its words
 * and nothing else. With `{ links: true }` each link's address follows its
 * words in brackets, "Click here [https://reports.example.com/r/1]", because
 * a vendor's "Click here to view the report in (pdf) format" reached Tex
 * without the address behind it, and Tex could not open the report. The
 * address is the sender's, as untrusted as every other word of the email,
 * and is read the same way. Kept only when it is an http(s) address a reader
 * could not already see: never a `mailto:`, a page anchor or a script, never
 * an unsubscribe or preferences link, never one whose words already are the
 * address, each address once, and at most `MAX_LINKS` of them.
 *
 * Never kept: images, iframes, objects, embeds, SVG and MathML (with their
 * `alt` text: attacker-authored prose in a place a reader does not expect
 * prose), and anything inside `<head>`, including `<title>`.
 */

/** Elements whose *content* is not text and must be skipped, not emitted. */
const OPAQUE_ELEMENTS = new Set([
  "script", "style", "head", "title", "noscript", "template", "iframe", "object",
  "embed", "svg", "math", "applet", "frameset", "canvas",
]);

/** Elements that end a line when they open or close. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "div", "dd", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/**
 * The named entities worth resolving, and no more. A full HTML5 table would
 * only widen what a sender can produce without typing it; numeric references
 * are handled generically and cover everything else.
 */
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", pound: "£", euro: "€", deg: "°",
};

/** The most link addresses one email keeps. */
const MAX_LINKS = 50;
/** An address longer than this is left out rather than cut: a cut address opens nothing. */
const MAX_LINK_CHARS = 2_000;
/** A link that leaves the mailing list or changes what it sends, by its address or its words. */
const UNSUBSCRIBE = /unsubscribe|opt[-_ ]?out|(?:email|mail|subscription|communication)[-_ ]?preferences|manage[-_ ]?(?:your[-_ ]?)?(?:preferences|subscriptions?)/i;

/**
 * Resolve one character reference starting at `source[start]` (which is `&`).
 * Returns the text and how many characters were consumed, or null for "this
 * ampersand is just an ampersand". A reference longer than 32 characters is
 * not one.
 */
function readEntity(source, start) {
  // Looked for only as far as a reference can reach, so a run of `&` with no `;` is not a scan to the end for each.
  const near = source.slice(start + 1, start + 33).indexOf(";");
  const semicolon = near < 0 ? -1 : start + 1 + near;
  if (semicolon < 0 || semicolon - start > 32) return null;
  const body = source.slice(start + 1, semicolon);
  if (!body) return null;
  if (body[0] === "#") {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    if (!digits || digits.length > 8) return null;
    if (hex ? !/^[0-9a-fA-F]+$/.test(digits) : !/^[0-9]+$/.test(digits)) return null;
    const code = parseInt(digits, hex ? 16 : 10);
    // Surrogates and out-of-range values are not characters.
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return null;
    if (code >= 0xd800 && code <= 0xdfff) return null;
    // A control character by reference is refused rather than resolved: nothing downstream wants one.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return null;
    if (code === 0x7f) return null;
    return { text: String.fromCodePoint(code), length: semicolon - start + 1 };
  }
  const named = NAMED_ENTITIES[body.toLowerCase()];
  return named === undefined ? null : { text: named, length: semicolon - start + 1 };
}

/** An attribute's value with its references resolved: `&amp;` in an address is `&`. */
function decodeEntities(value) {
  let out = "";
  for (let i = 0; i < value.length; ) {
    if (value[i] === "&") {
      const entity = readEntity(value, i);
      if (entity) {
        out += entity.text;
        i += entity.length;
        continue;
      }
    }
    out += value[i];
    i += 1;
  }
  return out;
}

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * One attribute of a tag, from the text after its name up to its `>`: one
 * pass, each character looked at once. Null when the tag does not have it.
 */
function attributeOf(tag, wanted) {
  let i = 0;
  while (i < tag.length) {
    while (i < tag.length && (isSpace(tag[i]) || tag[i] === "/")) i += 1;
    const nameStart = i;
    while (i < tag.length && !isSpace(tag[i]) && tag[i] !== "=" && tag[i] !== ">" && tag[i] !== "/") i += 1;
    const name = tag.slice(nameStart, i).toLowerCase();
    if (i === nameStart) {
      i += 1;
      continue;
    }
    while (i < tag.length && isSpace(tag[i])) i += 1;
    let value = "";
    if (tag[i] === "=") {
      i += 1;
      while (i < tag.length && isSpace(tag[i])) i += 1;
      const quote = tag[i] === '"' || tag[i] === "'" ? tag[i] : "";
      if (quote) i += 1;
      const valueStart = i;
      while (i < tag.length && (quote ? tag[i] !== quote : !isSpace(tag[i]) && tag[i] !== ">")) i += 1;
      value = tag.slice(valueStart, i);
      if (quote) i += 1;
    }
    if (name === wanted) return value;
  }
  return null;
}

/** Words compared without case, spacing or a trailing slash. */
const plainOf = (text) => text.replace(/\s+/g, "").replace(/\/+$/, "").toLowerCase();
const withoutScheme = (url) => url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");

/**
 * Decides which link addresses an email's text keeps, in the order they come
 * (see the header). `keep(words, href)` answers the bracketed address to put
 * after the link's words, or "" to put nothing.
 */
function linkKeeper(maxLinks = MAX_LINKS) {
  const seen = new Set();
  return {
    keep(words, href) {
      if (seen.size >= maxLinks) return "";
      const url = decodeEntities(String(href ?? "")).trim();
      if (!/^https?:\/\/[^\s/?#]+/i.test(url) || url.length > MAX_LINK_CHARS) return "";
      // Nothing that could move a line around once rendered.
      if (/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(url)) return "";
      if (UNSUBSCRIBE.test(url) || UNSUBSCRIBE.test(words)) return "";
      const shown = plainOf(words);
      const bare = plainOf(withoutScheme(url));
      if (shown && bare && withoutScheme(shown).includes(bare)) return "";
      if (seen.has(url)) return "";
      seen.add(url);
      // A bracket inside the address would end the bracket around it.
      return ` [${url.replace(/\[/g, "%5B").replace(/\]/g, "%5D")}]`;
    },
  };
}

/**
 * Convert HTML to plain text.
 *
 * @param {string} html the source, already capped by the caller
 * @param {number} maxChars hard cap on the returned string
 * @param {(() => void) | undefined} onStep test-only hook, called once per
 *   iteration of the outer scan and its two inner tag-scanning loops; each
 *   strictly advances a cursor into `html`, so the calls are bounded by
 *   `html.length` whatever the input's shape (`infra/email-worker/src/html.test.ts`).
 * @param {{ links?: boolean }} [options] `links`: keep each link's address after its words.
 * @returns {string}
 */
function htmlToText(html, maxChars, onStep, options = {}) {
  const out = [];
  let length = 0;
  let full = false;
  const keeper = options.links === true ? linkKeeper() : null;
  // The link being read: its address and the words emitted inside it so far.
  let link = null;

  /** Append, refusing to grow past the cap. Once full, everything is a no-op. */
  const emit = (text) => {
    if (full || !text) return;
    if (link !== null && link.words.length < 500) link.words += text;
    if (length + text.length > maxChars) {
      out.push(text.slice(0, maxChars - length));
      length = maxChars;
      full = true;
      return;
    }
    out.push(text);
    length += text.length;
  };
  const endLink = () => {
    if (link === null) return;
    const { words, href } = link;
    link = null;
    emit(keeper.keep(words, href));
  };

  const newline = () => emit("\n");
  let index = 0;
  /** Non-empty while inside an element whose content is discarded. */
  let opaque = "";

  while (index < html.length && !full) {
    onStep?.();
    const char = html[index];

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
      // A newline in the source is whitespace, not a line break: only markup makes one.
      emit(char === "\n" || char === "\r" ? " " : char);
      index += 1;
      continue;
    }

    // A comment, skipped whole; an unterminated one swallows the rest, as a browser does.
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

    // `<`, an optional `/`, then name characters. A `<` with no name is a literal `<` ("a < b").
    let cursor = index + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (cursor < html.length && /[A-Za-z0-9]/.test(html[cursor])) {
      onStep?.();
      cursor += 1;
    }
    const name = html.slice(nameStart, cursor).toLowerCase();
    if (!name) {
      if (!opaque) emit("<");
      index += 1;
      continue;
    }
    const attributesStart = cursor;

    // To the end of the tag, honouring quotes so `title="a > b"` does not end it early.
    let quote = "";
    while (cursor < html.length) {
      onStep?.();
      const tagChar = html[cursor];
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
      // Only the matching close tag gets us out: a `<div>` inside `<script>` is script.
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

    if (keeper !== null && name === "a") {
      // A link left open ends where the next one starts, as a browser reads it.
      endLink();
      if (!closing) {
        const href = attributeOf(html.slice(attributesStart, cursor), "href");
        if (href !== null) link = { href, words: "" };
      }
    }

    if (name === "br") newline();
    else if (name === "li" && !closing) emit("\n- ");
    else if (BLOCK_ELEMENTS.has(name)) newline();

    index = tagEnd;
  }
  if (keeper !== null) endLink();

  return normalizeWhitespace(out.join(""));
}

/**
 * Collapse the whitespace an HTML document is full of, without joining words:
 * runs of spaces and tabs become one space, runs of newlines at most two, and
 * every line is trimmed. One pass, no regex.
 */
function normalizeWhitespace(text) {
  const lines = [];
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
    const char = text[index];
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

/** The bracketed addresses `htmlToText` kept in `rendered`, in order. */
function keptLinks(rendered) {
  return [...String(rendered ?? "").matchAll(/ \[(https?:\/\/[^\s\]]{1,2000})\]/g)].map((match) => match[1]);
}

/**
 * Which of an email's two bodies to read: its plain text, unless the HTML
 * carries a link address the plain text never shows (a "Click here" whose
 * address only the HTML has), then the HTML's text with its addresses.
 */
function preferredBody(plain, rendered) {
  if (!plain) return rendered ? { text: rendered, source: "html" } : { text: "", source: "none" };
  if (!rendered) return { text: plain, source: "plain" };
  const missing = keptLinks(rendered).some((url) => !plain.includes(url));
  return missing ? { text: rendered, source: "html" } : { text: plain, source: "plain" };
}

module.exports = { htmlToText, keptLinks, preferredBody, MAX_LINKS, MAX_LINK_CHARS };
