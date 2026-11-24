import assert from "node:assert/strict";
import { appendEvents } from "../../../../../packages/tex/gateway/agent/log.js";
import { loggedTurn } from "../../../../../packages/tex/gateway/agent/loggedTurn.js";
import { splitUnder } from "../../../../../packages/tex/gateway/agent/replyUnder.js";

const CHAT = "chat-burst-1";
const AT = Date.UTC(2026, 10, 24, 0, 4, 22);
const rae = { kind: "person", who: "c".repeat(64), name: "rae" };

function memoryStore() {
  const data = new Map();
  return {
    async put(key, body) { data.set(key, body); },
    async get(key) { return data.has(key) ? { text: async () => data.get(key) } : null; },
    async list({ prefix }) { return { objects: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { data.delete(key); },
  };
}

export default {
  id: "burst-answered-once",
  incident:
    "2026-11-23 (a group chat): someone sent \"tex, reply with ALPHA-24\" and a second later \"tex, reply with BRAVO-24\". " +
    "Tex answered both under the first text, then answered BRAVO-24 again under the second.",
  cause:
    "The first text's turn waited behind another and then read the chat, second text included, and answered both; but which texts a turn answers was " +
    "fixed when it was handed, so the record said it answered only the first, and the second, queued meanwhile, got a turn of its own.",
  path: "group text",
  // Sabotage (2026-11-24): stop adding `took` to what loggedTurn covers and this fails.
  async run() {
    const store = memoryStore();
    const alpha = { id: `${AT}-000001`, at: AT, chat: CHAT, kind: "text", from: rae, text: "tex, burst test A: reply with ALPHA-24." };
    const bravo = { id: `${AT + 1_200}-000002`, at: AT + 1_200, chat: CHAT, kind: "text", from: rae, text: "tex, burst test B: reply with BRAVO-24." };
    await appendEvents(store, CHAT, [alpha, bravo], { now: AT + 3_000 });
    const logged = await loggedTurn(store, { chat: CHAT, covers: [alpha.id] }, { group: {}, timeZone: "America/New_York" });
    assert.deepEqual(logged.took, [bravo.id], "the turn takes BRAVO, so the Worker drops its waiting turn");
    const { parts } = splitUnder("[1] ALPHA-24\n\n[2] BRAVO-24", logged.covered);
    assert.deepEqual(parts, [{ under: alpha.id, text: "ALPHA-24" }, { under: bravo.id, text: "BRAVO-24" }], "each answer under its own text");
  },
};
