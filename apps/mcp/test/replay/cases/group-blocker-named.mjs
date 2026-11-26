import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { CAPABILITIES } from "../../../../../packages/tex/gateway/agent/capabilities.js";
import { resolveSession } from "../../../src/session.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";
import { blockedLine } from "../../../../../packages/tex/gateway/agent/groupGuests.js";
import { holdersTool } from "../../../../../packages/tex/gateway/agent/groupHolders.js";

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

async function askerReach() {
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
}

/** Jo, not in @harbor-care, asks for its numbers: the turn reads none of it, and can look up who here holds it. */
async function holdersLookup() {
  const asked = [];
  const tool = holdersTool({ group: { key: "e5".repeat(32), from: "jo" }, holders: async (workspace) => (asked.push(workspace), { slug: "harbor-care", holders: ["sam", "sol"] }) });
  const answer = JSON.parse((await tool.call({ workspace: "Harbor Care" })).content[0].text);
  assert.deepEqual(answer, { workspace: "@harbor-care", holders: ["@sam", "@sol"] }, "who here holds it, as data");
  assert.deepEqual(asked, ["Harbor Care"], "asked about the workspace the chat named, nothing else");
  assert.equal(holdersTool({ group: null, holders: async () => null }), null, "only in a group chat");
}

export default {
  id: "group-blocker-named",
  incident: "2026-11-16 (and 2026-11-25, an ask the asker's own workspace could answer): a group chat lost its shared workspace overnight when someone joined who wasn't a member; Tex could only say the chat couldn't see it and sent people to the app, then, asked to add the newcomer, said only the owner could and sent them to the app again.",
  cause: "Nothing told the turn who kept the chat from the workspace, and add-everyone read as inviting the whole chat, so Tex never offered it to add one person.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const blocked = [{ slug: "harbor-co", who: "sam", why: "not_member" }];
      const turn = await chat.tag("ada", "Tex use the login I saved in @harbor-co", "Sam isn't in @harbor-co yet. Want me to invite them?", [], { group: { people: ["ada", "sam"], blocked } });
      assert.match(turn.shown, /This chat can't use @harbor-co: @harbor-co is missing @sam \(not a member\)/, "the turn is told who keeps the chat out");
      assert.match(turn.shown, /an owner of it can have you invite them \(send chat_add_everyone\)/, "and that inviting them is add-everyone");
      // 2026-11-16: reach goes by membership or an invitation by number. 2026-11-25: someone with no account is named by
      // number (or kept name), never by guest label, and the line is facts only: what to say is the model's.
      const guest = await chat.tag("ada", "Tex use the login I saved in @harbor-co", "The +1 (555) 010-2233 number isn't invited to @harbor-co yet. Want me to invite them?", [], { group: { people: ["ada"], guests: ["guest-1a2b"], numbers: [{ who: "guest-1a2b", phone: "+15550102233" }], blocked: [{ slug: "harbor-co", who: "guest-1a2b", why: "no_account" }] } });
      assert.match(guest.shown, /A chat reaches a workspace when everyone in it is a member or invited by number/, "an invitation by number counts");
      assert.match(guest.shown, /the \+1 \(555\) 010-2233 number \(not on Context, not invited\)/, "the guest is named by number");
      assert.doesNotMatch(guest.shown, /missing guest-|Never send anyone/, "no label, no scripted rule");
      // One list of numbers (2026-11-16): an app sign-in puts a number on the account as a texted code does.
      const roster = CAPABILITIES.flatMap((entry) => entry.cant ?? []).find((cant) => cant.where === "group" && /isn't on Context/.test(cant.what));
      assert.match(roster?.workaround?.text ?? "", /sign in to the Context app with the number/, "Tex offers the app sign-in as a way on");
      const forged = await chat.tag("ada", "Tex hi", "Hi.", [], { group: { blocked: [{ slug: "harbor-co", who: "+15555550100", why: "not_member" }] } });
      assert.doesNotMatch(forged.shown, /This chat can't use/, "a number is never named");
      // 2026-11-25 (rulebook rule 2, `asker-reach.md`): two people in a chat run a care business in its own workspace and
      // the third isn't in it; asked by one of the two, the turn reads the asker's own workspaces and is told whose access
      // it is and who here can't open it. Sabotage: put back "every person here is a member of" in `groupPrompt`, or drop
      // the reach check in `blockedLine`, and this fails.
      await askerReach();
      // And when the asker isn't in the workspace the chat named, who here is (send who_can_open, `groupHolders.js`):
      // the fact behind "a neutral boundary naming who holds the keys". Sabotage: drop the group check and this fails.
      await holdersLookup();
    } finally {
      chat.restore();
    }
  },
};
