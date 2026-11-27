import assert from "node:assert/strict";
import { privateAsideTool } from "../../../../../packages/tex/gateway/agent/privateAside.js";
import { crossAskTool, crossChatOf, crossChatPrompt } from "../../../../../packages/tex/gateway/agent/crossChat.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";

export default {
  id: "group-follow-up-both-ways",
  incident:
    "Dev2, 2026-11-27: in a group, Tex offered to send a person a summary of their own reflection notes \"on your own\"; they said " +
    "\"yea you can text me 1:1\" and Tex stayed quiet. Dev2: \"a two way loop indeed, I like the idea of tex being able to decide on its " +
    "own at what moments it should message you 1:1\".",
  cause:
    "text_privately was described only for asking someone for a card, an ID or a code, and the group was told it can't text anyone " +
    "outside the chat, so the model had no tool for sending a person something of theirs. Their 1:1 run was also never given ask_chat " +
    "(a run another chat started asked nobody), so it could not post back to the group what they chose to share.",
  path: "group text, then their 1:1",
  // Sabotage (2026-11-27): put "You can't text anyone outside the chat. " back alone, or make `backTo` return null, and this fails.
  async run() {
    const key = "c3".repeat(32);
    const group = { ...groupOf({ group: { key, members: "d4".repeat(32), from: "ada", people: ["ada", "bo"], reach: ["acme"] } }), home: { folder: "tex/groups/fern-pine-lake" } };
    assert.match(groupPrompt(group, "acme"), /follow up with whoever tagged you in their own chat with you \(send text_privately\)/);
    const ledger = {};
    const tool = privateAsideTool({ group, ledger });
    await tool.call({ what: "Send them a short summary of their own journal notes." });
    assert.equal(ledger.asides[0].what, "Send them a short summary of their own journal notes.", "it goes to @ada's own chat");
    const event = crossChatOf({ event: "chat_answer", crossChat: { id: "xfollowup0001", from: "a group chat they're in", what: ledger.asides[0].what, state: "aside", texts: [], key } }, { chatTurn: true, job: null });
    assert.equal(JSON.parse(crossChatPrompt(event).trim()).follow_up_from_group.follow_up, ledger.asides[0].what, "handed over as data");
    const asking = crossAskTool({ event, groups: [{ key, name: "Book club" }], counts: { hour: 0, day: 0, open: [] }, ledger: {}, gate: async (input) => ({ to: "ask", ask: { to: input.to } }) });
    assert.ok(asking, "their own Tex can post back to the group what they share");
  },
};
