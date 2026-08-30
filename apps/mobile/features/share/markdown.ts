/**
 * Markdown for reading, not for editing.
 *
 * The console's editor draws Markdown by *decorating the source* — see
 * `console/files/livePreview.ts` — because the buffer there is the file and
 * nothing may rewrite it. A shared note is the opposite situation: nobody is
 * editing it, the reader wants a document rather than a source listing, and the
 * text belongs to somebody else.
 *
 * That last part is why this exists at all rather than reusing CodeMirror. This
 * parses **another person's note**, so the questions are what a hostile
 * document can do to the reader:
 *
 *  - **No HTML is ever interpreted.** A note may contain `<script>`, an
 *    `onerror` attribute or an `<iframe>`; every one of them is text. React
 *    Native has no `dangerouslySetInnerHTML` equivalent in the components this
 *    renders into, so the risk is not injection into the DOM — it is a renderer
 *    that decides to be clever later. The block type list below is closed, so
 *    "clever" would have to be added on purpose.
 *  - **Every link is checked before it is offered.** `javascript:`, `data:` and
 *    `vbscript:` URLs are dropped to plain text rather than rendered as
 *    something tappable, because a shared note is a document a stranger wrote
 *    and the reader has no reason to expect a link in it to be hostile.
 *  - **Nothing is fetched.** Images are shown as their alt text, not loaded. A
 *    remote image in a shared note is a tracking pixel that reports every read
 *    to whoever wrote it, and — because a share is addressed to one named
 *    person — that is a read receipt the reader never agreed to.
 *
 * ## Deliberately small
 *
 * Headings, paragraphs, lists, quotes, fenced code, tables, thematic breaks,
 * and inline emphasis/code/links. No footnotes, no definition lists, no raw
 * HTML, no math. A shared note that uses something outside this renders as
 * legible text rather than as markup, which is the failure this is willing to
 * have: an unstyled line is readable, and a half-parsed one is not.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strike"; text: string }
  /** `href` is already vetted by `safeHref`; a rejected one arrives as `text`. */
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "bullet"; items: Inline[][] }
  | { kind: "ordered"; items: Inline[][] }
  | { kind: "quote"; content: Inline[] }
  | { kind: "code"; text: string; language?: string }
  | { kind: "rule" }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] };

/**
 * The most blocks one note contributes.
 *
 * A bound rather than a guess about how people write: this renders on a phone,
 * and a note with fifty thousand lines would freeze the screen for a reader who
 * only wanted the top of it. Anything past the cap is dropped and the caller is
 * told, so a truncated document is never presented as a whole one.
 */
export const MAX_BLOCKS = 2_000;

export interface ParsedNote {
  blocks: Block[];
  /** True when `MAX_BLOCKS` cut the document short. Shown, never hidden. */
  truncated: boolean;
}

/**
 * Schemes a link may use.
 *
 * An allow-list, because the alternative is guessing which of the hundreds of
 * registered schemes a platform will hand to another application. `mailto:` is
 * included because a shared note naming an address is ordinary; `tel:` for the
 * same reason.
 */
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;

/** Anything with a scheme at all — used to tell relative links from absolute. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A link's href, or `null` if it must not be offered as one.
 *
 * A relative link (`proposal.md`, `#section`) is dropped too, and that is not
 * caution about the URL — it is that a shared note's neighbours are reached
 * through the share's own traversal rules, not by the reader following a
 * filesystem path into a bucket they have no access to. The viewer resolves
 * those separately; here they are text.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === "") return null;
  // A control character inside a URL is either an attack or a broken document,
  // and both are better as text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  if (!HAS_SCHEME.test(href)) return null;
  return SAFE_SCHEME.test(href) ? href : null;
}

/* -------------------------------------------------------------------------- */
/*                                   inline                                   */
/* -------------------------------------------------------------------------- */

