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
 *  5. Writing the mark only once the review is filed, as before. → "a review
 *     stopped before its filing came back never scores the same turns again"
 *     fails: the second review reads the avocado turns again.
 *  6. Not putting the old mark back when nothing was filed. → "a review that
 *     filed nothing leaves its turns for the next one" fails.
 *  7. Asking the model when the mark could not be written. → "a mark that
 *     cannot be written files nothing" fails.
 *  8. Putting the old mark back when the filing threw (timed out), as #2153
 *     did. → "a filing that timed out keeps its turns marked" fails: the
 *     second review reads the teapot again.
 *  9. Filing on the default 8 s control-plane timeout. → "filing a review
 *     waits longer than a lookup" fails.
 * 10. Dropping "Judge Tex's answers themselves" from `SCORING` (2026-10-26).
 *     → "answers are judged themselves, not only the person's mood" fails.
 * 11. `whole` reading from the mark, or moving it (2026-10-29). → "a texted
 *     yes files the history Tex keeps once, past the mark, without moving it"
 *     fails.
 * 12. `whole` filing on the scores tier. → same test fails: a scores row for
 *     turns already scored.
 * 13. `REVIEW_MAX_TOKENS` back at 200 / 960, or a `max_tokens` stop reported
 *     as `no_score` (2026-10-29). → "a review leaves the model room to think
 *     before it answers…" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appendConversation } from "../src/agent/conversation.js";
import { createFeedbackMethods, TEX_REVIEW_FILE_TIMEOUT_MS } from "../src/controlPlane/feedback.js";
import { failedOf, handleReview, markOf, readReview, reviewAfterTurn, reviewConversation, reviewOutcome, sinceReviewed, transcriptOf, urgentReason } from "../src/agent/selfReview.js";

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

test("answers are judged themselves, not only the person's mood: quality and feature-ask codes are kept on every tier", async () => {
  const coded = readReview(JSON.stringify({ scores: SCORES, task: "research", signals: ["filler", "wrong", "incomplete", "feature_ask"] }), { words: false });
  assert.deepEqual(coded.signals, ["filler", "wrong", "incomplete", "feature_ask"]);
  for (const tier of ["scores", "full"]) {
    const store = memoryStore();
    const history = await texted(store, ["Tex what time does the teapot shop close", "Great question! I can't set routines from here. It closes at 9."]);
    const model = road(tier === "full" ? FULL_ANSWER : JSON.stringify({ scores: SCORES }));
    await reviewConversation({ env: ENV, store, session: SESSION, controlPlane: plane(tier), history, key: "texts", reason: "ended", request: model.request, log: () => {} });
    assert.match(model.asked[0].system, /not only how the person reacted/);
    assert.match(model.asked[0].system, /filler .*wrong .*incomplete .*feature_ask/s);
    if (tier === "full") assert.match(model.asked[0].system, /one numbered line per problem, every one of them/);
  }
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

test("a review stopped before its filing came back never scores the same turns again", async () => {
  const store = memoryStore();
  let history = await texted(store, ["find my avocado note", "Here it is."]);
  const model = road(JSON.stringify({ scores: SCORES }));
  // The first filing never answers, as when the host stops the Worker while the control plane is still writing.
  const stalled = { ...plane("scores"), fileTexReview: () => new Promise(() => {}) };
  const run = (h, control) => reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history: h, key: "texts", reason: "frustrated", request: model.request, log: () => {} });
  void run(history, stalled);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(model.asked.length, 1);
  history = [...history, { role: "user", text: "and the banana one?" }, { role: "assistant", text: "Found it too." }];
  assert.equal(await run(history, plane("scores")), "scores");
  assert.match(model.asked[1].messages[0].text, /banana/);
  assert.doesNotMatch(model.asked[1].messages[0].text, /avocado/);
});

test("a review that filed nothing leaves its turns for the next one", async () => {
  const store = memoryStore();
  const history = await texted(store, ["find my avocado note", "Here it is."]);
  const model = road(JSON.stringify({ scores: SCORES }));
  const run = (control) => reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history, key: "texts", reason: "ended", request: model.request, log: () => {} });
  assert.equal(await run({ ...plane("scores"), fileTexReview: async () => null }), null);
  assert.equal(await run(plane("scores")), "scores");
  assert.match(model.asked[1].messages[0].text, /avocado/);
});

