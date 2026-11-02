/**
 * A page note (`<name>.page.md`), read into the parts a page is drawn from.
 *
 * The format is Markdown with three kinds of fenced block on top
 * (`docs/decisions/app-and-console/pages.md`):
 *
 *  - **Words** are ordinary Markdown: headings, paragraphs, lists, tasks,
 *    quotes, tables, rules. `##` headings are the page's sections.
 *  - **Blocks** are fences whose info string names a block kind
 *    (`blocks.cjs`): ```` ```compare Quotes per head ````, then one item per
 *    line (`- Casa Lola: $29 | Family style`) and settings as `key: value`
 *    lines. A block is data the page runtime draws; opened anywhere else it
 *    reads as the list it is.
 *  - **Code**: a ```` ```css ```` fence styles the page; a ```` ```box ````
 *    fence is HTML (with its own style and script) drawn in a sealed box of
 *    its own. Neither ever holds the page's words.
 *
 * Every node keeps where it came from in the source, and every word in it is a
 * run from `inline.cjs` with its own `[from, to)`, so the page can be edited and
 * commented on as the note. The `comments` block is left out: the threads are
 * the comment layer's (`comments.cjs`), never page content.
 *
 * Nothing here throws on a note it cannot make sense of: a fence that never
 * closes runs to the end, a block line it cannot read is reported as a
 * problem on that block and drawn as text.
 */

const { inlineRuns } = require("./inline.cjs");
const { BLOCK_KINDS, checkBlock } = require("./blocks.cjs");

const PAGE_SUFFIX = ".page.md";

/** Whether a note is a page, decided by its name like a drawing or a code note is. */
function isPagePath(path) {
  return typeof path === "string" && path.toLowerCase().endsWith(PAGE_SUFFIX) && path.length > PAGE_SUFFIX.length;
}

/** The note's lines, each with its offsets: `{ text, from, to }`, `to` before the newline. */
function linesOf(source, start) {
  const lines = [];
  let from = start;
  while (from <= source.length) {
    const nl = source.indexOf("\n", from);
    const to = nl === -1 ? source.length : nl;
    lines.push({ text: source.slice(from, to).replace(/\r$/, ""), from, to });
    if (nl === -1) break;
    from = nl + 1;
  }
  return lines;
}

