/**
 * EVERY CHANGE ENDS WITH ONE LINE SAYING WHAT HAPPENED (the owner, 2026-10-28).
 *
 * An agent reading prose had to guess whether a change had landed: a
 * conflict, a refusal and a success were told apart by their wording, and a
 * client that misread one retried a change that had already been made, or
 * stopped at one that had not. So an MCP client's answer to any tool that
 * writes carries a second text block,
 *
 *   outcome: {"applied":true,"path":"…","visibility":"team","etag":"…"}
 *   outcome: {"applied":false,"error":"CONFLICT"}
 *
 * read off the answer the tool already gave, in one place, so no tool can
 * forget it. A second block rather than `structuredContent`: some clients
 * show only that field when it is present, and the prose (a conflict's text
 * to merge into) must reach the model whole. Only for MCP clients: Tex and
 * the other agents of ours read the first block, and pay for every word.
 */

import { toolIsWriting } from "../tools/registry.js";
import { v2ToolDefinitions } from "../tools/v2/schemas.js";

/** Whether the tool a client called by `name` (either era's) changes anything. */
function writes(name) {
  const v2 = v2ToolDefinitions().find((tool) => tool.name === name);
  return v2 ? v2.annotations?.readOnlyHint !== true : toolIsWriting(name);
}

/** Error codes, by how the refusal opens, first match wins. */
const ERROR_CODES = [
  [/^conflict\b/i, "CONFLICT"],
  [/^not found\b/i, "NOT_FOUND"],
  [/^permission denied\b/i, "FORBIDDEN"],
  [/^confirmation required\b/i, "CONFIRMATION_REQUIRED"],
  // The sharing judge, and an approval it waits for (`tools/session.js`).
  [/^Not done(?: yet)?: this would\b/, "NEEDS_PERSON"],
  [/^Held for their\b/, "NEEDS_PERSON"],
  [/^unknown tool\b/i, "UNKNOWN_TOOL"],
  [/^(?:invalid|unsupported)\b|\bmust (?:be|end|name)\b|\bis required\b|\bnot both\b|\bcannot be combined\b/i, "INVALID_ARGUMENT"],
  [/\b(?:right now|try again|safely)\b/i, "UNAVAILABLE"],
];

/** The first line of the answer that names what it changed: `<verb>: <path>[ → <path>]`. */
const CHANGED = /^(written|saved|visibility changed|unchanged|moved|archived|encrypted|decrypted|commented|proposed|remembered in)[: ] ?(\S+)(?: → (\S+))?/m;
const ETAG = /\(etag ([^\s)]+)\)|^(?:new_)?etag: (\S+)$/m;
const VISIBILITY = /^(?:visibility|to): (private|team)\b/m;

/** What `result` says happened, as data, or null for a tool that only reads. */
export function outcomeOf(name, result) {
  if (!result || typeof result !== "object" || !writes(name)) return null;
  const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
  if (result.isError === true) {
    const code = result.held === true ? "NEEDS_PERSON" : ERROR_CODES.find(([pattern]) => pattern.test(text))?.[1] ?? "FAILED";
    return { applied: false, error: code };
  }
  const outcome = { applied: true };
  const changed = CHANGED.exec(text);
  if (changed) {
    if (changed[1] === "unchanged") outcome.unchanged = true;
    outcome.path = changed[3] ?? changed[2];
  }
  const visibility = VISIBILITY.exec(text);
  if (visibility) outcome.visibility = visibility[1];
  const etag = ETAG.exec(text);
  if (etag) outcome.etag = etag[1] ?? etag[2];
  return outcome;
}

/** `result` with its outcome block added, when it has one. Never throws. */
export function withOutcome(name, result) {
  try {
    const outcome = outcomeOf(name, result);
    if (outcome === null || !Array.isArray(result.content)) return result;
    return { ...result, content: [...result.content, { type: "text", text: `outcome: ${JSON.stringify(outcome)}` }] };
  } catch {
    return result;
  }
}