test("a filing that timed out keeps its turns marked: it may have landed", async () => {
  const store = memoryStore();
  let history = await texted(store, ["what is this teapot", "A cast iron teapot."]);
  const model = road(JSON.stringify({ scores: SCORES }));
  const timedOut = { ...plane("scores"), fileTexReview: async () => { throw new Error("timed out"); } };
  const run = (h, control) => reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history: h, key: "texts", reason: "ended", request: model.request, log: () => {} });
  assert.equal(await run(history, timedOut), null);
  history = [...history, { role: "user", text: "and the banana one?" }, { role: "assistant", text: "Found it too." }];
  assert.equal(await run(history, plane("scores")), "scores");
  assert.match(model.asked[1].messages[0].text, /banana/);
  assert.doesNotMatch(model.asked[1].messages[0].text, /teapot/);
});

test("filing a review waits longer than a lookup", async () => {
  const calls = [];
  const methods = createFeedbackMethods({ post: async (path, body, options) => (calls.push(options), { review: { filed: "scores" } }) });
  assert.equal(await methods.fileTexReview("tok-fake", { reason: "ended" }), "scores");
  assert.equal(calls[0]?.timeoutMs, TEX_REVIEW_FILE_TIMEOUT_MS);
  assert.ok(TEX_REVIEW_FILE_TIMEOUT_MS >= 20_000);
});

test("a mark that cannot be written files nothing", async () => {
  const store = memoryStore();
  const history = await texted(store, ["find my avocado note", "Here it is."]);
  store.put = async () => {
    throw new Error("bucket timed out");
  };
  const model = road(JSON.stringify({ scores: SCORES }));
  const control = plane("scores");
  assert.equal(await reviewConversation({ env: ENV, store, session: SESSION, controlPlane: control, history, key: "texts", reason: "ended", request: model.request, log: () => {} }), null);
  assert.equal(model.asked.length, 0);
  assert.deepEqual(control.filed, []);
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
  assert.deepEqual(await answered.json(), { filed: null, why: "no_tier" });
});

test("asked is not filed: each review that files nothing says why", async () => {
  const store = memoryStore();
  const history = await texted(store, ["find my avocado note", "Here it is."]);
  const args = { env: ENV, store, session: SESSION, history, key: "texts", reason: "ended", log: () => {} };
  assert.deepEqual(await reviewOutcome({ ...args, env: { TEX_REVIEW: "off" }, controlPlane: plane("scores") }), { filed: null, why: "off" });
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("scores"), request: road("no idea").request }), { filed: null, why: "no_score" });
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: { ...plane("scores"), fileTexReview: async () => null }, request: road(JSON.stringify({ scores: SCORES })).request }), { filed: null, why: "not_filed" });
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("scores"), request: road(JSON.stringify({ scores: SCORES })).request }), { filed: "scores", why: null });
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("scores"), request: road(JSON.stringify({ scores: SCORES })).request }), { filed: null, why: "nothing_new" });
});

test("a review leaves the model room to think before it answers, and says when the answer still ran out of room", async () => {
  // 2026-10-29: Haiku 5.5 thinks by default, and at 200 tokens its thinking
  // used them all: 8 of 10 reviews came back empty and filed nothing.
  const store = memoryStore();
  const history = await texted(store, ["find my avocado note", "Here it is."]);
  const args = { env: ENV, store, session: SESSION, history, key: "texts", reason: "ended", log: () => {} };
  const asked = [];
  const cut = async (body) => (asked.push(body), { text: "", stop: "max_tokens" });
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("scores"), request: cut }), { filed: null, why: "cut_off" });
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("full"), request: cut }), { filed: null, why: "cut_off" });
  assert.ok(asked[0].maxTokens >= 2000, `scores review asks for ${asked[0].maxTokens} tokens`);
  assert.ok(asked[1].maxTokens >= 4000, `full review asks for ${asked[1].maxTokens} tokens`);
  const thrown = async () => {
    throw new Error("status 529");
  };
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("scores"), request: thrown }), { filed: null, why: "model_failed" });
  // A miss gives the turns back: the next review reads them.
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: plane("scores"), request: road(JSON.stringify({ scores: SCORES })).request }), { filed: "scores", why: null });
});

