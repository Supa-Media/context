import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { crossAskTool } from "../../../../../packages/tex/gateway/agent/crossChat.js";
import { crossChatGateNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/crossChatGate.js";
import { settingsTools } from "../../../../../packages/tex/gateway/agent/settingsTools.js";
import { resolveSession, sessionForContext, SCOPE_WRITE } from "../../../src/session.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";

/** The grant the control plane mints for Ada's own ask in a group: the home, a shared workspace, and maybe Ada's own notes. */
function askGrant(rows) {
  const row = "#00000000-0000-7000-8000-0000000000c3";
  return {
    async resolveSession() {
      return {
        grantId: "grant_ada_ask",
        clientId: "context_texts_group",
        actorUserId: "user_ada",
        scopes: ["context:read", "context:write"],
        defaultWorkspaceId: "ws_pin",
        workspaces: [{ workspaceId: "ws_pin", slug: "context-lc", role: "editor", kind: "shared", grantedNames: ["#reads-as-chat", row, `${row}!edit`], homeOnly: true, chatHome: "tex/groups/maple-kite-ridge" }, { workspaceId: "ws_kiln", slug: "kiln-co", role: "editor", kind: "shared" }, ...rows],
      };
    },
  };
}

export default {
  id: "group-asks-no-personal-tex",
  incident:
    "2026-11-25 to 26, groups: a group's Tex asked people's personal Tex for things (\"what is seyi's last name\" handed the group turn his phone and four emails; \"what do my personal notes say about Twitter growth\"). Dev2, 2026-11-26: \"grouptex asking personal tex is not a node i want\".",
  cause: "A group turn held ask_chat aimed at the tagger's own 1:1 Tex (and before it ask_personal_tex), so a group could pull from someone's personal Tex. Once that was gone, an ask for the asker's own notes got \"I can't open your personal notes from this chat\" (2026-11-26), because a group ask never read the asker's own personal workspace and the turn was told nobody's personal notes can be read.",
  path: "group by code",
  // Folded in from `group-asks-own-tex` (2026-11-24, Tex Devs: "grab the list I made with you in our 1:1"), which taught
  // the group to fetch it from the person's own Tex: now the group turn holds no ask_chat and is never told to.
  // Part three, kept from the same incident: the account held only the first name typed at sign-up, and nothing could
  // change it. Their own chat sets it (send account_name); a group chat never gets the tool.
  // Part four (Dev2, 2026-11-26: "lets open the floodgates there right now"): the asker's own ask reads their own notes
  // directly, read only at their private tier, and the turn is told so as a fact.
  async run() {
    const asked = await resolveSession(`cat_replay_own_notes_${"0".repeat(20)}`, null, askGrant([{ workspaceId: "ws_ada", slug: "ada", role: "member", kind: "personal", askerOwn: true }]));
    const own = sessionForContext(asked, "@ada");
    assert.equal(own.scope, "private", "the asker's own notes open at their private tier");
    assert.ok(!own.scopes.includes(SCOPE_WRITE) && own.role === "member", "read only, never as the person themselves");
    assert.equal(sessionForContext(asked, "@kiln-co").scope, "team", "a shared workspace stays at team");
    const room = groupOf({ group: { key: "c".repeat(64), members: "c".repeat(64), from: "ada" } }, asked);
    assert.deepEqual(room.reach, ["kiln-co"], "the asker's personal workspace is not the room's reach");
    assert.match(groupPrompt(room, "context-lc"), /"this_turn":\{"asker":"@ada","readable":"@ada","read_only":true\}/, "the turn is told it can read them");
    assert.doesNotMatch(groupPrompt(room, "context-lc"), /Nobody's personal notes/, "and never that nobody's can be read here");
    const plain = groupOf({ group: { key: "c".repeat(64), members: "c".repeat(64), from: "ada" } }, await resolveSession(`cat_replay_own_notes_${"0".repeat(20)}`, null, askGrant([])));
    // Part five (Dev2, 2026-11-27): a turn that reads none is told so as a fact, with who they open for, never a
    // sentence that nobody's can be read: that sentence made Tex take back a listing it read on its owner's own ask.
    assert.match(groupPrompt(plain, "context-lc"), /"personal_notes_in_this_chat":\{"this_turn":"none","opens_on":"its owner's own ask"\}/, "without the control plane's mark, none this turn, as data");
    assert.doesNotMatch(groupPrompt(plain, "context-lc"), /Nobody's personal notes/, "and no scripted line about it");
    const gate = (input) => crossChatGateNode(input);
    const counts = { hour: 0, day: 0, open: [] };
    for (const group of [{ key: "k".repeat(8), from: "ada", people: ["ada", "bo"] }, { from: "ada", people: ["ada"], homeOnly: true }]) {
      assert.equal(crossAskTool({ group, groups: [{ key: "a".repeat(64), name: "Tex Devs" }], counts, ledger: {}, gate }), null, "a group turn has no ask_chat");
    }
    assert.equal((await gate({ from: "group", to: { kind: "person", who: "ada" }, what: "Ada's last name", counts })).to, "refuse", "and the gate refuses a group's ask");
    assert.ok(crossAskTool({ groups: [{ key: "a".repeat(64), name: "Tex Devs" }], counts, ledger: {}, gate }), "a 1:1 still asks its person's groups");
    const chat = await groupChat();
    try {
      const turn = await chat.tag("ada", "Tex grab the packing list I made with you and post it here", "I can't open that from here.", [], { group: { people: ["ada"], cause: "tagged" }, body: { crossCounts: { hour: 0, day: 0, open: [] } } });
      assert.doesNotMatch(turn.shown, /their personal Tex has them|ask their personal Tex|ask_personal_tex/, "a group turn is never told to ask someone's personal Tex");
      assert.doesNotMatch(turn.shown, /"name":"ask_chat"/, "and holds no ask_chat");
    } finally {
      chat.restore();
    }
    let saved = "Ada";
    const controlPlane = { accountName: async (token, name) => ((saved = name ?? saved), { status: "done", name: saved }) };
    const session = { accessToken: "tok", workspaceId: "w1", flags: [], workspaces: [] };
    const named = settingsTools({ session, controlPlane, group: null, dispatch: async () => ({ isError: true }) }).find((entry) => entry.tool.name === "account_name");
    assert.ok(named, "their own chat can set the name on their account");
    await named.call({ name: "Ada Lovelace" });
    assert.equal(saved, "Ada Lovelace");
    assert.equal(settingsTools({ session, controlPlane, group: { from: "ada" }, dispatch: async () => ({}) }).find((entry) => entry.tool.name === "account_name"), undefined, "a group can't rename anyone");
  },
};
