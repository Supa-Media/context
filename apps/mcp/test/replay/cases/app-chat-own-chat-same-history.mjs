import assert from "node:assert/strict";
import { buildRows } from "../../../../../packages/tex/gateway/agent/appChatRows.js";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../../../../../packages/tex/gateway/agent/ledger.js";
import { oneToOne } from "../chats.mjs";

export default {
  id: "app-chat-own-chat-same-history",
  incident: "2026-11-19: the Context app's chat with Tex was mocked up showing the person's iMessage thread inside it; the owner wanted it to be its own chat, like a second messaging app, while Tex still remembers both.",
  cause: "A 1:1 chat's events reach one ledger whatever line they came over, with nothing saying which line: the app could only show everything, or nothing it could tell apart.",
  path: "1:1 text",
  // Sabotage (2026-11-19): drop the `via` mark in ledger.js `eventEntry` and the app's rows hold nothing; drop the
  // `event.app` check in appChatRows.js `rowOf` and the iMessage text shows in the app.
  async run() {
    const chat = await oneToOne();
    try {
      await chat.text("my sister's name is Ama, she lands Friday", "Noted: Ama, landing Friday.");
      // A message from the Context app's own chat (`packages/tex/worker/appChat.ts`), flushed by its chat object to the same record.
      await chat.keep({ chat: "app:k7m2q9x4b8n3c6v1", text: "can you remind me to pick her up?" });
      const next = await chat.text("what did I ask you in the app?", "To remind you to pick Ama up.");
      assert.match(next.shown, /can you remind me to pick her up\?/, "Tex's turn on iMessage sees what was said in the app");
      assert.match(next.shown, /my sister's name is Ama/, "and the texts");
      const kept = (await ledgerFor(chat.world.env, { person: "ws_egress" }).read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries;
      assert.ok(kept.some((entry) => entry.via === "app" && entry.text === "can you remind me to pick her up?"), "the record marks the app's message");
      const rows = buildRows(kept, {}, Date.now());
      assert.deepEqual(rows.map((row) => row.text), ["can you remind me to pick her up?"], "the app shows only its own chat");
    } finally {
      chat.restore();
    }
  },
};
