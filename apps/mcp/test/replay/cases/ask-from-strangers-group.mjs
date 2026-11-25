import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";
import { personalTexTool } from "../../../../../packages/tex/gateway/agent/askPersonalTex.js";

const ACCOUNT = { name: "Ada", handle: "ada", phones: ["+15555550100"], emails: ["ada@example.invalid", "ada.l@example.invalid"], google: [] };

export default {
  id: "ask-from-strangers-group",
  incident: "2026-11-24, Tex Devs: \"pick up the health saas api services list I was working on with you in our 1:1 and share it here\" could never reach the 1:1, because a group whose people share no workspace had no ask_chat. Dev2 (2026-11-25) let it ask the sender's own Tex, for their own things, with the answer told that strangers read it.",
  cause: "A chat that reaches no shared workspace was a guest chat with no cross-chat asks; now it asks, so the 1:1 answering must know some readers don't share a workspace with the person.",
  path: "1:1 by code",
  // Part two, same path into another person's Tex (folded in: the pipeline area is at its 100-case cap). 2026-11-25, a
  // group: "Tex what is seyi's last name". ask_chat contact:true answered by code from his account, handing the group
  // turn his phone and four emails, and a code-written status line "Asking your personal Tex for What is …" was texted
  // to the chat; the group's Tex then said his personal Tex knew no last name, though that Tex never ran.
  async run() {
    const tool = personalTexTool({ group: { key: "k", from: "ada", people: ["ada", "bo"] }, ledger: { asked: [], offered: null }, asker: async () => ACCOUNT });
    const facts = (await tool.call({ what: "What is Ada's last name?" })).content.map((part) => part.text).join("\n");
    assert.match(facts, /Name: Ada/);
    assert.doesNotMatch(facts, /\+1555|example\.invalid/, "a contact ask answers only the field asked for");
    assert.match(facts, /Personal Tex: not asked/, "never passed off as the personal Tex's answer");
    const chat = await oneToOne();
    try {
      const asked = await chat.byCode("the health saas api services list", "Here's the list: Stripe, Plaid, Twilio.", { event: "chat_ask", crossChat: { kind: "ask", id: "xeeeeeeeeee", from: "a group chat they're in", what: "the health saas api services list", do: false, strangers: true } });
      assert.match(asked.shown, /THIS RUN ANSWERS ANOTHER CHAT/);
      assert.match(asked.shown, /to you they are strangers: send back exactly what they pointed at/, "the 1:1 knows strangers read its answer");
      assert.equal(asked.answer, "", "nothing is texted to them");
      assert.equal(asked.body.crossBack?.id, "xeeeeeeeeee", "the answer goes back to the group");
    } finally {
      chat.restore();
    }
  },
};
