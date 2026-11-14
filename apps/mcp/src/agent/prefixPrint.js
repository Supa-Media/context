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

/** Lines per fingerprinted chunk of the first history message, and the most chunks one line carries. */
export const CHUNK_LINES = 20;
export const MAX_CHUNKS = 60;

const textOf = (message) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n") : "");

function chunksOf(message) {
  if (!message) return [];
  const lines = textOf(message).split("\n");
  const out = [];
  for (let at = 0; at < lines.length && out.length < MAX_CHUNKS; at += CHUNK_LINES) out.push(fingerprint(lines.slice(at, at + CHUNK_LINES).join("\n")));
  return out;
}

const unmarked = (value) => JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));

/**
 * `{tools, systemParts, history, toolPrints, firstChunks, historyBlocks, blocks, more}` for a body laid out with a history
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
    // Each tool as [fingerprint of its name, of its whole definition], so a changed list names the tool by matching its name's fingerprint against the code's tool names.
    toolPrints: (body.tools ?? []).map((tool) => [fingerprint(String(tool?.name ?? "")), fingerprint(unmarked(tool))]),
    // The first history message (a transcript of the chat's day) in chunks of `CHUNK_LINES` lines, so a changed transcript names where it changed.
    firstChunks: chunksOf(history[0]),
    historyBlocks: history.reduce((sum, message) => sum + blocksOf(message), 0),
    blocks: messages.slice(historyEnd).reduce((sum, message) => sum + blocksOf(message), 0),
    ...(history.length > MAX_HISTORY_PRINTS ? { more: history.length - MAX_HISTORY_PRINTS } : {}),
  };
}
