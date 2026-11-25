/**
 * EVERY TOOL A TEX TURN CAN HOLD, AS ONE FIXED CATALOGUE (Dev2, 2026-11-20: "treat a cache miss like a bug";
 * "tools are never added or removed for a single turn; unavailable tools return an error instead").
 *
 * Production, Nov 13 to 20: Tex's first rounds rewrote about 82,000 tokens to the prompt cache in 233 of 903 turns
 * because the six tools were described from what that one turn held (`sixTools.js` `sixToolsOver`): 61 different tool
 * lists in 253 calls, so no chat could read the tools and rules another chat had cached a minute before. The fixed list
 * (`sixToolsFixed.js`) describes every action a kind of chat can take from the definitions here instead, the same bytes
 * for every person and every turn of a deploy; what the turn may really call is still decided by the turn's own grants.
 *
 * Definitions only, never a call: each tool's own module keeps its code. Tools whose definition is built inside a
 * factory are read from a factory called once with inert inputs, here, at first use; nothing they would do runs.
 * `test/toolCatalogue.test.mjs` fails when a carrier a turn holds differs from its entry, or one is missing.
 */

import { ADVISOR_DEFINITION, ADVISOR_TOOL } from "./advisor.js";
import { RESTART_TOOL, STATUS_TOOL, STEER_TOOL } from "./background.js";
import { TOOL as START_JOB_DEFINITION } from "./backgroundTool.js";
import { BROWSE_DEFINITION } from "./browse.js";
import { commandTools } from "./commandTools.js";
import { OPEN_PAGE_DEFINITION, SEARCH_WEB_DEFINITION } from "./computer.js";
import { EARLIER_TEXTS_DEFINITION } from "./conversation.js";
import { readThreadTool } from "./conversationThreads.js";
import { crossAskTool, postInChatTool } from "./crossChat.js";
import { delegateSession } from "./delegate.js";
import { FILL_CARD_DEFINITION } from "./fillCard.js";
import { FILL_LOGIN_DEFINITION } from "./fillLogin.js";
import { groupChatsForTurn } from "./groupChats.js";
import { guestNameTool } from "./groupGuestNames.js";
import { earlierChatTool } from "./groupTurn.js";
import { personalTexTool } from "./askPersonalTex.js";
import { MAKE_LOGIN_DEFINITION } from "./makeLogin.js";
import { DRAW_DEFINITION, MAKE_DEFINITION } from "./pictureMaker.js";
import { PLAN_DEFINITION } from "./planBigAsk.js";
import { PROGRESS_TOOL_DEFINITION } from "./progress.js";
import { readBackTool } from "./readsIndex.js";
import { SAY_NOTHING_DEFINITION } from "./sayNothing.js";
import { settingsTools } from "./settingsTools.js";
import { mailAgentSession } from "./supervise.js";
import { TAPBACK_DEFINITION } from "./tapbackEnding.js";
import { TRAVEL_TIME_DEFINITION } from "./travelTime.js";
import { VISUAL_DEFINITION } from "./visuals/index.js";
import { readDayTool } from "./weekHistory.js";
import { computerTools } from "../../../../apps/mcp/src/machines/texActions.js";
import { TEXTS_CLIENT_ID, TEXTS_GROUP_CLIENT_ID } from "../../../../apps/mcp/src/machines/reach.js";
import { learnedSkillSession } from "./learnedSkills.js";

/** What a factory is handed: nothing it can reach. Its definitions never read these; its calls never run here. */
const INERT = {
  ledger: { append: async () => null, read: async () => [], list: async () => [] },
  group: { key: "0".repeat(64), members: [], homeOnly: false, guestTagger: false },
  callTool: async () => ({ content: [] }),
};

/** A factory's tools, as `{ tool, call }` entries or bare definitions, to definitions; a factory that throws gives none. */
function definitionsFrom(make) {
  try {
    const made = make();
    const list = Array.isArray(made) ? made : made === null || made === undefined ? [] : Array.isArray(made.tools) ? made.tools : [made];
    return list.map((entry) => entry?.tool ?? entry).filter((tool) => tool && typeof tool.name === "string");
  } catch {
    return [];
  }
}

/** The kinds of chat a definition's words differ by: the same tool is told a 1:1 and a group apart (`crossChat.js` `ask_chat`). */
export const CATALOGUE_KINDS = ["one", "group"];

function build(kind) {
  const group = kind === "group" ? INERT.group : null;
  const factories = [
    () => commandTools({ run: async () => null, group, consent: async () => false, snapshot: null, onMute: null }),
    () => settingsTools({ session: { workspaceId: "w" }, controlPlane: { vaultText: async () => null }, group, dispatch: async () => null, onInvite: () => {} }),
    () => computerTools({ env: { WORKSPACE_STORE: {} }, session: group === null ? { workspaceId: "w", actorClientId: TEXTS_CLIENT_ID, actorUserId: "u" } : { workspaceId: "w", actorClientId: TEXTS_GROUP_CLIENT_ID, texChatId: INERT.group.key, actorUserId: "u" }, controlPlane: { texMachinesOwned: async () => [] }, group, words: "" }),
    () => learnedSkillSession([{ name: "a-skill", when: "" }], async () => null).tools,
    () => readThreadTool({ threads: [], render: () => "" }),
    () => readBackTool({ reads: [], open: async () => null }),
    () => readDayTool({ ledger: INERT.ledger, chat: "c" }),
    () => earlierChatTool([]),
    () => groupChatsForTurn({ env: {}, groups: [], timeZone: "UTC" })?.tool,
    () => delegateSession(INERT.callTool, { handle: "@them", home: "@them" }),
    () => mailAgentSession(INERT.callTool, { path: "task.md" }, "m"),
    () => personalTexTool({ group: INERT.group, ledger: INERT.ledger, asker: async () => null }),
    () => guestNameTool({ group: INERT.group, ledger: INERT.ledger }),
    () => crossAskTool({ group, groups: [], counts: {}, ledger: INERT.ledger, gate: async () => null }),
    () => postInChatTool({ event: { kind: "ask", do: true }, group: INERT.group, ledger: INERT.ledger }),
  ];
  const constants = [
    ADVISOR_DEFINITION, RESTART_TOOL, STATUS_TOOL, STEER_TOOL, START_JOB_DEFINITION, BROWSE_DEFINITION,
    OPEN_PAGE_DEFINITION, SEARCH_WEB_DEFINITION, EARLIER_TEXTS_DEFINITION, FILL_CARD_DEFINITION, FILL_LOGIN_DEFINITION,
    MAKE_LOGIN_DEFINITION, DRAW_DEFINITION, MAKE_DEFINITION, PLAN_DEFINITION, PROGRESS_TOOL_DEFINITION,
    SAY_NOTHING_DEFINITION, TAPBACK_DEFINITION, TRAVEL_TIME_DEFINITION, VISUAL_DEFINITION,
  ];
  const all = new Map();
  for (const tool of [...constants, ...factories.flatMap(definitionsFrom)]) if (!all.has(tool.name)) all.set(tool.name, tool);
  return all;
}

const built = new Map();

/** Every local carrier's definition for a kind of chat (`"one"` or `"group"`; a job reads as its chat's), by name. */
export function catalogue(kind = "one") {
  const key = kind === "group" ? "group" : "one";
  if (!built.has(key)) built.set(key, build(key));
  return built.get(key);
}

export { ADVISOR_TOOL };
