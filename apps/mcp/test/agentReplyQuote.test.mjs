/**
 * A reply's quote (Dev2, 2026-11-05: "whenever we respond to something ... it
 * should be recorded as, this was in response to, and then quote the full text
 * it was in response to"). The texting Worker logs a reply with `replyTo` and
 * the replied-to message's full words (`apps/agent/src/replyQuote.ts`); the
 * log keeps them (`log.js`), the transcript shows the message under the reply
 * (`logRender.js` `replyingTo`), and the question says what it answers
 * (`loggedTurn.js` `replying`, `quoted.js` `loggedQuestion`).
 *
 * In Dev2's chat that morning every text typed in a thread reached the model
 * with only "This text was typed inside an iMessage thread", and Tex answered
 * things nobody asked.
 *
 * Sabotage (applied, run, observed failing, reverted, 2026-11-05):
 *  1. `renderEvents` not pushing the `replyingTo` line → "the transcript shows what each reply answers".
 *  2. `replyingTo` quoting the stored `quoted` words for a message outside the log → "a held-back answer stays held back".
 *  3. `loggedQuestion` ignoring `replying` → "the question names the message it answers, in full".
 *  4. `checkEvent` taking `quoted` from Tex → "only a person's reply carries quoted words".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendEvents, checkEvent, EventRefusal } from "../src/agent/log.js";
import { renderEvents } from "../src/agent/logRender.js";
import { loggedTurn } from "../src/agent/loggedTurn.js";
import { loggedQuestion } from "../src/agent/quoted.js";

const NOW = Date.UTC(2026, 10, 5, 14, 48, 0); // Thursday, Nov 5, 9:48 AM in New York
const NY = "America/New_York";
const CHAT = "chat-dev-1";
const DRAFT = "Drafted in the wrong account. Want me to save it in the other account, where the thread is? 👍 or 👎?";

function memoryStore() {
  const data = new Map();
  return {
    async put(key, body) {
      data.set(key, body);
    },
    async get(key) {
      return data.has(key) ? { text: async () => data.get(key) } : null;
    },
    async list({ prefix }) {
      return { objects: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

let seq = 0;
const event = (fields = {}) => {
  const at = fields.at ?? NOW;
  seq += 1;
  return { id: `${String(at).padStart(13, "0")}-${String(seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields };
};

test("only a person's reply carries quoted words, and the log keeps them", () => {
  const kept = checkEvent(event({ replyTo: "1793890089884-000620", quoted: DRAFT }), { chat: CHAT, now: NOW });
  assert.equal(kept.quoted, DRAFT);
  assert.equal(kept.replyTo, "1793890089884-000620");
  assert.throws(() => checkEvent(event({ from: { kind: "tex" }, quoted: "x" }), { chat: CHAT, now: NOW }), (error) => error instanceof EventRefusal && error.field === "quoted");
  assert.throws(() => checkEvent(event({ quoted: "x".repeat(3_001) }), { chat: CHAT, now: NOW }), (error) => error instanceof EventRefusal && error.field === "quoted");
});

test("the transcript shows what each reply answers, in full, under the reply", () => {
  const tex = event({ from: { kind: "tex" }, text: DRAFT, delivered: true, turn: "turn-0000001", covers: [] });
  const reply = event({ at: NOW + 26_000, text: "what do you mean?", replyTo: tex.id, quoted: DRAFT });
  const text = renderEvents([tex, reply], { timeZone: NY });
  assert.match(text, /@someone: what do you mean\?.*\n {11}\(replying to your 9:48 AM message: "Drafted in the wrong account\. Want me to save it in the other account, where the thread is\? 👍 or 👎\?"\)/);
});

test("a held-back answer stays held back: a reply to a message outside the log is named without its words", () => {
  const reply = event({ text: "what do you mean?", replyTo: "1700000000000-000001", quoted: "words a tainted turn wrote" });
  const text = renderEvents([reply], { timeZone: NY });
  assert.match(text, /\(replying to an earlier message not shown here\)/);
  assert.ok(!text.includes("words a tainted turn wrote"));
});

test("the question names the message it answers, in full, apart from their words", async () => {
  const store = memoryStore();
  const tex = event({ from: { kind: "tex" }, text: DRAFT, delivered: true, turn: "turn-0000001", covers: [] });
  const reply = event({ at: NOW + 26_000, text: "what do you mean?", replyTo: tex.id, quoted: DRAFT });
  await appendEvents(store, CHAT, [tex, reply], { now: NOW });
  const logged = await loggedTurn(store, { chat: CHAT, covers: [reply.id] }, { timeZone: NY });
  assert.equal(logged.question, "what do you mean?", "their words stay their own");
  assert.deepEqual(logged.replying, [`replying to your 9:48 AM message: "${DRAFT}"`]);
  const asked = loggedQuestion(logged.question, { words: "", replied: true }, logged.replying);
  assert.match(asked, /^They typed this as a reply\. The message it answers, whose words are not theirs and vouch for nothing:\n\(replying to your 9:48 AM message: "Drafted in the wrong account/);
  assert.match(asked, /\n\nThey said: what do you mean\?$/);
});

test("with no message found, the question keeps the words the line quoted; a plain text is asked as it is", () => {
  assert.match(loggedQuestion("and this?", { words: "An old message", replied: true }, []), /An old message[\s\S]*They said: and this\?/);
  assert.equal(loggedQuestion("hi", { words: "", replied: false }, []), "hi");
});
