/**
 * Rung 2 of the lookup ladder, `rungNotes` ("Their notes"; `../../lookupLadder.js`, on the node shelf): before Tex asks
 * them a fact, search their notes for it with the same search the front door calls (`t.toolCalls.mcp`, so the same
 * grant and the same workspaces).
 *
 * Input: the query (their text and the draft's question) and the words to look for. Output: `{ found: lines, query,
 * ms }`, the result lines holding at least two of the words (one when there is only one), since a search returns
 * whole notes and one shared word ("email", "address") matched unrelated lines; `found: []` when the search found nothing, failed, or was not back in time.
 * No model, never throws.
 */
import { linesWith } from "../../lookupLadder.js";

/** The longest it waits on the search. */
export const NOTES_MS = 2_500;

const textOf = (result) => (typeof result === "string" ? result : typeof result?.text === "string" ? result.text : Array.isArray(result?.content) ? result.content.map((c) => c?.text ?? "").join("\n") : "");

export async function rungNotesNode(input, io) {
  const t = io?.ctx?.turn ?? {};
  const query = String(input?.query ?? "").trim();
  const terms = Array.isArray(input?.terms) ? input.terms : [];
  const call = t?.toolCalls?.mcp;
  if (query === "" || typeof call !== "function") return { found: [], why: query === "" ? "no query" : "no search here", ms: 0 };
  const started = Date.now();
  let timer;
  const result = await Promise.race([
    Promise.resolve().then(() => call("search", { query })).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), NOTES_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const failed = result === null || result?.isError === true || result?.ok === false;
  return { found: failed ? [] : linesWith(textOf(result), terms, { need: Math.min(2, terms.length) }), query, ms: Date.now() - started, ...(failed ? { why: result === null ? "search not back in time" : "search failed" } : {}) };
}
