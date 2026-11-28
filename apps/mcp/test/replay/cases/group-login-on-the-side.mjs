import assert from "node:assert/strict";
import { withPrivateLinks } from "../../../../../packages/tex/gateway/agent/privateAside.js";
import { withVaultWatch } from "../../../../../packages/tex/gateway/agent/vaultSaved.js";
import { crossAskTool, crossChatOf, crossChatPrompt } from "../../../../../packages/tex/gateway/agent/crossChat.js";
import { groupOf, groupPrompt } from "../../../../../packages/tex/gateway/agent/groupTurn.js";

export default {
  id: "group-login-on-the-side",
  incident:
    "Dev2, 2026-11-25, on what a group chat asking Tex to order with a site's login should do: \"Tex being - sure thing, and then texting " +
    "the person who asked on the side\"; \"anything that requires a user to enter sensitive information ... should be handled in 1:1\". " +
    "Before, Tex sent the private save link and the steps in the group. Dev2, 2026-11-27: Tex offered a person a summary of their own " +
    "notes \"on your own\", they said \"yea you can text me 1:1\" and nothing came; \"a two way loop indeed, I like the idea of tex being " +
    "able to decide on its own at what moments it should message you 1:1\".",
  cause:
    "A group turn was told to send whoever asked a vault_add link in the chat, and its tool answer handed the model the link, so the link " +
    "and the steps to save it went to everyone in the group. Later, text_privately was described only for asking for a card, an ID " +
    "or a code, the group was told it can't text anyone outside the chat, and the tagger's 1:1 run had no ask_chat to post back.",
  path: "group text",
  // Sabotage (2026-11-25): return the vault tool's own answer from `withPrivateLinks`, or put "send whoever asked a
  // vault_add link" back in the group prompt, and this fails. Sabotage (2026-11-27): put "You can't text anyone outside the
  // chat. " back alone, or make `crossChat.js` `backTo` return null, and this fails.
  async run() {
    const group = { ...groupOf({ group: { key: "c3".repeat(32), members: "d4".repeat(32), from: "shyoh", people: ["shyoh", "seyi"], reach: ["supa"] } }), home: { folder: "tex/groups/cactus-lotus-badge" } };
    const told = groupPrompt(group, "supa");
    assert.doesNotMatch(told, /send whoever asked a vault_add link/, "never told to send the link here");
    assert.match(told, /say here only that you'll text them/);
    const ledger = {};
    const token = "e".repeat(32);
    const call = withPrivateLinks(group, ledger, withVaultWatch(ledger, async () => ({ content: [{ type: "text", text: `Link to save the login: https://context.lc/vault/${token}` }] })));
    const answer = (await call("vault_add_link", { type: "login", site: "instacart.com" })).content[0].text;
    assert.doesNotMatch(answer, /vault\//, "the group's model never holds the link");
    assert.match(ledger.asides[0].texts[0], new RegExp(token), "it goes to @shyoh's own chat");
    assert.equal(ledger.vaultLinks.length, 1, "and the save still carries the group's task on");
    // Any follow-up of theirs goes the same way, and their own Tex can post back what they share.
    assert.match(told, /follow up with whoever tagged you in their own chat with you \(send text_privately\)/);
    const event = crossChatOf({ event: "chat_answer", crossChat: { id: "xfollowup0001", from: "a group chat they're in", what: "Send them a short summary of their own journal notes.", state: "aside", texts: [], key: group.key } }, { chatTurn: true, job: null });
    assert.equal(JSON.parse(crossChatPrompt(event).trim()).follow_up_from_group.follow_up, "Send them a short summary of their own journal notes.", "handed over as data");
    const asking = crossAskTool({ event, groups: [{ key: group.key, name: "Book club" }], counts: { hour: 0, day: 0, open: [] }, ledger: {}, gate: async () => null });
    assert.ok(asking, "their own Tex can post back to the group what they share");
  },
};