test("a conversation whose every ask failed is reviewed from the lines the Worker sent, and moves no mark", async () => {
  // Tex Devs, 2026-10-29: every reply failed, nothing was kept, and nothing was scored.
  const store = memoryStore();
  const history = await texted(store, ["find my avocado note", "Here it is."]);
  const args = { env: ENV, store, session: SESSION, history, key: "texts", reason: "ended", log: () => {} };
  await reviewConversation({ ...args, controlPlane: plane("scores"), request: road(JSON.stringify({ scores: SCORES })).request });
  const marks = () => [...store.objects.entries()].filter(([key]) => key.startsWith(".context/agent/reviews/"));
  const before = marks();
  const lines = failedOf([{ tex: false, text: "Tex what's on tonight" }, { tex: true, text: "I couldn't answer that one. Try again in a bit." }, { text: 7 }, "junk", null]);
  assert.equal(lines.length, 2, "anything that is not a line is left out");
  const control = plane("full");
  const model = road(FULL_ANSWER);
  assert.equal(await reviewConversation({ ...args, controlPlane: control, failed: lines, request: model.request }), "full");
  assert.match(model.asked[0].messages[0].text, /Them: Tex what's on tonight\n\nTex \(could not answer, sent instead\): I couldn't answer that one/);
  assert.equal(control.filed[0].texts, 1);
  assert.deepEqual(marks(), before, "no kept turn was read, so no mark moved");
  // Without a line Tex sent instead, there is nothing new to review.
  assert.deepEqual(await reviewOutcome({ ...args, controlPlane: control, failed: lines.slice(0, 1), request: model.request }), { filed: null, why: "nothing_new" });
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

test("a texted yes files the history Tex keeps once, past the mark, without moving it", async () => {
  // Dev2, 2026-10-29: "share my chats with the devs" (`apps/agent/src/reviewSharing.ts`).
  const store = memoryStore();
  let history = await texted(store, ["find my avocado note", "Here it is."]);
  const scored = road(JSON.stringify({ scores: SCORES }));
  await reviewConversation({ env: ENV, store, session: SESSION, controlPlane: plane("scores"), history, key: "texts", reason: "ended", request: scored.request, log: () => {} });
  history = [...history, { role: "user", text: "and the banana one?" }, { role: "assistant", text: "Found it too." }];
  const marks = () => [...store.objects.entries()].filter(([key]) => key.startsWith(".context/agent/reviews/"));
  const before = marks();

  // Not shared after all (the yes was taken back before the review ran): nothing filed, no scores row.
  const refused = plane("scores");
  assert.deepEqual(await reviewOutcome({ env: ENV, store, session: SESSION, controlPlane: refused, history, key: "texts", reason: "shared", whole: true, request: road(FULL_ANSWER).request, log: () => {} }), { filed: null, why: "not_shared" });
  assert.equal(refused.filed.length, 0);

  const control = plane("full");
  const model = road(FULL_ANSWER);
  const shared = await reviewOutcome({ env: ENV, store, session: SESSION, controlPlane: control, history, key: "texts", reason: "shared", whole: true, request: model.request, log: () => {} });
  assert.deepEqual(shared, { filed: "full", why: null });
  assert.equal(control.filed[0].reason, "shared");
  assert.match(control.filed[0].words.transcript, /avocado/, "the turns reviewed before are in it");
  assert.match(control.filed[0].words.transcript, /banana/);
  assert.deepEqual(marks(), before, "the mark is where it was: the banana turns are still the next review's");
  const next = road(JSON.stringify({ scores: SCORES }));
  await reviewConversation({ env: ENV, store, session: SESSION, controlPlane: plane("scores"), history, key: "texts", reason: "ended", request: next.request, log: () => {} });
  assert.match(next.asked[0].messages[0].text, /banana/);
  assert.doesNotMatch(next.asked[0].messages[0].text, /avocado/);
});

test("a shared history reads far more than one conversation's window", async () => {
  const many = [];
  for (let i = 0; i < 120; i += 1) many.push({ role: "user", text: `question ${i}` }, { role: "assistant", text: `answer ${i}` });
  assert.equal((await sinceReviewed(many, null)).length, 40);
  assert.equal((await sinceReviewed(many, null, 300)).length, 240);
  assert.ok(transcriptOf(await sinceReviewed(many, null, 300), [], [], 110_000).includes("question 0"));
});
