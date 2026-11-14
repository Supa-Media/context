/**
 * WHERE A TEXTED TURN'S CACHED PREFIX STOPPED MATCHING (Dev2, 2026-11-14: "lets
 * just look into the cache misses"). Production's first rounds rewrote 30-60K
 * of a ~95K prompt to the cache even on texts seconds apart, and the usage
 * counts alone cannot say whether the tools, the system prompt, a context
 * module or the history changed.
 *
 * The body a round was sent, as fingerprints of each piece in the order the
 * API caches them: the tool list, each system block, and each history message
 * up to the history's breakpoint (`aiGateway.js` `gatewayBody`). Cache marks
 * are left out, since a mark moves to the newest history while the bytes before
 * it stay. Two consecutive texts of one chat line up piece by piece, and the
 * first fingerprint that differs is what made the miss. Fingerprints and counts
 * only, never a word (`promptManifest.js` `fingerprint`).
 */

import { fingerprint } from "./promptManifest.js";

/** The most history fingerprints one line carries; a longer history keeps its first ones, where a miss starts. */
export const MAX_HISTORY_PRINTS = 80;

const unmarked = (value) => JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));

/**
 * `{tools, systemParts, history, historyBlocks, blocks, more}` for a body laid out with a history
 * breakpoint, or null without one. `historyEnd` is how many wire messages the
 * history is; `blocks` counts the content blocks from the history's end to the
 * body's end (the API looks back about 20 blocks from a breakpoint for an
 * earlier entry).
 */
export function prefixPrint(body, historyEnd) {
  if (!body || !Array.isArray(body.messages) || !Number.isInteger(historyEnd) || historyEnd < 0) return null;
  const messages = body.messages;
  const history = messages.slice(0, historyEnd);
  const blocksOf = (message) => (Array.isArray(message?.content) ? message.content.length : 1);
  return {
    tools: fingerprint(unmarked(body.tools ?? [])),
    systemParts: (Array.isArray(body.system) ? body.system : []).map((block) => fingerprint(unmarked(block))),
    history: history.slice(0, MAX_HISTORY_PRINTS).map((message) => fingerprint(unmarked(message))),
    historyBlocks: history.reduce((sum, message) => sum + blocksOf(message), 0),
    blocks: messages.slice(historyEnd).reduce((sum, message) => sum + blocksOf(message), 0),
    ...(history.length > MAX_HISTORY_PRINTS ? { more: history.length - MAX_HISTORY_PRINTS } : {}),
  };
}
