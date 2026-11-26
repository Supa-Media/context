import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { crossAskTool } from "../../../../../packages/tex/gateway/agent/crossChat.js";
import { crossChatGateNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/crossChatGate.js";
import { settingsTools } from "../../../../../packages/tex/gateway/agent/settingsTools.js";

export default {
  id: "group-asks-no-personal-tex",
  incident:
    "2026-11-25 to 26, groups: a group's Tex asked people's personal Tex for things (\"what is seyi's last name\" handed the group turn his phone and four emails; \"what do my personal notes say about Twitter growth\"). Dev2, 2026-11-26: \"grouptex asking personal tex is not a node i want\".",
  cause: "A group turn held ask_chat aimed at the tagger's own 1:1 Tex (and before it ask_personal_tex), so a group could pull from someone's personal Tex.",
  path: "group by code",
  // Folded in from `group-asks-own-tex` (2026-11-24, Tex Devs: "grab the list I made with you in our 1:1"), which taught
  // the group to fetch it from the person's own Tex: now the group turn holds no ask_chat and is never told to.
  // Part three, kept from the same incident: the account held only the first name typed at sign-up, and nothing could
  // change it. Their own chat sets it (send account_name); a group chat never gets the tool.
  async run() {
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