/** Front matter at the very top, as plain `key: value` pairs (nested YAML is left alone), and where the body starts. */
function frontMatter(source) {
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (!open) return { fields: {}, end: 0 };
  const close = /\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(open[0].length - 1));
  if (!close) return { fields: {}, end: 0 };
  const bodyStart = open[0].length - 1 + close.index + close[0].length;
  const fields = {};
  for (const line of source.slice(open[0].length, open[0].length - 1 + close.index).split("\n")) {
    const pair = /^([A-Za-z][\w-]{0,40}):[ \t]*(.*?)\s*$/.exec(line);
    if (!pair) continue;
    fields[pair[1].toLowerCase()] = pair[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { fields, end: bodyStart };
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)\s*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i;
const TABLE_SEP = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

/** Read a whole page note. */
function parsePage(source) {
  const text = typeof source === "string" ? source : "";
  const front = frontMatter(text);
  const lines = linesOf(text, front.end);
  const nodes = [];
  let i = 0;

  const runsOf = (from, to) => inlineRuns(text, from, to);
  const offsetIn = (line, part) => line.from + line.text.indexOf(part);

  while (i < lines.length) {
    const line = lines[i];
    if (line.text.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line.text);
    if (fence) {
      const marker = fence[2];
      const info = fence[3];
      let j = i + 1;
      while (j < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j].text);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
        j++;
      }
      const closed = j < lines.length;
      const bodyFrom = i + 1 < lines.length ? lines[i + 1].from : line.to;
      const bodyTo = closed ? (j > i + 1 ? lines[j - 1].to : bodyFrom) : text.length;
      const node = fenced(text, info, lines.slice(i + 1, j), {
        from: line.from,
        to: closed ? lines[j].to : text.length,
        bodyFrom,
        bodyTo,
        closeFrom: closed ? lines[j].from : text.length,
        closed,
      });
      if (node) nodes.push(node);
      i = closed ? j + 1 : lines.length;
      continue;
    }

    const heading = HEADING.exec(line.text);
    if (heading) {
      const textFrom = offsetIn(line, heading[2]);
      const textTo = textFrom + heading[2].length;
      nodes.push({ type: "heading", level: heading[1].length, runs: runsOf(textFrom, textTo), from: line.from, to: line.to });
      i++;
      continue;
    }

    if (RULE.test(line.text)) {
      nodes.push({ type: "rule", from: line.from, to: line.to });
      i++;
      continue;
    }

    if (LIST.test(line.text)) {
      const items = [];
      let ordered = null;
      while (i < lines.length && LIST.test(lines[i].text)) {
        const [, indent, bullet, rest] = LIST.exec(lines[i].text);
        if (ordered === null) ordered = /\d/.test(bullet);
        const contentFrom = lines[i].to - rest.length;
        const task = TASK.exec(rest);
        const wordsFrom = task ? contentFrom + task[0].length : contentFrom;
        // Lines indented under an item, that are not items themselves, continue it.
        let end = lines[i].to;
        let k = i + 1;
        while (k < lines.length && /^[ \t]{2,}\S/.test(lines[k].text) && !LIST.test(lines[k].text)) end = lines[k++].to;
        items.push({
          depth: Math.min(3, Math.floor(indent.replace(/\t/g, "  ").length / 2)),
          task: task ? { checked: task[1] !== " ", at: contentFrom + 1 } : null,
          runs: runsOf(wordsFrom, end),
          from: lines[i].from,
          to: end,
        });
        i = k;
      }
      nodes.push({ type: "list", ordered: ordered === true, items, from: items[0].from, to: items[items.length - 1].to });
      continue;
    }

    if (QUOTE.test(line.text)) {
      const parts = [];
      const start = line.from;
      let alert = null;
      while (i < lines.length && QUOTE.test(lines[i].text)) {
        const inner = QUOTE.exec(lines[i].text)[1];
        let innerFrom = lines[i].to - inner.length;
        if (parts.length === 0 && alert === null) {
          const tag = ALERT.exec(inner);
          if (tag) {
            alert = tag[1].toLowerCase();
            innerFrom += tag[0].length;
          }
        }
        if (innerFrom < lines[i].to) parts.push([innerFrom, lines[i].to]);
        i++;
      }
      const runs = [];
      for (const [from, to] of parts) {
        if (runs.length > 0) runs.push({ text: " ", from, to: from, editable: false, anchors: [] });
        runs.push(...runsOf(from, to));
      }
      nodes.push({ type: "quote", alert, runs, from: start, to: lines[i - 1].to });
      continue;
    }

    if (line.text.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].text)) {
      const head = cells(text, line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].text.includes("|") && lines[j].text.trim() !== "") rows.push(cells(text, lines[j++]));
      nodes.push({
        type: "table",
        head: head.map(([from, to]) => runsOf(from, to)),
        rows: rows.map((row) => row.map(([from, to]) => runsOf(from, to))),
        from: line.from,
        to: lines[j - 1].to,
      });
      i = j;
      continue;
    }

    // A paragraph: lines up to a blank one or the start of anything else.
    const start = i;
    while (
      i < lines.length &&
      lines[i].text.trim() !== "" &&
      (i === start || !(FENCE.test(lines[i].text) || HEADING.test(lines[i].text) || LIST.test(lines[i].text) || QUOTE.test(lines[i].text)))
    ) {
      i++;
    }
    const from = lines[start].from + (lines[start].text.length - lines[start].text.trimStart().length);
    nodes.push({ type: "paragraph", runs: runsOf(from, lines[i - 1].to), from: lines[start].from, to: lines[i - 1].to });
  }

  const firstHeading = nodes.find((node) => node.type === "heading" && node.level === 1);
  return {
    fields: front.fields,
    bodyStart: front.end,
    title: front.fields.title || (firstHeading ? firstHeading.runs.map((run) => run.text ?? "").join("").trim() : ""),
    nodes,
    problems: nodes.flatMap((node) => (node.problems ?? []).map((problem) => ({ ...problem, from: node.from }))),
  };
}

/** A table row's cells, as source ranges with the pipes and padding left out. Escaped `\|` stays in its cell. */
function cells(source, line) {
  const out = [];
  let start = line.from;
  const end = line.to;
  let k = start;
  while (k < end && /\s/.test(source[k])) k++;
  if (source[k] === "|") start = k + 1;
  for (k = start; k <= end; k++) {
    if (source[k] === "\\") {
      k++;
      continue;
    }
    if (k === end || source[k] === "|") {
      let a = start;
      let b = k;
      while (a < b && /\s/.test(source[a])) a++;
      while (b > a && /\s/.test(source[b - 1])) b--;
      if (!(k === end && a === b && out.length > 0)) out.push([a, b]);
      start = k + 1;
    }
  }
  return out;
}

/**
 * A fenced block: a page block, a box, the page's CSS, or a plain code block.
 * The comments block is dropped; it is the comment layer's.
 */
