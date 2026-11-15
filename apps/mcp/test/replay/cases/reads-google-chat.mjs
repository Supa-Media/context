import assert from "node:assert/strict";
import { oneToOne } from "../chats.mjs";

export default {
  id: "reads-google-chat",
  incident:
    "2026-11-15: asked in a 1:1 text to check their Google Chat for a colleague's message, Tex called fetch chat: as its capability list says, was told there was no such tool, and answered from a ten-day-old Chat notification email instead.",
  cause:
    "A 1:1 turn's fetch chat: was taken for a group chat's own history (earlier_chat), which no 1:1 turn holds, and the Google Chat reader was never handed to a turn at all. " +
    "Then every read went to their first Google account, while the conversation was in another; now each read names its account.",
  path: "1:1 texts that read Google Chat",
  async run() {
    const chat = await oneToOne();
    const google = chat.world.controlPlane.googleChat;
    const asked = [];
    try {
      google.flags.from = "rowan@work.example";
      google.flags.accounts = ["rowan@work.example", "rowan@church.example"];
      google.flags.recent = (body) => {
        asked.push(body);
        return [{ id: "spaces/AAA/messages/m1", from: "Ada Example", text: "we may have to call off the showcase", at: "2026-11-15T17:00:00.000Z" }];
      };
      const first = await chat.text("check my google chat, did Ada say anything about the showcase?", [
        { toolCalls: [{ name: "fetch", args: { id: "chat:", args: { to: "ada@work.example" } } }] },
        { toolCalls: [{ name: "fetch", args: { id: "chat:", args: { to: "ada@work.example", account: "rowan@church.example" } } }] },
        { text: "Ada said you may have to call off the showcase." },
      ]);
      // The turn's own request (a later step, such as the answer's check, can carry a different set).
      const fetch = chat.world.model.requests.flatMap((request) => request.tools ?? []).find((tool) => tool.name === "fetch" && /Google Chat/.test(tool.description));
      assert.match(fetch?.description ?? "", /chat: lists their Google Chat spaces/, "the turn's fetch says how to read Google Chat");
      assert.match(fetch?.description ?? "", /names the Google account it reads/, "and that each read names its account");
      assert.match(first.shown, /Name the Google account[^]*rowan@work\.example, rowan@church\.example/, "a read without an account is answered with their Chat accounts");
      assert.doesNotMatch(first.shown, /There is no such tool|not something you were given/, "the read is never refused as a tool the turn lacks");
      assert.equal(asked.length, 1, "the control plane is asked for that one conversation");
      assert.equal(asked[0].to, "ada@work.example");
      assert.equal(asked[0].account, "rowan@church.example", "read from the account the model named, not the first");
      assert.match(first.shown, /Google Chat, the direct message with ada@work\.example, from rowan@church\.example's account[^]*we may have to call off the showcase/, "and the model reads what Ada wrote");
      assert.match(first.answer, /call off the showcase/);
    } finally {
      chat.restore();
    }
  },
};