/**
 * Inline markup, in one left-to-right pass.
 *
 * Code spans are consumed first at each position, which is what makes
 * `` `**not bold**` `` render as literal asterisks: inside a code span nothing
 * else is markup. A regex-per-feature over the whole string cannot express
 * that, and gets it wrong in exactly the case somebody documenting Markdown
 * will hit.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";

  const flush = () => {
    if (plain !== "") {
      out.push({ kind: "text", text: plain });
      plain = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    // Code first. Nothing inside a span is markup.
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ kind: "code", text: code[1] });
      i += code[0].length;
      continue;
    }

    // An image renders as its alt text and fetches nothing. See the module
    // comment: a remote image in somebody else's note is a read receipt.
    const image = matchLink(rest, true);
    if (image) {
      flush();
      if (image.label !== "") out.push({ kind: "text", text: image.label });
      i += image.length;
      continue;
    }

    const link = matchLink(rest, false);
    if (link) {
      flush();
      const href = safeHref(link.target);
      // A rejected scheme becomes the label as plain text — never a link, and
      // never silently dropped, because the words were part of the sentence.
      out.push(
        href === null
          ? { kind: "text", text: link.label }
          : { kind: "link", text: link.label, href },
      );
      i += link.length;
      continue;
    }

    // A wikilink's label is what a reader sees in Obsidian, so it is what they
    // see here. The target is not a link: it names a note in a bucket this
    // reader reaches through the share, not through a URL.
    const wiki = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(rest);
    if (wiki) {
      flush();
      out.push({ kind: "text", text: wiki[2] ?? wiki[1] });
      i += wiki[0].length;
      continue;
    }

    const strong = /^\*\*([^\n]+?)\*\*/.exec(rest);
    if (strong) {
      flush();
      out.push({ kind: "strong", text: strong[1] });
      i += strong[0].length;
      continue;
    }

    const strike = /^~~([^\n]+?)~~/.exec(rest);
    if (strike) {
      flush();
      out.push({ kind: "strike", text: strike[1] });
      i += strike[0].length;
      continue;
    }

    // Single `*` only, and never `_`: `snake_case_names` are ordinary words in
    // these notes and italicising half of one is worse than missing emphasis.
    const em = /^\*([^*\n]+?)\*/.exec(rest);
    if (em) {
      flush();
      out.push({ kind: "em", text: em[1] });
      i += em[0].length;
      continue;
    }

    plain += source[i];
    i += 1;
  }

  flush();
  return out;
}


/**
 * `[label](target)` at the start of `rest`, with **balanced parentheses** in
 * the target.
 *
 * Written by hand rather than as a regex because a regex that stops at the
 * first `)` cuts `javascript:alert(1)` in half — leaving the trailing paren
 * behind as stray text next to the label. That is visible on screen, and it was
 * found by looking at a rendered note rather than by a test.
 *
 * Balanced rather than greedy-to-the-last-paren: a note reading
 * `[a](x) and (an aside)` must not swallow the aside.
 */
function matchLink(
  rest: string,
  image: boolean,
): { label: string; target: string; length: number } | null {
  const open = image ? "![" : "[";
  if (!rest.startsWith(open)) return null;

  const labelEnd = rest.indexOf("]", open.length);
  if (labelEnd === -1) return null;
  const label = rest.slice(open.length, labelEnd);
  if (label.includes("\n")) return null;
  if (rest[labelEnd + 1] !== "(") return null;

  let depth = 1;
  let i = labelEnd + 2;
  for (; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === "\n") return null;
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;

  const inner = rest.slice(labelEnd + 2, i);
  // A title after the target — `[a](b.md "Title")` — is not part of the URL.
  const target = inner.trim().split(/\s+/)[0].replace(/^<|>$/g, "");
  return { label, target, length: i + 1 };
}

