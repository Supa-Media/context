import assert from "node:assert/strict";
import { resolveSession } from "../../../src/session.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";
import { blockedLine } from "../../../../../packages/tex/gateway/agent/groupGuests.js";

const TOKEN = `cat_asker_reach_${"0".repeat(24)}`;
const ROW = "#00000000-0000-7000-8000-0000000000c4";

/** A control plane answering one home-only group session: the chat's home, then the asker's own workspaces. */
function controlPlane(reach) {
  const home = { workspaceId: "ws_pin", slug: "context-lc", role: "editor", kind: "shared", grantedNames: ["#reads-as-chat", ROW, `${ROW}!edit`], homeOnly: true, chatHome: "tex/groups/amber-reed-hollow" };
  return {
    async resolveSession() {
      return { grantId: "grant_chat", clientId: "context_texts_group", actorUserId: "user_sol", scopes: ["context:read", "context:write"], defaultWorkspaceId: "ws_pin", workspaces: [home, ...reach] };
    },
  };
}

export default {
  id: "group-asker-reach",
  incident:
    "2026-11-25, a three-person chat: two of them run a care business in a workspace of its own, the third isn't in it. One of the two asked how " +
    "the business was doing this month and Tex could read nothing of it, because the third person's presence emptied the chat's reach.",
  cause:
    "A group turn read only the shared workspaces every person in the chat is in, whoever asked; the rulebook says the asker's own access is the " +
    "ceiling, with what to say in front of the room left to the model.",
  path: "group text",
  // Sabotage (2026-11-25): put back "the shared workspaces every person here is a member of" in `groupPrompt`, or drop
  // the reach check in `blockedLine`, and this fails. What the turn may read is the control plane's
  // (`apps/convex/__tests__/textGroupAskerReach.test.ts`).
  async run() {
    const reach = [
      { workspaceId: "ws_harbor", slug: "harbor-care", role: "editor", kind: "shared" },
      { workspaceId: "ws_studio", slug: "studio-co", role: "editor", kind: "shared" },
    ];
    const session = await resolveSession(TOKEN, null, controlPlane(reach));
    const blocked = [{ slug: "harbor-care", who: "jo", why: "not_member" }];
    const group = groupOf({ group: { key: "e5".repeat(32), members: "f6".repeat(32), from: "sol", people: ["sol", "sam", "jo"], blocked } }, session);
    assert.deepEqual(group.reach, ["harbor-care", "studio-co"], "the asker's workspaces are the turn's reach");
    const told = groupPrompt(group, "context-lc");
    assert.match(told, /@sol, who asked you, can open, by their access and never anyone else's/, "the turn is told whose access it reads");
    assert.doesNotMatch(told, /every person here is a member of/, "never the room's lowest reach for an ask");
    assert.ok(told.includes(blockedLine(group)), "and who here can't open what it reads");
    assert.match(blockedLine(group), /Asker's, not everyone's: @harbor-care is missing @jo \(not a member\)/);
    assert.doesNotMatch(blockedLine(group), /chat_add_everyone/, "nothing to fix for a workspace the asker reads");
  },
};
