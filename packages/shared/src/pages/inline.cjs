/**
 * The words of a page, cut into runs that each know where they came from.
 *
 * A page is drawn from a Markdown note, and every word on it has to stay a
 * word in that note: typing over it on the page, or commenting on it, changes
 * the Markdown and nothing else (see `docs/decisions/app-and-console/pages.md`).
 * So the inline parser here keeps, for every run of plain text it finds, the
 * stretch of the source it was read from, `[from, to)`. An edit to a run is a
 * replacement of exactly that stretch, written back escaped (`escapeText`), and
 * a comment on a run is an anchor around exactly those characters.
 *
 * What it reads is the common, unambiguous part of Markdown that notes use:
 * `**strong**`, `*em*` / `_em_`, `~~struck~~`, `` `code` ``, `[words](url)`,
 * `[[a note]]`, `![alt](src)` / `![[picture.png]]`, backslash escapes, and the
 * comment anchors `<!--c:id-->…<!--/c:id-->`, which are zero-width here and
 * mark the runs between them as commented. Any other HTML comment is hidden.
 * Anything it does not read stays as the text it is, so nothing is lost.
 *
 * Code spans, link targets and wiki links are drawn but not editable: their
 * characters are not prose, and an edit that escaped them would change what
 * they point at.
 */

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";

/** Characters escaped when typed words are written back, so they stay words. */
const WRITE_ESCAPES = /[\\`*_[\]<>|~]/g;

/** A comment anchor marker; same shape as `comments.cjs`'s, matched here at a position. */
const MARKER = /^<!--(\/?)c:([A-Za-z0-9_-]{1,40})-->/;
const HTML_COMMENT = /^<!--[\s\S]*?-->/;
const CODE_SPAN = /^(`+)([\s\S]*?[^`])\1(?!`)/;
const WIKI = /^(!?)\[\[([^\]\n|]{1,300})(?:\|([^\]\n]{1,300}))?\]\]/;

/**
 * The runs of the source between `from` and `to`.
 *
 * Each run is `{ text, from, to, editable, strong, em, strike, code, href,
 * note, anchors }`, or an image `{ image: { src, alt }, from, to }`.
 * `anchors` lists the ids of the comment threads whose words include the run.
 */
