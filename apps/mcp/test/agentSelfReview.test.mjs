/**
 * Tex's self-review (`src/agent/selfReview.js`; the owner, 2026-10-24,
 * docs/decisions/texting-assistant/self-review.md): a finished conversation
 * scored 1 to 10 on five things, its words kept only where the control plane
 * says everybody in it is staff or said yes.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-24).
 *
 *  1. `reviewConversation` asking for words on the `scores` tier. → "on the
 *     scores tier the model is asked for numbers alone, and only numbers
 *     leave" fails.
 *  2. Not writing the mark after a review. → "a conversation reviewed once is
 *     not reviewed again until somebody texts" fails: the model is asked twice.
 *  3. `transcriptOf` keeping a tool's result. → "the model reads words and
 *     tool names, never a result" fails.
 *  4. `handleReview` answering any grant. → "only Tex's own texting grants may
 *     ask for a review" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendConversation } from "../src/agent/conversation.js";
import { handleReview, markOf, readReview, reviewAfterTurn, reviewConversation, sinceReviewed, transcriptOf, urgentReason } from "../src/agent/selfReview.js";

const ENV = { TEX_REVIEW: "on", AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "gw-fake", AI_GATEWAY_TOKEN: "fake-token-0123456789abcdef" };
const SCORES = { goal: 4, independence: 3, turns: 5, friendly: 6, calm: 2 };
const FULL_ANSWER = JSON.stringify({
  scores: SCORES,
  summary: "Signing in took three asks",
  expected: "Tex signs in by itself.",
  improve: "Open the sign-in page before asking for a code.",
});

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      if (!objects.has(key)) return null;
      const body = objects.get(key);
      return { text: async () => body };
    },
    async put(key, value) {
      objects.set(key, value);
    },
  };
}

/** A model road that answers `text` and records what it was asked. */
function road(text) {
  const asked = [];
  return { asked, request: async (body) => (asked.push(body), { text }) };
}

/** The control plane's two review calls, answering `tier`. */
function plane(tier) {
  const filed = [];
  return {
    filed,
    texReviewTier: async () => tier,
    fileTexReview: async (_token, review) => (filed.push(review), review.words ? "full" : "scores"),
  };
}

const SESSION = { accessToken: "tok-fake", workspaceId: "ws-fake", actorClientId: "context_texts" };

async function texted(store, ...pairs) {
  let history = [];
  for (const [question, answer, tools = []] of pairs) {
    await appendConversation(store, "texts", history, question, answer, { tools });
    history = [...history, { role: "user", text: question }, { role: "assistant", text: answer, ...(tools.length ? { tools } : {}) }];
  }
  return history;
}

test("'fix this' and plain frustration review now; an ordinary text does not", () => {
  assert.equal(urgentReason("Tex fix this"), "fix_this");
  assert.equal(urgentReason("can you fix it please"), "fix_this");
  for (const said of ["sharrap", "Tex don’t be dull", "I already told you the code", "this is useless", "\u{1F624}"]) assert.equal(urgentReason(said), "frustrated", said);
  for (const said of ["ok thanks", "try again later today", "what's on my calendar?", "the fixture list"]) assert.equal(urgentReason(said), null, said);
});

test("the model's answer is read strictly: five whole numbers 1 to 10", () => {
  assert.deepEqual(readReview(JSON.stringify({ scores: SCORES }), { words: false }), { scores: SCORES, task: null, signals: [] });
  assert.equal(readReview(JSON.stringify({ scores: { ...SCORES, goal: 11 } }), { words: false }), null);
  assert.equal(readReview(JSON.stringify({ scores: { ...SCORES, calm: 2.5 } }), { words: false }), null);
  assert.equal(readReview("it went fine", { words: false }), null);
  assert.equal(readReview(FULL_ANSWER, { words: true }).words.improve, "Open the sign-in page before asking for a code.");
});

test("task and signals are codes from closed sets: anything else is dropped and the scores still count", () => {
  const coded = readReview(JSON.stringify({ scores: SCORES, task: "web_errand", signals: ["try_again", "repeated", "try_again"] }), { words: false });
  assert.deepEqual(coded, { scores: SCORES, task: "web_errand", signals: ["try_again", "repeated"] });
  const loose = readReview(JSON.stringify({ scores: SCORES, task: "she wanted her avocado order", signals: ["angry about the avocado", "swore", 7] }), { words: false });
  assert.deepEqual(loose, { scores: SCORES, task: null, signals: ["swore"] });
  assert.deepEqual(readReview(JSON.stringify({ scores: SCORES, signals: "swore" }), { words: false }).signals, []);
});

test("on the scores tier the model is asked for numbers alone, and only numbers leave", async () => {
  const store = memoryStore();
  const history = await texted(store, ["Tex open the avocado login", "I can't open that page."]);
  const model = road(JSON.stringify({ scores: SCORES, summary: "leaked words" }));
  const control = plane("scores");
  const filed = await reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history, key: "texts", reason: "ended", request: model.request, log: () => {} });
  assert.equal(filed, "scores");
  assert.equal(model.asked.length, 1);
  assert.doesNotMatch(model.asked[0].system, /summary|expected|improve/);
  assert.deepEqual(control.filed, [{ reason: "ended", scores: SCORES, signals: [], texts: 1 }]);
});

