/**
 * A note's parts: its headings, one section, a range of lines.
 *
 * `fetch` used to hand back every note whole, so an agent that wanted one
 * heading of a 270 KB day of email paid about 67,000 tokens for it (decided by
 * the owner, 2026-11-23; `docs/decisions/gateway-protocol/section-reads.md`).
 * This module only cuts text. Who may read the note is decided before any of
 * it runs, by `toolReadNote`, and nothing here touches storage.
 *
 * What counts as a heading is what a Markdown reader would draw as one, minus
 * the text Context itself keeps inside a note:
 *
 *  - ATX (`## Plan`) and setext (`Plan` over `===` or `---`) headings;
 *  - never inside a code fence (``` or ~~~), an HTML comment, front matter, or
 *    a captured message's untrusted fence (`<!-- context:untrusted-communication begin … -->`);
 *  - a note's machine blocks (the ```comments and ```mail fences at its end)
 *    belong to no section, so replacing a section can never take a thread or a
 *    mail record with it.
 */

import { FENCE_MARKER } from "../../../../packages/communications/src/note.js";

/** One section, line range or outline answer is at most this many characters. */
export const PART_CHARS = 32_000;

/** A single line longer than this is cut and marked, so a range never returns one 200 KB line. */
export const LINE_CHARS = 2_000;

/** At most this many headings are named in a refusal. */
const CANDIDATES_LISTED = 20;

const COMMS_BEGIN = `<!-- ${FENCE_MARKER} begin `;
const COMMS_END = `<!-- ${FENCE_MARKER} end `;
const MACHINE_INFO = new Set(["comments", "mail"]);

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_ONE = /^ {0,3}=+[ \t]*$/;
const SETEXT_TWO = /^ {0,3}-+[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const MESSAGE_ANCHOR = /\{#(msg-[0-9a-f]+)\}\s*$/;

/**
 * The structure of a note: its lines, its headings and where its machine blocks
 * start. Lines are 1-based, counted on the text exactly as given.
 *
 * @returns {{ lines: string[], headings: Array<{ line: number, level: number, text: string, key: string, anchor: string|null }>,
 *   frontMatter: { start: number, end: number } | null, machineStart: number | null }}
 */
export function noteStructure(text) {
  const lines = String(text ?? "").split("\n");
  const headings = [];
  let frontMatter = null;
  let machineStart = null;
  let fence = null;
  let inComment = false;
  let inComms = false;
  let index = 0;
  if (lines[0] === "---") {
    const close = lines.findIndex((line, at) => at > 0 && (line === "---" || line === "..."));
    if (close > 0) {
      frontMatter = { start: 1, end: close + 1 };
      index = close + 1;
    }
  }
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (inComms) {
      if (line.startsWith(COMMS_END)) inComms = false;
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.startsWith(COMMS_BEGIN)) {
      inComms = true;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], size: open[1].length };
      const info = open[2].trim().split(/\s+/)[0];
      if (machineStart === null && MACHINE_INFO.has(info)) machineStart = index + 1;
      continue;
    }
    const opened = line.lastIndexOf("<!--");
    if (opened !== -1 && !line.includes("-->", opened)) {
      inComment = true;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      headings.push(heading(index + 1, atx[1].length, atx[2] ?? ""));
      continue;
    }
    // Setext: a paragraph line, then a line of = or -. A `---` after a blank line is a rule, not a heading.
    const next = lines[index + 1];
    if (next !== undefined && line.trim() !== "" && !startsBlock(line) && (SETEXT_ONE.test(next) || SETEXT_TWO.test(next))) {
      headings.push(heading(index + 1, SETEXT_ONE.test(next) ? 1 : 2, line));
      index++;
    }
  }
  // A machine block before the last heading would be odd; a section still never runs into one.
  return { lines, headings, frontMatter, machineStart };
}

function closesFence(line, fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.size);
}

function startsBlock(line) {
  return /^ {0,3}(?:[-*+]\s|\d+[.)]\s|>|\||<)/.test(line);
}

function heading(line, level, raw) {
  const anchor = MESSAGE_ANCHOR.exec(raw)?.[1] ?? null;
  const text = raw.replace(MESSAGE_ANCHOR, "").trim();
  return { line, level, text, key: headingKey(text), anchor };
}

/**
 * A heading as compared: its rendered words, folded. Link syntax, emphasis,
 * code ticks, emoji and a leading number (`1.`, `2)`) are dropped, so an agent
 * that writes the heading as it reads on screen finds it.
 */
