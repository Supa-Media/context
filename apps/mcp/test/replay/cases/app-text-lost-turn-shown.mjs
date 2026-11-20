import assert from "node:assert/strict";
import { buildRows } from "../../../../../packages/tex/gateway/agent/appChatRows.js";
import { serveAppOutbox } from "../../../../../packages/tex/gateway/texChat/appChat.js";
import { markRunning, recoverLostTurn } from "../../../../../packages/tex/worker/turnWatch.ts";

const CHAT = "app:k7m2q9x4b8n3c6v1";

/** A chat object's storage, with the one alarm a Durable Object has. */
function storage() {
  const map = new Map();
  return {
    map,
    alarm: null,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) => new Map([...map].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(at) {
      this.alarm = at;
    },
  };
}

export default {
  id: "app-text-lost-turn-shown",
  incident: "2026-11-20 8:25 AM: an app text asking for Bible study notes got no answer; the turn wrote the note and drafted its reply, then the chat object was reset for running out of memory, and the app showed the text as sent with nothing after it.",
  cause: "The queue kept no mark that a turn was running and set no alarm past it, so a reset mid-alarm left the text waiting with nothing to wake the object, and nothing told the person.",
  path: "1:1 text (app)",
  // Sabotage (2026-11-20): drop `markRunning`'s alarm and the object has no alarm after the reset; drop the failed
  // mark in `recoverLostTurn` and the row shows `read`, never failed.
  async run() {
    const at = 1_800_000_000_000;
    const chat = storage();
    chat.map.set("__inbox_name", CHAT);
    const item = { message: { kind: "message", eventId: "app:1", chatId: CHAT, from: CHAT, messageId: "app:1", text: "notes on chapter 6 please" }, attempts: 0, at, ev: "e1" };
    chat.map.set("pending:000000000001", item);
    // The turn starts; the object is reset mid-turn (nothing in memory), twice.
    await markRunning(chat, [["pending:000000000001", item]], at);
    assert.ok(chat.alarm !== null && chat.alarm <= at + 90_000, "an alarm comes after the reset");
    assert.equal(await recoverLostTurn(chat, CHAT, at + 90_000), "retry", "tried again once");
    await markRunning(chat, [["pending:000000000001", item]], at + 90_000);
    assert.equal(await recoverLostTurn(chat, CHAT, at + 180_000), "failed");
    const outbox = await (await serveAppOutbox(chat, { alarms: chat, now: () => at + 180_000 })).json();
    const person = { id: "e1", at, chat: CHAT, from: { kind: "person", who: "f".repeat(64) }, kind: "text", text: item.message.text };
    const [row] = buildRows([], { ...outbox, events: [person] }, at + 180_000);
    assert.equal(row.state, "failed", "the app says Tex didn't answer it");
    assert.equal(row.failedAt, at + 180_000);
  },
};
