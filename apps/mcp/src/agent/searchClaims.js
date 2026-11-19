/**
 * WHAT A REPLY MAY SAY A SEARCH COVERED (2026-11-19).
 *
 * On 2026-11-19 every search for a person's reading list named one workspace,
 * and a background job's answer still said "a search across all your
 * workspaces didn't turn one up": its one unscoped search had used other
 * words. A reply may claim only the searches its
 * tool calls show. `claimCheck.js` reads the answer with `claimsSearchedEverywhere`
 * and the calls with `searchedEverywhere`, and sends back `EVERYWHERE_NOTICE`
 * when the claim has no unscoped search under it.
 */

/** Search tools: the MCP name, and Tex's six-tool `search` that resolves to it (`sixTools.js`). */
const SEARCH_TOOLS = new Set(["search_notes", "search"]);

/** A search that named a workspace or a folder: `context` or `prefix`, at the top of the call or inside its `args`. */
function narrowed(args) {
  const inner = args?.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
  return [args?.context, args?.prefix, inner.context, inner.prefix].some((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

/** A search's result says it also looked in the workspaces the person reaches beyond the one it was asked of. */
function looksElsewhere(resultText) {
  return typeof resultText === "string" && resultText.includes("This search was asked of ") && resultText.includes("in the other workspaces they reach");
}

/** Whether a reply says it searched, looked or checked across all, every or each of the person's workspaces. Questions and offers do not count. */
const PAST_SEARCH = /\b(?:searched|looked (?:through|across|in|over)|checked|went through|scanned|combed)\b|\ba search (?:across|through|over|in|of)\b/i;
const EVERY_WORKSPACE = /\b(?:all|every|each)(?:\s+one)?(?:\s+of)?\s+(?:your|their|the|my|his|her)?\s*(?:[\w'’-]+\s+)?workspaces?\b|\beverywhere (?:you|they) (?:have|keep) notes\b/i;

/** @param {string} answer the reply text */
export function claimsSearchedEverywhere(answer) {
  if (typeof answer !== "string") return false;
  // Split on sentence ends; a sentence that ends in "?" asks or offers, and claims nothing.
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => !sentence.trimEnd().endsWith("?") && PAST_SEARCH.test(sentence) && EVERY_WORKSPACE.test(sentence));
}

/**
 * Whether one tool call covered every workspace the person reaches: a search
 * with no workspace or folder named, or one whose result says it looked elsewhere too.
 * @param {string} name the tool the call ran as
 * @param {object} args its arguments
 * @param {string} resultText the text of its result
 */
export function searchedEverywhere(name, args, resultText = "") {
  if (!SEARCH_TOOLS.has(name)) return false;
  return !narrowed(args) || looksElsewhere(resultText);
}

/** The notice sent back once, when a reply claims an every-workspace search no call of the turn made. */
export const EVERYWHERE_NOTICE =
  "You said you searched all their workspaces, but no search this turn did: each named one workspace or a folder. Run search_notes with no context and no prefix (it covers every workspace they reach), then say only what your tool results show.";