export function headingKey(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/\{#[^}]*\}\s*$/, "")
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The last line (1-based, inclusive) of the section a heading opens. */
function sectionEnd(structure, at) {
  const { headings, lines, machineStart } = structure;
  const own = headings[at];
  let end = lines.length;
  for (let next = at + 1; next < headings.length; next++) {
    if (headings[next].level <= own.level) {
      end = headings[next].line - 1;
      break;
    }
  }
  if (machineStart !== null && machineStart > own.line && machineStart - 1 < end) end = machineStart - 1;
  // A trailing blank line belongs to the gap, not the section.
  while (end > own.line && lines[end - 1].trim() === "") end--;
  return end;
}

/**
 * Split a heading path as an agent writes it: `Plan > Risks` (a literal `>` as `\>`).
 * A number, or a string of digits, is a heading's line.
 */
export function parseSectionQuery(query) {
  if (typeof query === "number") return Number.isInteger(query) && query > 0 ? { line: query } : { error: "section as a number is a heading's line: 1 or more" };
  if (typeof query !== "string" || query.trim() === "") return { error: "section names a heading, like \"Decisions\" or \"Plan > Risks\", or a heading's line number" };
  const trimmed = query.trim();
  if (/^L?\d+$/i.test(trimmed)) return { line: Number(trimmed.replace(/^L/i, "")) };
  const segments = trimmed
    .split(/(?<!\\)>/)
    .map((segment) => segment.replace(/\\>/g, ">").trim())
    .filter((segment) => segment !== "");
  if (!segments.length) return { error: "section names a heading, like \"Decisions\" or \"Plan > Risks\"" };
  return { segments };
}

/**
 * The section a query names.
 *
 * @returns {{ start: number, end: number, heading: object } | { error: string }}
 */
export function findSection(structure, query) {
  const parsed = parseSectionQuery(query);
  if (parsed.error) return { error: parsed.error };
  const { headings } = structure;
  if (parsed.line !== undefined) {
    const at = headings.findIndex((entry) => entry.line === parsed.line);
    if (at === -1) return { error: `no heading starts at line ${parsed.line}. ${headingList(headings)}` };
    return { start: headings[at].line, end: sectionEnd(structure, at), heading: headings[at] };
  }
  const wanted = parsed.segments.map((segment) => (/^msg-[0-9a-f]+$/.test(segment) ? { anchor: segment } : { key: headingKey(segment) }));
  const matches = [];
  for (let at = 0; at < headings.length; at++) {
    if (!matchesSegment(headings[at], wanted[wanted.length - 1])) continue;
    if (ancestorsMatch(headings, at, wanted.slice(0, -1))) matches.push(at);
  }
  if (matches.length === 1) {
    const at = matches[0];
    return { start: headings[at].line, end: sectionEnd(structure, at), heading: headings[at] };
  }
  const named = parsed.segments.join(" > ");
  if (matches.length === 0) return { error: `no heading "${clip(named)}" in this note. ${headingList(headings)}` };
  return {
    error:
      `${matches.length} headings match "${clip(named)}": ${matches.slice(0, CANDIDATES_LISTED).map((at) => `line ${headings[at].line} ${"#".repeat(headings[at].level)} ${clip(headings[at].text)}`).join("; ")}. ` +
      "Name one by its line, as section: <line>, or by its path, as \"Parent > Heading\".",
  };
}

function matchesSegment(entry, segment) {
  return segment.anchor !== undefined ? entry.anchor === segment.anchor : entry.key === segment.key;
}

/** Whether `wanted` (outermost first) are ancestors of headings[at], in order, not necessarily adjacent. */
function ancestorsMatch(headings, at, wanted) {
  let need = wanted.length - 1;
  let level = headings[at].level;
  for (let up = at - 1; up >= 0 && need >= 0; up--) {
    if (headings[up].level >= level) continue;
    level = headings[up].level;
    if (matchesSegment(headings[up], wanted[need])) need--;
  }
  return need < 0;
}

function headingList(headings) {
  if (!headings.length) return "It has no headings: read it with lines, as lines: \"1-200\".";
  const listed = headings.slice(0, CANDIDATES_LISTED).map((entry) => `line ${entry.line} ${"#".repeat(entry.level)} ${clip(entry.text)}`);
  const more = headings.length > CANDIDATES_LISTED ? `; and ${headings.length - CANDIDATES_LISTED} more (outline: true lists them)` : "";
  return `Its headings: ${listed.join("; ")}${more}.`;
}

function clip(text) {
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * `lines: "120-180"`, `"412-"`, `"120"`, or `{ start, end }`, clamped to the note.
 *
 * @returns {{ start: number, end: number } | { error: string }}
 */
export function parseLines(spec, total) {
  let start;
  let end;
  if (typeof spec === "number" && Number.isInteger(spec)) {
    start = spec;
    end = spec;
  } else if (typeof spec === "string" && /^\s*\d+\s*(?:-\s*\d*\s*)?$/.test(spec)) {
    const [from, to] = spec.split("-").map((part) => part.trim());
    start = Number(from);
    end = to === undefined ? start : to === "" ? total : Number(to);
  } else if (spec && typeof spec === "object" && Number.isInteger(spec.start)) {
    start = spec.start;
    end = Number.isInteger(spec.end) ? spec.end : total;
  } else {
    return { error: "lines is a range of line numbers, like \"120-180\", or \"412-\" to read to the end" };
  }
  if (start < 1) return { error: "lines start at 1" };
  if (start > total) return { error: `this note has ${total} lines; lines starts past its end` };
  if (end < start) return { error: "lines ends before it starts: write the smaller number first, like \"120-180\"" };
  return { start, end: Math.min(end, total) };
}

/**
 * Lines `start..end` as text, at most `PART_CHARS`, ending at a whole line. A
 * line over `LINE_CHARS` is cut and marked. `next` is the first line not
 * returned, or null when the range was returned whole.
 */
export function sliceLines(lines, start, end, budget = PART_CHARS) {
  const out = [];
  let used = 0;
  let line = start;
  for (; line <= end; line++) {
    let text = lines[line - 1];
    if (text.length > LINE_CHARS) text = `${text.slice(0, LINE_CHARS)} …[line ${line} cut at ${LINE_CHARS} of ${text.length} characters]`;
    const cost = text.length + 1;
    if (out.length > 0 && used + cost > budget) break;
    out.push(text);
    used += cost;
  }
  const last = line - 1;
  return { text: out.join("\n"), start, end: last, next: last < end ? last + 1 : null };
}

/** About how many tokens `chars` characters of Markdown are: shown with "~", never billed. */
export function approxTokens(chars) {
  return Math.max(1, Math.round(chars / 4));
}

function sizeLabel(chars) {
  const tokens = approxTokens(chars);
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}

/**
 * The outline: one line per heading at the note's shallowest `depth` levels,
 * with its line range, size and how many headings sit under it. Deeper
 * headings are counted, not listed, so a day of 300 messages is a few lines.
 */
export function renderOutline(structure, { depth = 2 } = {}) {
  const { headings, lines, frontMatter } = structure;
  const out = [];
  if (frontMatter) out.push(`L${frontMatter.start}-${frontMatter.end} front matter`);
  if (!headings.length) {
    out.push(`(no headings; ${lines.length} lines, ${sizeLabel(charsOf(lines, 1, lines.length))})`);
    return out.join("\n");
  }
  const top = Math.min(...headings.map((entry) => entry.level));
  const deepest = top + Math.max(1, Math.min(6, Number.isInteger(depth) ? depth : 2)) - 1;
  const first = (frontMatter?.end ?? 0) + 1;
  if (headings[0].line > first && lines.slice(first - 1, headings[0].line - 1).some((line) => line.trim() !== "")) {
    out.push(`L${first}-${headings[0].line - 1} (before the first heading, ${sizeLabel(charsOf(lines, first, headings[0].line - 1))})`);
  }
  for (let at = 0; at < headings.length; at++) {
    const entry = headings[at];
    if (entry.level > deepest) continue;
    const end = sectionEnd(structure, at);
    let under = 0;
    for (let next = at + 1; next < headings.length && headings[next].line <= end; next++) if (headings[next].level > deepest) under++;
    const indent = "  ".repeat(entry.level - top);
    const hidden = under > 0 ? `, ${under} heading${under === 1 ? "" : "s"} under it` : "";
    out.push(`${indent}L${entry.line}-${end} ${"#".repeat(entry.level)} ${clip(entry.text)} (${sizeLabel(charsOf(lines, entry.line, end))}${hidden})`);
  }
  return out.join("\n");
}

function charsOf(lines, start, end) {
  let total = 0;
  for (let line = start; line <= end && line <= lines.length; line++) total += lines[line - 1].length + 1;
  return total;
}
