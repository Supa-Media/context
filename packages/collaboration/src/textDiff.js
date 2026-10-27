/**
 * A text diff whose cost is bounded, whatever the two texts are.
 *
 * jsdiff's character diff is Myers' algorithm: cheap when the edit is small,
 * roughly quadratic in the size of the edit when it is not. An agent that
 * rewrites a whole note (new numbers, new tables) is the large case: a
 * 20,000-character rewrite took 18 s, and one replacement runs the diff up to
 * three times (`replay.js` twice, `replace.js` once). On 2026-10-24 that was
 * every save of a long finance note timing out from the texting assistant,
 * while a short new note saved at once.
 *
 * So each tier gives up past a fixed edit length rather than a deadline (a
 * Worker's clock does not move while it computes): characters first, which
 * is what every ordinary edit is; then lines, which is what a rewrite is;
 * then the changed middle swapped whole. Any tier's parts spell `before`
 * without the added parts and `after` without the removed ones, so the
 * document ends exactly where the writer asked. Only how finely a concurrent
 * peer's typing is merged around a rewrite changes, and Yjs keeps a peer's
 * insertion inside a deleted range either way.
 *
 * That last sentence is about text. `replay.js` does not build text from a
 * diff: it reads the diff's shape to decide whether a replacement may be
 * rebased onto the current document, and a coarser tier reports text as
 * rewritten that the writer in fact kept. Which tier made the parts is
 * therefore part of the answer, and `replay.js` asks for the granularity
 * each decision needs (`diffTextDetail`).
 */

import { diffChars, diffLines } from "diff";

/** Past this many character edits, a diff is a rewrite and goes by lines (about 0.1 s). */
export const CHAR_EDIT_LIMIT = 1_000;
/** Past this many line edits, the changed middle is swapped whole. */
export const LINE_EDIT_LIMIT = 2_000;

/**
 * jsdiff-shaped parts, and the tier that made them: `"chars"`, `"lines"` or
 * `"middle"`.
 *
 * The tier is how finely an unchanged part can be trusted. At `"chars"` an
 * unchanged part is exactly the text the writer kept. At `"lines"` a line the
 * writer touched at all reads as rewritten whole, so a run inside it does not
 * show as kept. At `"middle"` everything between the common ends reads as
 * rewritten.
 *
 * @returns {{ parts: Array<{ value: string, added?: boolean, removed?: boolean }>, tier: "chars" | "lines" | "middle" }}
 */
export function diffTextDetail(before, after) {
  const chars = diffChars(before, after, { maxEditLength: CHAR_EDIT_LIMIT });
  if (chars) return { parts: chars, tier: "chars" };
  const lines = diffLines(before, after, { maxEditLength: LINE_EDIT_LIMIT });
  if (lines) return { parts: lines, tier: "lines" };
  return { parts: swapMiddle(before, after), tier: "middle" };
}

/** jsdiff-shaped parts (`{ value, added?, removed? }`) turning `before` into `after`. */
export function diffText(before, after) {
  return diffTextDetail(before, after).parts;
}

/** Keep the common start and end, replace everything between them. */
function swapMiddle(before, after) {
  const most = Math.min(before.length, after.length);
  let start = 0;
  while (start < most && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let end = 0;
  while (end < most - start && before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)) end += 1;
  const parts = [];
  if (start > 0) parts.push({ value: before.slice(0, start) });
  if (before.length - end > start) parts.push({ value: before.slice(start, before.length - end), removed: true });
  if (after.length - end > start) parts.push({ value: after.slice(start, after.length - end), added: true });
  if (end > 0) parts.push({ value: before.slice(before.length - end) });
  return parts;
}
