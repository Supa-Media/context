/**
 * Two small helpers left from the chaos line a write's answer used to end with.
 *
 * Every write, move and archive answered with the score before and after from 2026-10-10. On 2026-11-03 a
 * benchmark showed that wait was most of every save (2.3 s median, 3.5 s p95: the rescore reads the whole tree and
 * its facts), and the owner chose, on a decision card, to drop the line from writes: `orient` alone reports the
 * score (`docs/decisions/chaos-score.md`). What stays here is used elsewhere: `within` bounds orient's waits, and
 * `withChaosLines` adds a line to an answer's text (note mail's footer).
 */

/** How long `within` waits when it is not told. */
export const WAIT_MS = 3000;

/** Wait at most `ms` for `promise`, answering null after that or on failure. */
export async function within(promise, ms = WAIT_MS) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise).catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** `result` with `text` added to its first text block, or unchanged. */
export function withChaosLines(result, text) {
  if (!text || !result || result.isError || !Array.isArray(result.content)) return result;
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const content = [{ ...first, text: `${first.text}\n${text}` }, ...result.content.slice(1)];
  const next = { ...result, content };
  // Keep whatever the handler hid on the result (`live/activityHint.js`).
  for (const symbol of Object.getOwnPropertySymbols(result)) {
    Object.defineProperty(next, symbol, { value: result[symbol], enumerable: false });
  }
  return next;
}