test("on the full tier the review carries what they expected, the fix and the conversation", async () => {
  const store = memoryStore();
  const history = await texted(store, ["Tex open the avocado login", "I can't open that page.", ["browse"]], ["sharrap", "Got it."]);
  const model = road(FULL_ANSWER);
  const control = plane("full");
  assert.equal(await reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history, key: "texts", reason: "frustrated", request: model.request, log: () => {} }), "full");
  const [review] = control.filed;
  assert.equal(review.reason, "frustrated");
  assert.equal(review.words.expected, "Tex signs in by itself.");
  assert.match(review.words.transcript, /Them: Tex open the avocado login\n\nTex: I can't open that page.\n {2}\(used: browse\)/);
  assert.match(review.words.transcript, /Them: sharrap/);
});

test("a conversation reviewed once is not reviewed again until somebody texts", async () => {
  const store = memoryStore();
  let history = await texted(store, ["find my avocado note", "Here it is."]);
  const model = road(JSON.stringify({ scores: SCORES }));
  const control = plane("scores");
  const run = (h) => reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history: h, key: "texts", reason: "ended", request: model.request, log: () => {} });
  assert.equal(await run(history), "scores");
  assert.equal(await run(history), null);
  assert.equal(model.asked.length, 1);
  history = [...history, { role: "user", text: "and the banana one?" }, { role: "assistant", text: "Found it too." }];
  assert.equal(await run(history), "scores");
  assert.match(model.asked[1].messages[0].text, /banana/);
  assert.doesNotMatch(model.asked[1].messages[0].text, /avocado/);
});

test("switched off, no tier, or no model: nothing is asked and nothing filed", async () => {
  const store = memoryStore();
  const history = await texted(store, ["hi", "Hey."]);
  const model = road(JSON.stringify({ scores: SCORES }));
  const args = { store, session: SESSION, history, key: "texts", reason: "ended", request: model.request, log: () => {} };
  assert.equal(await reviewConversation({ ...args, env: { ...ENV, TEX_REVIEW: "off" }, controlPlane: plane("full") }), null);
  assert.equal(await reviewConversation({ ...args, env: ENV, controlPlane: plane(null) }), null);
  assert.equal(model.asked.length, 0);
  const broken = road("no idea");
  const control = plane("full");
  assert.equal(await reviewConversation({ ...args, env: ENV, controlPlane: control, request: broken.request }), null);
  assert.deepEqual(control.filed, []);
});

test("the model reads words and tool names, never a result", () => {
  const text = transcriptOf([
    { role: "user", text: "what's my balance?" },
    { role: "assistant", text: "It's $12.", tools: ["search_email"], result: "SECRET-RESULT" },
  ]);
  assert.doesNotMatch(text, /SECRET-RESULT/);
  assert.match(text, /\(used: search_email\)/);
});

test("the mark finds where the last review stopped, and a lost mark reads the newest turns", async () => {
  const turns = [
    { role: "user", text: "a" }, { role: "assistant", text: "A" },
    { role: "user", text: "b" }, { role: "assistant", text: "B" },
  ];
  const mark = await markOf(turns.slice(0, 2));
  assert.deepEqual((await sinceReviewed(turns, mark)).map((turn) => turn.text), ["b", "B"]);
  assert.deepEqual((await sinceReviewed(turns, "gone")).map((turn) => turn.text), ["a", "A", "b", "B"]);
});

test("only Tex's own texting grants may ask for a review, and a group names its chat", async () => {
  const request = (body) => new Request("https://gateway.example.invalid/agent/review", { method: "POST", body: JSON.stringify(body) });
  const other = await handleReview(request({}), ENV, memoryStore(), { ...SESSION, actorClientId: "some_client" }, plane("full"));
  assert.equal(other.status, 403);
  const group = await handleReview(request({}), ENV, memoryStore(), { ...SESSION, actorClientId: "context_texts_group" }, plane("full"));
  assert.equal(group.status, 400);
  const store = memoryStore();
  await texted(store, ["find my avocado note", "Here it is."]);
  const answered = await handleReview(request({ conversation: "texts" }), { ...ENV }, store, SESSION, { ...plane("scores"), texReviewTier: async () => null });
  assert.deepEqual(await answered.json(), { filed: null });
});

test("after a turn, only 'fix this' or frustration reviews at once", async () => {
  const store = memoryStore();
  await texted(store, ["Tex fix this", "On it."]);
  const control = plane("scores");
  let asked = 0;
  control.texReviewTier = async () => (asked += 1, null);
  await reviewAfterTurn({ env: ENV, store, session: SESSION, controlPlane: control, question: "what's on today?", group: null, saved: true });
  assert.equal(asked, 0);
  await reviewAfterTurn({ env: ENV, store, session: SESSION, controlPlane: control, question: "Tex fix this", group: null, saved: true });
  assert.equal(asked, 1);
});
