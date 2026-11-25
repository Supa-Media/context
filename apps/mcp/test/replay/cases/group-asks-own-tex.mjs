import assert from "node:assert/strict";
import { groupChat } from "../chats.mjs";
import { crossChatGroupPrompt } from "../../../../../packages/tex/gateway/agent/crossChat.js";
import { guestPrompt } from "../../../../../packages/tex/gateway/agent/groupGuests.js";

export default {
  id: "group-asks-own-tex",
  incident: "2026-11-24, Tex Devs: \"pick up the list I was working on with you in our 1:1 and share it here\" got \"I can't open your personal workspace, text me 1:1\", though the group's Tex can ask that person's own Tex with ask_chat.",
  cause: "The group turn's mail line told it to send people off to text it on their own for their notes, and its cross-chat line only covered \"anything else only their personal Tex knows\", so the sending-away sentence won.",
  path: "group tag",
  async run() {
    const chat = await groupChat();
    try {
      const turn = await chat.tag("ada", "Tex grab the packing list I made with you and post it here", "Asking your Tex for it.", [], { group: { people: ["ada"], cause: "tagged" } });
      assert.match(turn.shown, /their personal Tex has them: when someone points at something of theirs/, "a group turn is told to fetch what someone points at from their own Tex");
      assert.match(turn.shown, /if you can't tell what they mean, ask them one short question first/, "and to ask when it can't tell what they mean");
      assert.doesNotMatch(turn.shown, /say the person can text you on their own for that/, "and never to send them off to text it");
      // 2026-11-24, after #4152: "Nothing else there exists for you" still won, and Tex found the list, failed to open it from
      // the group and asked them to share it. The group's limits now point at their own Tex, and opening it here is ruled out.
      const guest = crossChatGroupPrompt(guestPrompt({ key: "a".repeat(64), members: "b".repeat(64), from: "ada", people: ["ada"], home: { folder: "tex/groups/kite" }, guestChat: true }, "acme"));
      assert.doesNotMatch(guest, /Nothing else there exists for you/, "a chat with guests no longer says nothing else exists");
      assert.match(guest, /their personal Tex can get for you/, "it points at their own Tex instead");
      assert.match(turn.shown, /never fetch it and never ask them to share or paste it: ask their personal Tex/, "and a search hit is fetched through their own Tex");
    } finally {
      chat.restore();
    }
  },
};
