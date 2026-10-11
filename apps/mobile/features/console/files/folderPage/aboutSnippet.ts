/**
 * What a folder page shows of its about note under the title: a subtitle,
 * not the note (the owner, 2026-10-09, from the folder-about redesign boards:
 * "I hate how the about.md looks… sometimes about will be long, sometimes
 * short").
 *
 * - An about that opens with a paragraph shows that paragraph, as plain
 *   words (`noteLede`): no headings, code chips or bold at note size.
 * - One that opens with a list shows its first items joined with " · ".
 * - One with only headings shows the first heading as words.
 *
 * `more` says whether anything was left out, which is when the page offers
 * Read more. Whether the words themselves are cut by the line limit is the
 * page's to judge, since only it knows its width.
 */

import { findLede } from "../../../../../mcp/src/lists/lede.js";
import { noteLede } from "./lede";
import { panelText } from "./panel/panelModel";

export interface AboutSnippet {
  /** The words drawn under the title; "" when the about holds nothing that reads as words (only a table, say). */
  readonly text: string;
  /** Where the words came from: only a paragraph is edited in place, the rest in the whole note. */
  readonly kind: "paragraph" | "list" | "heading" | "other";
  /** Whether the about holds more than these words. */
  readonly more: boolean;
}

/** How many of an opening list's items are joined into the line. */
const ITEMS = 4;

const ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)[\s#]*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Null for an about with nothing in it: no frontmatter-only note draws a line. */
export function aboutSnippet(note: string, title: string): AboutSnippet | null {
  const body = panelText(typeof note === "string" ? note.replace(/^\uFEFF/, "") : "", title);
  const lines = body.split(/\r?\n/);
  // Lines outside fenced blocks that hold anything; a fence's lines count once, as the fence.
  const shown: { line: string; index: number; fenced: boolean }[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = FENCE.exec(line);
    if (marker !== null) {
      if (fence === null) {
        fence = marker[1]![0]!;
        shown.push({ line, index, fenced: true });
      } else if (marker[1]![0] === fence) fence = null;
      return;
    }
    if (fence !== null || line.trim() === "") return;
    shown.push({ line, index, fenced: false });
  });
  if (shown.length === 0) return null;

  const lede = noteLede(body);
  const found = lede === null ? null : findLede(lines);
  if (lede !== null && found !== null) {
    // A heading above the paragraph is the note's title, not more to read.
    const rest = shown.filter(({ line, index, fenced }) =>
      index < found.start ? fenced || !HEADING.test(line) : index >= found.end,
    );
    return { text: lede, kind: "paragraph", more: rest.length > 0 || lede.endsWith("…") };
  }

  const items = shown.filter(({ line, fenced }) => !fenced && ITEM.test(line));
  if (items.length > 0 && shown.indexOf(items[0]!) <= firstContent(shown)) {
    const taken = items.slice(0, ITEMS).map(({ line }) => words(ITEM.exec(line)![1]!)).filter((item) => item !== "");
    if (taken.length > 0) {
      const more = shown.length > taken.length;
      return { text: taken.join(" · ") + (more ? "…" : ""), kind: "list", more };
    }
  }

  const heading = shown.find(({ line, fenced }) => !fenced && HEADING.test(line));
  if (heading !== undefined) {
    const text = words(HEADING.exec(heading.line)![1]!);
    if (text !== "") return { text, kind: "heading", more: shown.length > 1 };
  }
  return { text: "", kind: "other", more: true };
}

/** The index in `shown` of the first line that is not a heading: a list after its own heading still opens the about. */
function firstContent(shown: readonly { line: string; fenced: boolean }[]): number {
  const at = shown.findIndex(({ line, fenced }) => fenced || !HEADING.test(line));
  return at === -1 ? 0 : at;
}

/** A line's words without its marks, as the paragraph's are. */
function words(text: string): string {
  return noteLede(text.trim()) ?? text.replace(/[*_`]/g, "").trim();
}
