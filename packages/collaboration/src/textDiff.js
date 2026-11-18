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
 *
 * Giving up is itself not free. jsdiff walks every edit length up to the
 * limit before it says no, about half a million steps with an object made at
 * each: 66 ms on a laptop, and a save runs the diff twice. In production on
 * 2026-11-18 a plain `write` of a collaborative note waited a median 662 ms on
 * the workspace object for exactly that (`obj:ws.collab.replace`, with the
 * object's own clock reading 0, since a clock there does not move while it
 * computes), where a `remember`, which adds one line, waited 220 ms. So the
 * rewrite is recognised first by `editsExceed`, the same search over two
 * integer arrays with nothing built, and jsdiff runs only when it will
 * answer. And one save asks for each diff once (`rememberedDiffs`).
 */

import { diffChars, diffLines } from "diff";

/** Past this many character edits, a diff is a rewrite and goes by lines (about 0.1 s). */
export const CHAR_EDIT_LIMIT = 1_000;
/** Past this many line edits, the changed middle is swapped whole. */
export const LINE_EDIT_LIMIT = 2_000;

/**
 * How many diffs were asked for, and how many ran jsdiff's character search. Counts only, for the tests that hold
 * a save to one diff and a rewrite to none of the search (`test/textDiff.mjs`); nothing reads them to decide.
 */
export const diffCounts = { detail: 0, charSearches: 0 };

function charDiff(before, after) {
  diffCounts.charSearches += 1;
  return diffChars(before, after, { maxEditLength: CHAR_EDIT_LIMIT });
}

/** A text as jsdiff's character diff reads it: one token per code point (`Array.from`), never per UTF-16 unit. */
function codePoints(text) {
  const points = new Int32Array(text.length);
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const point = text.codePointAt(index);
    points[count] = point;
    count += 1;
    if (point > 0xffff) index += 1;
  }
  return points.subarray(0, count);
}

const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * How many UTF-16 units the two texts share at the start and, of the rest, at the end: `[head, tail]`. Each stops
 * short of splitting a surrogate pair, so what is left of each text reads as the same code points it did whole.
 */
function sharedEnds(before, after) {
  const most = Math.min(before.length, after.length);
  let head = 0;
  while (head < most && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
  // A shared high half may be the start of two different characters.
  if (head > 0 && isHigh(before.charCodeAt(head - 1))) head -= 1;
  let tail = 0;
  while (tail < most - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail += 1;
  // A shared low half may be the end of two different characters.
  if (tail > 0 && isLow(before.charCodeAt(before.length - tail))) tail -= 1;
  return [head, tail];
}

/**
 * Whether turning `before` into `after` takes more than `limit` character edits (insertions plus deletions), which
 * is exactly when `diffChars(before, after, { maxEditLength: limit })` answers nothing.
 *
 * Myers' search, as jsdiff runs it, keeping only how far each diagonal reaches: `reach[k]` is the furthest position
 * in `before` on diagonal `k` (position in `before` minus position in `after`) after the edits so far, or -1 where
 * no path inside the two texts gets there. It stops at the first edit count that reaches both ends.
 */
export function editsExceed(before, after, limit) {
  // What the two texts share at each end costs no edit and changes no count, so only the middles are searched: a
  // long note with one changed paragraph is two short arrays, not two of the note's length.
  const [head, tail] = sharedEnds(before, after);
  const a = codePoints(before.slice(head, before.length - tail));
  const b = codePoints(after.slice(head, after.length - tail));
  const n = a.length;
  const m = b.length;
  // jsdiff caps the limit at the two lengths together: every text is reachable within that many edits.
  const most = Math.min(limit, n + m);
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start += 1;
  if (start === n && start === m) return false;
  const width = 2 * most + 3;
  const offset = most + 1;
  const reach = new Int32Array(width).fill(-1);
  reach[offset] = start;
  for (let edits = 1; edits <= most; edits += 1) {
    for (let k = -edits; k <= edits; k += 2) {
      // From the diagonal above by one more character of `after`, or from the one below by dropping one of `before`.
      const above = reach[offset + k + 1];
      const below = reach[offset + k - 1];
      const inserted = above >= 0 && above - k <= m ? above : -1;
      const removed = below >= 0 && below + 1 <= n ? below + 1 : -1;
      let x = inserted > removed ? inserted : removed;
      if (x < 0) {
        reach[offset + k] = -1;
        continue;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      if (x === n && y === m) return false;
      reach[offset + k] = x;
    }
  }
  return true;
}

/**
 * `diffTextDetail` that answers the same two texts once. One replacement asks for a diff, decides from its shape
 * (`replay.js`) and then asks for the same diff again to make the edit (`replace.js`): the second ask is the first
 * one's answer. Made per replacement and dropped with it, so no text is kept past the save that brought it.
 *
 * @returns {(before: string, after: string) => ReturnType<typeof diffTextDetail>}
 */
export function rememberedDiffs() {
  const kept = [];
  return (before, after) => {
    const held = kept.find((entry) => entry.before === before && entry.after === after);
    if (held) return held.detail;
    const detail = diffTextDetail(before, after);
    kept.push({ before, after, detail });
    return detail;
  };
}

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
  diffCounts.detail += 1;
  // Past the limit jsdiff answers nothing, after the whole search: the same answer, asked the cheap way first.
  const chars = editsExceed(before, after, CHAR_EDIT_LIMIT) ? undefined : charDiff(before, after);
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
