/**
 * THE FIXED TOOL LIST: what a Tex model call is shown, the same bytes on every turn of a kind of chat (Dev2,
 * 2026-11-20: "until the next summary, the tools, system prompt and first message must stay exactly the same";
 * "tools are never added or removed for a single turn. Unavailable tools return an error instead").
 *
 * The six (`sixTools.js`) used to describe only what the one turn held: a check-in held one send action, a turn with
 * earlier reads one more fetch id, a person with a plugin off fewer write actions. Each difference rewrote the whole
 * cached prompt behind the tools, and no chat could read what another had cached (production, Nov 13 to 20: 55% of
 * first-round cache writes, ~$70 a month and ~0.8 s a turn; https://claude.ai/artifact/LEjwe3GnZuC8JZEXHEw54w).
 *
 * Here the shown carriers depend only on the kind of chat and the deploy: the gateway's own tool definitions
 * (`tools/registry.js`) as a 1:1's private reach or a group's team reach lists them, plus every Tex tool the kind can
 * hold (`toolCatalogue.js`). The production setup's skills, the same for every person, come from the turn. What the
 * turn may call is unchanged: an action it does not hold is refused with what it can do instead.
 */

import { UNLISTED_TOOLS, V2_ONLY_TOOLS } from "../../../../apps/mcp/src/tools/advertised.js";
import { PRIVATE_TIER_ONLY_TOOLS, STAFF_ONLY_TOOLS, toolDefinitions } from "../../../../apps/mcp/src/tools/registry.js";
import { OWN_READ_TOOLS } from "./sixTools.js";
import { catalogue } from "./toolCatalogue.js";
import { textingWriteTools } from "./textingWrites.js";

/** The kinds of chat with a list of their own: a 1:1 (its texts, check-ins, routines and jobs) and a group chat (and its jobs). */
export const FIXED_KINDS = ["one", "group"];

/** The kind a turn's list is, from whether it is a group chat's. */
export const fixedKindOf = (group) => (group ? "group" : "one");

/** The gateway's tools as a kind is listed them: a group reads at team reach, so the private-tier tools are not its own. */
function gatewayCarriers(kind) {
  return toolDefinitions().filter((tool) =>
    !V2_ONLY_TOOLS.has(tool.name) &&
    !STAFF_ONLY_TOOLS.has(tool.name) &&
    (!UNLISTED_TOOLS.has(tool.name) || (kind === "one" && OWN_READ_TOOLS.includes(tool.name))) &&
    (kind === "one" || !PRIVATE_TIER_ONLY_TOOLS.has(tool.name)) &&
    // Their texts and Google Chat are their own: never a group chat's.
    (kind === "one" || !OWN_READ_TOOLS.includes(tool.name)));
}

/**
 * Tex's own tools a group chat's turn never holds (`apps/mcp/test/agentGroupTurn.test.mjs`): the tagger's own errands
 * and texts. Shown to a group they were only ever refused, so the group's list leaves them out; it is still the same
 * for every group turn.
 */
export const NEVER_A_GROUPS = new Set(["delegate", "propose_note", "progress", "mail_agent", "earlier_texts"]);

/**
 * And the one a 1:1 never holds: a group chat's own earlier messages. Shown to a 1:1 it took fetch's `chat:` line, so the
 * 1:1 was told `chat:` reads a group chat instead of their Google Chat (`sixTools.js` `fetchTool`).
 */
export const NEVER_A_ONES = new Set(["earlier_chat"]);

/**
 * Every carrier a kind is shown, by name: the gateway's, then Tex's own, then the setup's skill reader when the turn
 * holds it (one setup for every person, so it is the same for every chat), and the chat's own history search when the
 * config offers it (`chatSearch.js`: one config for every turn of a deploy or a Lab draft, so it is the same bytes for
 * every chat; off, nothing about it is shown). Memoized by kind, skill reader and search.
 */
const memo = new Map();
export function fixedCarriers(kind, { readSkill = null, chatSearch = null } = {}) {
  const key = `${kind === "group" ? "group" : "one"}\u0000${readSkill ? JSON.stringify(readSkill) : ""}\u0000${chatSearch ? JSON.stringify(chatSearch) : ""}`;
  if (memo.has(key)) return memo.get(key);
  const shown = new Map();
  const gateway = gatewayCarriers(kind === "group" ? "group" : "one");
  for (const tool of gateway) shown.set(tool.name, tool);
  // A 1:1's writes as a text holds them (`textingWrites.js`): its save carries how routines are written. A group is told
  // that in its prompt (`groupRoutines.js`), as on its per-turn list.
  if (kind !== "group") for (const tool of textingWriteTools(gateway, { texting: true })) shown.set(tool.name, tool);
  for (const [name, tool] of catalogue(kind)) if (!shown.has(name) && !(kind === "group" ? NEVER_A_GROUPS : NEVER_A_ONES).has(name)) shown.set(name, tool);
  if (readSkill) shown.set(readSkill.name, readSkill);
  if (chatSearch) shown.set(chatSearch.name, chatSearch);
  if (memo.size > 32) memo.clear();
  memo.set(key, shown);
  return shown;
}