function inlineRuns(source, from = 0, to = source.length) {
  const runs = [];
  const open = new Set(); // comment ids currently open
  const marks = { strong: false, em: false, strike: false };
  let i = from;
  let text = "";
  let textFrom = from;

  const flush = (end) => {
    if (text !== "") {
      runs.push({
        text,
        from: textFrom,
        to: end,
        editable: true,
        strong: marks.strong,
        em: marks.em,
        strike: marks.strike,
        anchors: [...open],
      });
    }
    text = "";
    textFrom = end;
  };
  const push = (run, end) => {
    flush(i);
    runs.push({ strong: marks.strong, em: marks.em, strike: marks.strike, anchors: [...open], ...run });
    i = end;
    textFrom = end;
  };

  while (i < to) {
    const c = source[i];
    const rest = () => source.slice(i, to);

    if (c === "\\" && i + 1 < to && ESCAPABLE.includes(source[i + 1])) {
      if (text === "") textFrom = i;
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "<" && source.startsWith("<!--", i)) {
      const marker = MARKER.exec(rest());
      if (marker) {
        flush(i);
        if (marker[1] === "/") open.delete(marker[2]);
        else open.add(marker[2]);
        i += marker[0].length;
        textFrom = i;
        continue;
      }
      const hidden = HTML_COMMENT.exec(rest());
      if (hidden) {
        flush(i);
        i += hidden[0].length;
        textFrom = i;
        continue;
      }
    }
    if (c === "`") {
      const code = CODE_SPAN.exec(rest());
      if (code) {
        push({ text: code[2].replace(/^ (.*) $/s, "$1"), from: i, to: i + code[0].length, editable: false, code: true }, i + code[0].length);
        continue;
      }
    }
    if (c === "[" || (c === "!" && source[i + 1] === "[")) {
      const wiki = WIKI.exec(rest());
      if (wiki) {
        const end = i + wiki[0].length;
        if (wiki[1] === "!") push({ image: { src: wiki[2].trim(), alt: (wiki[3] ?? "").trim() }, from: i, to: end }, end);
        else push({ text: (wiki[3] ?? wiki[2]).trim(), from: i, to: end, editable: false, note: wiki[2].trim() }, end);
        continue;
      }
      const link = linkAt(source, c === "!" ? i + 1 : i, to);
      if (link) {
        if (c === "!") {
          push({ image: { src: link.href, alt: source.slice(link.textFrom, link.textTo) }, from: i, to: link.end }, link.end);
          continue;
        }
        flush(i);
        const inner = inlineRuns(source, link.textFrom, link.textTo);
        for (const run of inner) {
          if (run.image) runs.push(run);
          else
            runs.push({
              ...run,
              strong: run.strong || marks.strong,
              em: run.em || marks.em,
              strike: run.strike || marks.strike,
              anchors: [...new Set([...open, ...run.anchors])],
              href: link.href,
            });
        }
        i = link.end;
        textFrom = i;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const toggled = toggleAt(source, i, to, marks);
      if (toggled) {
        flush(i);
        marks[toggled.mark] = !marks[toggled.mark];
        i += toggled.width;
        textFrom = i;
        continue;
      }
    }
    if (text === "") textFrom = i;
    text += c === "\n" ? " " : c;
    i += 1;
  }
  flush(to);
  return runs;
}

/** `[words](target)` starting at `at`, or null. Targets with spaces or a title are not read. */
function linkAt(source, at, to) {
  if (source[at] !== "[") return null;
  let depth = 0;
  let j = at;
  for (; j < to; j++) {
    const ch = source[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "\n" && source[j + 1] === "\n") return null;
    if (ch === "[") depth++;
    if (ch === "]" && --depth === 0) break;
  }
  if (j >= to || source[j + 1] !== "(") return null;
  const close = source.indexOf(")", j + 2);
  if (close === -1 || close >= to) return null;
  const href = source.slice(j + 2, close).trim();
  if (href === "" || /\s/.test(href)) return null;
  return { textFrom: at + 1, textTo: j, href, end: close + 1 };
}

/**
 * Whether the emphasis marker at `i` opens or closes a mark, and which.
 *
 * Opening needs a closer later in the same stretch, so a lone `*` (a price
 * footnote, a multiplication) stays a character. `_` only counts at a word's
 * edge, so `snake_case_names` stay whole.
 */
function toggleAt(source, i, to, marks) {
  const two = source.slice(i, i + 2);
  let mark;
  let width;
  if (two === "**" || two === "__") [mark, width] = ["strong", 2];
  else if (two === "~~") [mark, width] = ["strike", 2];
  else if (source[i] === "*" || source[i] === "_") [mark, width] = ["em", 1];
  else return null;
  const token = source.slice(i, i + width);
  const before = source[i - 1] ?? " ";
  const after = source[i + width] ?? " ";
  if (token[0] === "_" && /[A-Za-z0-9]/.test(marks[mark] ? after : before)) return null;
  if (marks[mark]) return /\s/.test(before) ? null : { mark, width };
  if (/\s/.test(after)) return null;
  for (let k = source.indexOf(token, i + width + 1); k !== -1 && k < to; k = source.indexOf(token, k + 1)) {
    if (/\s/.test(source[k - 1])) continue;
    // A single `*` that is half of a `**` closes nothing.
    if (width === 1 && (source[k + 1] === token || source[k - 1] === token)) continue;
    return { mark, width };
  }
  return null;
}

/** Typed words as Markdown that reads back as exactly those words: one line, punctuation escaped. */
function escapeText(text) {
  return String(text)
    .replace(/[\r\n]+/g, " ")
    .replace(WRITE_ESCAPES, (ch) => `\\${ch}`);
}

/**
 * Where the `offset`-th character a reader sees in a run sits in the source.
 * A run's words differ from its source only by backslash escapes, each one
 * character drawn from two.
 */
function sourceOffset(source, from, to, offset) {
  let seen = 0;
  let i = from;
  while (i < to && seen < offset) {
    i += source[i] === "\\" && i + 1 < to && ESCAPABLE.includes(source[i + 1]) ? 2 : 1;
    seen++;
  }
  return i;
}

/** The plain words of some runs, as a reader sees them. */
function runsText(runs) {
  return runs.map((run) => (run.image ? run.image.alt : run.text)).join("");
}

module.exports = { inlineRuns, escapeText, runsText, sourceOffset };