/* -------------------------------------------------------------------------- */
/*                                   blocks                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parse a note into blocks.
 *
 * Line-based, and that is the whole design: a shared note comes out of a bucket
 * somebody edits in Obsidian, so it is ordinary Markdown rather than anything
 * needing a full CommonMark state machine. What matters is that an
 * unrecognised construct degrades to a paragraph instead of disappearing.
 */
export function parseNote(source: string): ParsedNote {
  const lines = stripFrontmatter(source).split(/\r?\n/);
  const blocks: Block[] = [];
  let i = 0;
  let truncated = false;

  const push = (block: Block): boolean => {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      return false;
    }
    blocks.push(block);
    return true;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // A fence runs to its closing marker or to the end of the note. An
    // unterminated one swallowing the rest is what every renderer does, and it
    // is the safe reading: the author opened a code block.
    const fence = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      if (!push({ kind: "code", text: body.join("\n"), ...(fence[2] ? { language: fence[2] } : {}) })) break;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      if (!push({ kind: "heading", level, content: parseInline(heading[2].trim()) })) break;
      i += 1;
      continue;
    }

    // `---`, `***`, `___` — three or more of one character, spaces allowed
    // between. Written without a backreference inside a character class, which
    // is a syntax error rather than the repetition it looks like.
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      if (!push({ kind: "rule" })) break;
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      if (!push({ kind: "quote", content: parseInline(body.join(" ").trim()) })) break;
      continue;
    }

    // A table needs its delimiter row; without one these are ordinary
    // paragraphs full of pipes, which is what a reader would rather see than a
    // grid built out of a guess.
    if (line.includes("|") && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      if (!push({ kind: "table", header, rows })) break;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const items: Inline[][] = [];
      while (i < lines.length) {
        const item = /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
        if (item === null) break;
        items.push(parseInline(item[1]));
        i += 1;
      }
      if (!push({ kind: "bullet", items })) break;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const items: Inline[][] = [];
      while (i < lines.length) {
        const item = /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]);
        if (item === null) break;
        items.push(parseInline(item[1]));
        i += 1;
      }
      if (!push({ kind: "ordered", items })) break;
      continue;
    }

    // Everything else is a paragraph, and consecutive lines join into one the
    // way Markdown means them to.
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      body.push(lines[i].trim());
      i += 1;
    }
    if (body.length === 0) {
      // `isBlockStart` said yes to a line no branch above claimed. Take it as
      // text rather than looping forever on it.
      body.push(lines[i].trim());
      i += 1;
    }
    if (!push({ kind: "paragraph", content: parseInline(body.join(" ")) })) break;
  }

  return { blocks, truncated };
}

/** Does this line begin a block, so a paragraph must stop before it? */
function isBlockStart(line: string): boolean {
  return (
    /^\s*(#{1,6})\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*+]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) ||
    /^\s*(`{3,}|~{3,})/.test(line) ||
    /^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)
  );
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): Inline[][] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => parseInline(cell.trim()));
}

/**
 * Drop YAML frontmatter.
 *
 * A reader wants the note, not its filing metadata — and `visibility:` sitting
 * at the top of a shared document reads as a statement about *their* access,
 * which it is not: frontmatter describes a note and `privacy.md` decides who
 * sees it. Showing it would be actively misleading.
 */
function stripFrontmatter(source: string): string {
  if (!source.startsWith("---")) return source;
  const end = source.indexOf("\n---", 3);
  if (end === -1) return source;
  const after = source.indexOf("\n", end + 1);
  return after === -1 ? "" : source.slice(after + 1);
}

/**
 * The note's own title, if its first heading is one.
 *
 * Used for the page's heading, so a reader sees the document's name rather
 * than a filename. `null` when the note opens with prose — in which case the
 * viewer falls back to the path, which is always something.
 */
export function noteTitle(blocks: readonly Block[]): string | null {
  const first = blocks[0];
  if (first === undefined || first.kind !== "heading" || first.level !== 1) return null;
  const text = first.content.map((run) => run.text).join("").trim();
  return text === "" ? null : text;
}