function fenced(source, info, bodyLines, where) {
  const word = (/^([A-Za-z][\w-]*)/.exec(info) ?? [, ""])[1].toLowerCase();
  const rest = info.slice(word.length).trim();
  const body = source.slice(where.bodyFrom, where.bodyTo);
  if (word === "comments") return null;
  if (word === "css") return { type: "css", text: body, ...where };
  if (word === "box") {
    const height = /(?:^|\s)height=(\d{2,4})(?:\s|$)/.exec(rest);
    return { type: "box", html: body, height: height ? Math.min(2000, Math.max(80, Number(height[1]))) : null, ...where };
  }
  if (!Object.hasOwn(BLOCK_KINDS, word)) return { type: "code", lang: word, text: body, ...where };

  const items = [];
  const settings = {};
  const problems = [];
  const words = [];
  for (const line of bodyLines) {
    if (line.text.trim() === "") continue;
    const item = /^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+(.*)$/.exec(line.text);
    if (item) {
      items.push(blockItem(source, line.to - item[1].length, line.to, line));
      continue;
    }
    // Indented `key: value` lines under an item are that item's fields (`photo:`, `seats:`, a fact).
    const last = items[items.length - 1];
    if (last && /^[ \t]{2,}\S/.test(line.text)) {
      const fields = itemFields(source, line);
      if (fields) {
        last.fields.push(...fields);
        last.to = line.to;
        continue;
      }
    }
    const setting = /^[ \t]*([a-z][a-z _-]{0,24}):[ \t]*(.*?)[ \t]*$/i.exec(line.text);
    if (setting) {
      const valueFrom = line.to - (line.text.length - line.text.lastIndexOf(setting[2]));
      const key = setting[1].trim().toLowerCase().replace(/[ -]/g, "_");
      settings[key] = { value: setting[2], from: setting[2] === "" ? line.to : valueFrom, to: setting[2] === "" ? line.to : valueFrom + setting[2].length, lineFrom: line.from, lineTo: line.to };
      continue;
    }
    // A kind that takes words (a vote's reason) keeps plain lines written before its items.
    if (BLOCK_KINDS[word].words && items.length === 0) {
      const from = line.from + (line.text.length - line.text.trimStart().length);
      words.push(...(words.length ? [{ text: " ", from, to: from, editable: false, anchors: [] }] : []), ...inlineRuns(source, from, line.to));
      continue;
    }
    problems.push({ message: `"${line.text.trim().slice(0, 40)}" is not an item ("- ..."), a setting ("key: value") or, indented under an item, one of its fields.` });
  }
  const block = { type: "block", kind: word, title: rest, items, settings, words, problems, ...where };
  for (const message of checkBlock(block)) problems.push({ message });
  return block;
}

/**
 * One `- ` line of a block: its `|`-separated parts, and the first part split
 * at its first `: ` into a label and a value when it has one. Each part keeps
 * its range and its runs, so every word in it can be edited.
 */
function blockItem(source, from, to, line) {
  const parts = [];
  let start = from;
  for (let k = from; k <= to; k++) {
    if (source[k] === "\\") {
      k++;
      continue;
    }
    if (k === to || source[k] === "|") {
      let a = start;
      let b = k;
      while (a < b && /\s/.test(source[a])) a++;
      while (b > a && /\s/.test(source[b - 1])) b--;
      parts.push({ from: a, to: b });
      start = k + 1;
    }
  }
  const first = parts[0];
  let label = null;
  const colon = labelEnd(source, first.from, first.to);
  if (colon !== -1) {
    label = { from: first.from, to: colon };
    let v = colon + 1;
    while (v < first.to && /\s/.test(source[v])) v++;
    parts[0] = { from: v, to: first.to };
  }
  const read = (part) => ({ ...part, text: source.slice(part.from, part.to), runs: inlineRuns(source, part.from, part.to) });
  return { label: label ? read(label) : null, parts: parts.map(read), fields: [], from: line.from, to: line.to };
}

/** A field's name as written ("On the L") and as looked up ("on_the_l"). */
const FIELD = /^([A-Za-z0-9][^:;|]{0,30}?):[ \t]+(\S.*)$/;

/**
 * One indented line of fields: `seats: 300-500`, or several facts on one line
 * split at `; ` (`kitchen: yes; on the L: no`). Null when the line is not
 * fields at all, so the caller can say so.
 */
function itemFields(source, line) {
  const start = line.from + (line.text.length - line.text.trimStart().length);
  const text = source.slice(start, line.to).replace(/\s+$/, "");
  const segments = [];
  const splitter = /;[ \t]+(?=[A-Za-z0-9][^:;|]{0,30}?:[ \t])/g;
  let at = 0;
  for (const m of text.matchAll(splitter)) {
    segments.push([at, m.index]);
    at = m.index + m[0].length;
  }
  segments.push([at, text.length]);
  const fields = [];
  for (const [a, b] of segments) {
    const m = FIELD.exec(text.slice(a, b));
    if (!m) return null;
    const keyFrom = start + a;
    const valueFrom = keyFrom + m[0].length - m[2].length;
    const valueTo = start + b;
    fields.push({
      name: m[1].trim(),
      key: m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      value: { from: valueFrom, to: valueTo, text: source.slice(valueFrom, valueTo), runs: inlineRuns(source, valueFrom, valueTo) },
      line: { from: line.from, to: line.to, alone: segments.length === 1 },
    });
  }
  return fields;
}

/** Where a label ends: the first unescaped `:` followed by a space, outside a link or code. */
function labelEnd(source, from, to) {
  let depth = 0;
  for (let k = from; k < to; k++) {
    const ch = source[k];
    if (ch === "\\") {
      k++;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "`") depth += ch === "`" ? (depth % 2 === 0 ? 1 : -1) : 1;
    if ((ch === "]" || ch === ")") && depth > 0) depth--;
    if (ch === ":" && depth === 0 && /\s/.test(source[k + 1] ?? "") && k > from) return k;
  }
  return -1;
}

module.exports = { PAGE_SUFFIX, isPagePath, parsePage, frontMatter };
