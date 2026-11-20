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

import { UNLISTED_TOOLS, V2_ONLY_TOOLS } from "../tools/advertised.js";
import { PRIVATE_TIER_ONLY_TOOLS, STAFF_ONLY_TOOLS, toolDefinitions } from "../tools/registry.js";
import { OWN_READ_TOOLS } from "./sixTools.js";
import { catalogue } from "./toolCatalogue.js";

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
 * Every carrier a kind is shown, by name: the gateway's, then Tex's own, then the setup's skill reader when the turn
 * holds it (one setup for every person, so it is the same for every chat). Memoized by kind and skill reader.
 */
const memo = new Map();
export function fixedCarriers(kind, { readSkill = null } = {}) {
  const key = `${kind === "group" ? "group" : "one"}\u0000${readSkill ? JSON.stringify(readSkill) : ""}`;
  if (memo.has(key)) return memo.get(key);
  const shown = new Map();
  for (const tool of gatewayCarriers(kind === "group" ? "group" : "one")) shown.set(tool.name, tool);
  for (const [name, tool] of catalogue(kind)) if (!shown.has(name)) shown.set(name, tool);
  if (readSkill) shown.set(readSkill.name, readSkill);
  if (memo.size > 32) memo.clear();
  memo.set(key, shown);
  return shown;
}
