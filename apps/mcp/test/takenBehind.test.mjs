/**
 * A group turn takes its asker's texts that landed behind it (`takenBehind.js`; bot battle, 2026-11-23: ALPHA's turn
 * saw BRAVO arrive and answered both, the record said it answered ALPHA alone, and BRAVO was answered a second time).
 *
 * Sabotage record (2026-11-24), each applied, this file run, named test failing, reverted:
 *  1. `loggedTurn` not adding `took` to what it covers → "the turn covers the asker's later text…" fails.
 *  2. `takenBehind` taking anyone's text, not only the asker's → "only the asker's own texts to Tex…" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEvents } from "../../../packages/tex/gateway/agent/log.js";
import { loggedTurn } from "../../../packages/tex/gateway/agent/loggedTurn.js";
import { takenBehind } from "../../../packages/tex/gateway/agent/takenBehind.js";
import { underNote } from "../../../packages/tex/gateway/agent/replyUnder.js";

const NOW = Date.UTC(2026, 10, 24, 0, 4, 22);
const CHAT = "chat-dev-1";
let seq = 0;
const event = (fields = {}) => {
  const at = fields.at ?? NOW;
  seq += 1;
  return { id: `${String(at).padStart(13, "0")}-${String(seq).padStart(6, "0")}`, at, chat: CHAT, kind: "text", text: "hi", ...fields };
};
const ivy = { kind: "person", who: "a".repeat(64), name: "ivy" };
const lee = { kind: "person", who: "b".repeat(64), name: "lee" };

function memoryStore() {
  const data = new Map();
  return {
    async put(key, body) { data.set(key, body); },
    async get(key) { return data.has(key) ? { text: async () => data.get(key) } : null; },
    async list({ prefix }) { return { objects: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key) { data.delete(key); },
  };
}

test("only the asker's own texts to Tex, after the newest it covers, and none Tex answered", () => {
  const alpha = event({ from: ivy, text: "tex, burst test A: reply with ALPHA-24." });
  const bravo = event({ at: NOW + 1_200, from: ivy, text: "tex, burst test B: reply with BRAVO-24." });
  const chatter = event({ at: NOW + 1_500, from: ivy, text: "lol this is fun" });
  const other = event({ at: NOW + 1_600, from: lee, text: "tex, and mine?" });
  const earlier = event({ at: NOW - 60_000, from: ivy, text: "tex, earlier one" });
  const answered = event({ at: NOW + 1_700, from: ivy, text: "tex, already answered" });
  const reply = event({ at: NOW + 1_800, from: { kind: "tex" }, text: "done", covers: [answered.id], delivered: true });
  const events = [earlier, alpha, bravo, chatter, other, answered, reply];
  assert.deepEqual(takenBehind(events, [alpha], { group: true }).map((e) => e.id), [bravo.id]);
  assert.deepEqual(takenBehind(events, [alpha], { group: false }), [], "a 1:1 chat folds through steering as before");
  assert.deepEqual(takenBehind(events, [alpha, other], { group: true }), [], "a turn answering two people takes nobody's");
});

test("the turn covers the asker's later text, numbers it for its own thread, and names it for the Worker to drop", async () => {
  const store = memoryStore();
  const alpha = event({ from: ivy, text: "tex, burst test A: reply with ALPHA-24." });
  const bravo = event({ at: NOW + 1_200, from: ivy, text: "tex, burst test B: reply with BRAVO-24." });
  await appendEvents(store, CHAT, [alpha, bravo], { now: NOW + 2_000 });
  const logged = await loggedTurn(store, { chat: CHAT, covers: [alpha.id] }, { group: {}, timeZone: "America/New_York" });
  assert.deepEqual(logged.covered.map((e) => e.id), [alpha.id, bravo.id]);
  assert.deepEqual(logged.took, [bravo.id]);
  assert.match(logged.question, /ALPHA-24[\s\S]*BRAVO-24/);
  assert.match(underNote(logged.covered, { group: true }), /\[2\] @ivy: tex, burst test B/);
  const solo = await loggedTurn(store, { chat: CHAT, covers: [alpha.id] }, { timeZone: "America/New_York" });
  assert.deepEqual(solo.took, [], "not in a 1:1");
});
