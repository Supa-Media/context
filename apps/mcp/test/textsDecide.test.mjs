// Decide and the last look asked of Clef in the gateway, over the `TexTexts` entrypoint (src/agent/textsDecide.js; Dev2's
// pick 2026-11-05: decide moves into the gateway, its cap and usage rows kept in the control plane). The questions are
// the control plane's own copy, the answer reads as it did there, and only counts come back for the usage report.
//
// Sabotage record (applied, run, observed failing, reverted):
//  1. the route not mounted on TexTexts → "reached through the TexTexts entrypoint" fails.
//  2. a failed model read as "silent" instead of unavailable → "a model that fails is unavailable" fails.
//  3. (2026-11-11) the judge entry not written → "the judge's verdict is kept in the group's ledger" fails.
//  4. (2026-11-11) the judge's state cut from its newest end → "a long chat's judge still reads the examples and the newest line" fails.
//  5. (2026-11-12) `/texts/chat` not mounted on TexTexts → "a group's judge reads the chat's day by its ledger key" fails.
//  6. (2026-11-12) `nowFacts` keeping a finished job → "the judge is told what Tex is doing now" fails.
//  7. (2026-11-12) `threadFacts` keeping a finished thread → "the judge is told which conversations are open" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chatForTexts, decideForTexts, eventsForTexts, nowFacts, TEXTS_CHAT_PATH, TEXTS_DECIDE_PATH, TEXTS_EVENTS_PATH, TEXTS_RECHECK_PATH } from "../src/agent/textsDecide.js";
import { decideRequest, recheckRequest } from "../../../packages/shared/src/textDecide.cjs";
import { MAX_DECISION_STATE_CHARS } from "../src/agent/decide.js";
import { TexTexts } from "../src/index.js";

const id = (n) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const SECRET = "the launch codes are pineapple";
const body = (extra = {}) => ({
  chat: "+15555550100",
  sender: "+15555550100",
  style: "direct",
  transcript: `<${id(1)}> @ada: save the playbook\n<${id(2)}> @ada: actually ${SECRET}`,
  candidates: [id(1), id(2)],
  running: false,
  waitingAsks: [],
  newest: id(2),
  ...extra,
});
const ask = (path, payload) => new Request(`https://gateway${path}`, { method: "POST", body: JSON.stringify(payload) });

test("asks the control plane's questions and reads the answer as it did", async () => {
  let seen = null;
  const engine = async (state, questions) => ((seen = { state, questions }), { act: { choice: "respond", confidence: 0.9 }, start: { choice: id(1) }, also_react: { noul: 0.1 } });
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(String(line));
  let response;
  try {
    response = await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine });
  } finally {
    console.log = log;
  }
  const answer = await response.json();
  assert.deepEqual(seen, decideRequest(body()));
  assert.equal(answer.ok, true);
  assert.equal(answer.act, "answer");
  assert.deepEqual(answer.covers, [id(1), id(2)]);
  assert.equal(answer.meter.questions, Object.keys(seen.questions).length);
  assert.equal(answer.meter.chars, seen.state.length + JSON.stringify(seen.questions).length);
  assert.equal(answer.meter.answered, true);
  assert.ok(!JSON.stringify(answer).includes("pineapple"));
  assert.ok(!logs.join("\n").includes("pineapple"));
});

test("the last look: one question, the draft in the state", async () => {
  let seen = null;
  const engine = async (state, questions) => ((seen = { state, questions }), { draft_fits: { noul: 0.2 } });
  const response = await decideForTexts(ask(TEXTS_RECHECK_PATH, { ...body(), draft: "Here's the playbook.", draftFor: id(1) }), {}, { engine });
  assert.deepEqual(await response.json().then(({ meter, ...rest }) => rest), { ok: true, fits: false, confidence: 0.2 });
  assert.deepEqual(Object.keys(seen.questions), ["draft_fits"]);
  assert.ok(seen.state.includes("Here's the playbook."));
});

test("a model that fails is unavailable, never a guess; no engine sends the Worker back to the control plane", async () => {
  const failed = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine: async () => null })).json();
  assert.deepEqual([failed.ok, failed.reason, failed.cause, failed.meter.answered], [false, "unavailable", "model_failed", false]);
  const offSet = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine: async () => ({ act: { choice: "shout" } }) })).json();
  assert.deepEqual([offSet.ok, offSet.cause], [false, "bad_answer"]);
  // No engine: 503, so the Worker falls back to the control plane rather than reading a final "unavailable".
  const none = await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine: null });
  assert.equal(none.status, 503);
});

test("a malformed body is refused before any model call", async () => {
  let called = false;
  const engine = async () => ((called = true), {});
  for (const bad of [{ style: "loud" }, { newest: id(9) }, { sender: undefined }, { transcript: "" }]) {
    const response = await decideForTexts(ask(TEXTS_DECIDE_PATH, body(bad)), {}, { engine });
    assert.equal(response.status, 400, JSON.stringify(bad));
  }
  assert.equal((await decideForTexts(new Request(`https://gateway${TEXTS_DECIDE_PATH}`, { method: "POST", body: "{" }), {}, { engine })).status, 400);
  assert.equal(called, false);
});

test("reached through the TexTexts entrypoint", async () => {
  const env = { AI: { run: async () => ({ answers: { act: { choice: "quiet", confidence: 0.8 } } }) } };
  const response = await TexTexts.fetch(ask(TEXTS_DECIDE_PATH, body()), env, {});
  const answer = await response.json();
  assert.equal(answer.ok, true);
  assert.equal(answer.act, "silent");
});

test("a long chat's last look still shows the model the draft: the transcript gives way from its oldest end", () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => `<e${i}> @a: message number ${i}`).join("\n");
  const draft = "Booked for 7pm.";
  const asked = recheckRequest({ transcript: lines.slice(-23_990), draft, draftFor: "e1990", newest: "e1999", style: "direct" });
  assert.ok(asked.state.length <= MAX_DECISION_STATE_CHARS);
  assert.ok(asked.state.endsWith(draft));
  assert.ok(asked.state.includes("<e1999>"));
  // It starts on a whole line, never half of one.
  assert.match(asked.state, /^<e\d+> /);
  const short = recheckRequest({ transcript: "<e1> @a: hi", draft, draftFor: "e1", newest: "e1", style: "direct" });
  assert.ok(short.state.startsWith("<e1> @a: hi"));
});

const GROUP_KEY = "ab".repeat(32);
const groupBody = (extra = {}) => body({ chat: "group-1", sender: undefined, line: "+15555550199", style: "quiet", ledger: GROUP_KEY, ...extra });

test("the judge's verdict is kept in the group's ledger: what, why and the event, never a word of the chat", async () => {
  const appended = [];
  const ledger = (key) => ({ append: async (chat, entries) => appended.push({ key, chat, entries }) });
  const pending = [];
  const engine = async () => ({ act: { choice: "respond", confidence: 0.92 }, why: { choice: "tags_tex" } });
  const answer = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, groupBody()), {}, { engine, ledger, waitUntil: (work) => pending.push(work) })).json();
  await Promise.all(pending);
  assert.equal(answer.why, "tags_tex");
  assert.equal(appended.length, 1);
  assert.equal(appended[0].key, GROUP_KEY);
  assert.equal(appended[0].chat, GROUP_KEY);
  const [entry] = appended[0].entries;
  assert.equal(entry.kind, "judge");
  assert.equal(entry.by, "moment");
  assert.equal(entry.verdict, "respond");
  assert.equal(entry.why, "tags_tex");
  assert.equal(entry.event, id(2));
  assert.equal(entry.went, true);
  // What it was asked, as references the Lab puts the words back from (Dev2, 2026-11-14): the texts' ids, not their words.
  assert.deepEqual(entry.input.candidates, groupBody().candidates);
  assert.equal(entry.input.newest, id(2));
  assert.equal(entry.input.running, false);
  assert.equal(typeof entry.input.transcriptChars, "number");
  assert.ok(!JSON.stringify(entry).includes("pineapple"));
  // A 1:1 names no ledger key, so it writes nothing; a last look is no verdict, so it is a step (Dev2, 2026-11-13: every step logs).
  await decideForTexts(ask(TEXTS_DECIDE_PATH, body()), {}, { engine, ledger, waitUntil: (work) => pending.push(work) });
  await decideForTexts(ask(TEXTS_RECHECK_PATH, { ...groupBody(), draft: "Hi.", draftFor: id(1) }), {}, { engine: async () => ({ draft_fits: { noul: 0.9 } }), ledger, waitUntil: (work) => pending.push(work) });
  await Promise.all(pending);
  assert.equal(appended.length, 2);
  const [step] = appended[1].entries;
  assert.equal(step.kind, "step");
  assert.equal(step.step, "decide");
  assert.equal(step.name, "recheck");
  assert.equal(step.ok, true);
  assert.ok(!JSON.stringify(step).includes("Hi."), "the draft is not copied into the step");
});

test("a ledger that fails never fails the verdict", async () => {
  const ledger = () => ({ append: async () => { throw new Error("down"); } });
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(String(line));
  const pending = [];
  try {
    const answer = await (await decideForTexts(ask(TEXTS_DECIDE_PATH, groupBody()), {}, { engine: async () => ({ act: { choice: "quiet", confidence: 0.8 } }), ledger, waitUntil: (work) => pending.push(work) })).json();
    await Promise.all(pending);
    assert.equal(answer.act, "silent");
  } finally {
    console.log = log;
  }
  assert.ok(logs.some((line) => line.includes("ledger_write_failed")));
});

test("a long chat's judge still reads the examples and the newest line", () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => `<${id(i + 1)}> @a: message number ${i}`).join("\n").slice(-23_990);
  const asked = decideRequest({ ...body(), transcript: lines, candidates: [id(2000)], newest: id(2000) });
  assert.ok(asked.state.length <= MAX_DECISION_STATE_CHARS);
  assert.ok(asked.state.startsWith("<examples>"));
  assert.ok(asked.state.includes(`<${id(2000)}> @a: message number 1999`));
});

// Dev2, 2026-11-12: "a judge should have all information and facts needed to correctly have a verdict".
const T0 = Date.UTC(2026, 10, 12, 16, 0);
const textEntry = (n, text, from = { kind: "person", who: "a".repeat(64), name: "rosa" }) => {
  const at = T0 - 60_000 + n;
  return { v: 1, id: `ev${n}`, eid: `${at}-${String(n).padStart(6, "0")}`, at, kind: "text", event: "text", from, text };
};

test("a group's judge reads the chat's day by its ledger key, over TexTexts only", async () => {
  const asked = [];
  const ledger = (key) => ({ read: async (chat, options) => (asked.push({ key, chat, options }), { entries: [textEntry(2, "the 10th"), textEntry(1, "Which day works?", { kind: "tex" })] }) });
  const answer = await (await chatForTexts(ask(TEXTS_CHAT_PATH, { ledger: GROUP_KEY, chat: "group-1" }), {}, { ledger, now: T0 })).json();
  assert.deepEqual(answer.events.map((event) => event.text).sort(), ["Which day works?", "the 10th"]);
  assert.equal(asked[0].key, GROUP_KEY);
  assert.deepEqual(asked[0].options.kinds, ["text"]);
  assert.equal(asked[0].options.since, T0 - 24 * 60 * 60 * 1000);
  // Mounted on the binding's entrypoint: a bad key there is refused by this route, not opened as a texts session.
  const viaEntry = await TexTexts.fetch(ask(TEXTS_CHAT_PATH, { ledger: "not-a-key", chat: "group-1" }), {}, {});
  assert.equal(viaEntry.status, 400);
});

test("the chat read refuses a malformed ask and says so when the ledger fails", async () => {
  const ledger = () => ({ read: async () => { throw new Error("down"); } });
  for (const bad of [{}, { ledger: GROUP_KEY }, { ledger: "x", chat: "group-1" }, { ledger: GROUP_KEY, chat: "a b" }]) {
    assert.equal((await chatForTexts(ask(TEXTS_CHAT_PATH, bad), {}, { ledger })).status, 400);
  }
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal((await chatForTexts(ask(TEXTS_CHAT_PATH, { ledger: GROUP_KEY, chat: "group-1" }), {}, { ledger })).status, 503);
  } finally {
    console.log = log;
  }
});

/** A group's event as the Worker's outbox holds it (`apps/agent/src/events.ts`). */
const groupEvent = (n, text, at = Date.now() - 60_000 + n) => ({ id: `${at}-${String(n).padStart(6, "0")}`, at, chat: "group-1", from: { kind: "person", who: "a".repeat(64), name: "rosa" }, kind: "text", text });
const quietly = async (work) => {
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  try {
    return { result: await work(), lines };
  } finally {
    console.log = log;
  }
};

test("what a group says while Tex is quiet goes into its ledger by key, with no token (Tex Devs, 2026-11-13)", async () => {
  const appended = [];
  const ledger = (key) => ({
    read: async (chat) => (assert.equal(chat, key), { entries: [textEntry(1, "earlier")] }),
    append: async (chat, entries) => appended.push({ key, chat, entries }),
  });
  const events = [groupEvent(1, "Instinct, would we benefit from using it?"), groupEvent(2, "I told you in this group?")];
  const { result, lines } = await quietly(() => eventsForTexts(ask(TEXTS_EVENTS_PATH, { ledger: GROUP_KEY, chat: "group-1", events }), {}, { ledger }));
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).written, events.map((event) => event.id));
  assert.equal(appended.length, 1);
  assert.equal(appended[0].key, GROUP_KEY);
  assert.equal(appended[0].chat, GROUP_KEY);
  assert.deepEqual(appended[0].entries.map((entry) => [entry.kind, entry.eid, entry.text]), events.map((event) => ["text", event.id, event.text]));
  // Counts only in the log, never a word of the chat.
  assert.ok(lines.every((line) => !line.includes("Instinct") && !line.includes("told you")));
});

test("the quiet write never opens a ledger, refuses what /agent/events refuses, and says when the ledger fails", async () => {
  const appended = [];
  const empty = () => ({ read: async () => ({ entries: [] }), append: async (...args) => appended.push(args) });
  // A chat with no ledger (one Tex is not set up in): nothing written, the events wait for a turn.
  const none = await eventsForTexts(ask(TEXTS_EVENTS_PATH, { ledger: GROUP_KEY, chat: "group-1", events: [groupEvent(1, "hi")] }), {}, { ledger: empty });
  assert.equal(none.status, 404);
  assert.equal(appended.length, 0);
  const kept = () => ({ read: async () => ({ entries: [textEntry(1, "earlier")] }), append: async (...args) => appended.push(args) });
  const bad = [
    {},
    { ledger: GROUP_KEY, chat: "group-1" },
    { ledger: "x", chat: "group-1", events: [groupEvent(1, "hi")] },
    { ledger: GROUP_KEY, chat: "a b", events: [groupEvent(1, "hi")] },
    // An event of another chat, or one with a field the log does not take, is refused whole.
    { ledger: GROUP_KEY, chat: "group-1", events: [{ ...groupEvent(1, "hi"), chat: "group-2" }] },
    { ledger: GROUP_KEY, chat: "group-1", events: [{ ...groupEvent(1, "hi"), secret: "x" }] },
  ];
  for (const payload of bad) assert.equal((await eventsForTexts(ask(TEXTS_EVENTS_PATH, payload), {}, { ledger: kept })).status, 400);
  assert.equal(appended.length, 0);
  const down = () => ({ read: async () => ({ entries: [textEntry(1, "earlier")] }), append: async () => { throw new Error("down"); } });
  const { result } = await quietly(() => eventsForTexts(ask(TEXTS_EVENTS_PATH, { ledger: GROUP_KEY, chat: "group-1", events: [groupEvent(1, "hi")] }), {}, { ledger: down }));
  assert.equal(result.status, 503);
  // Mounted on the binding's entrypoint: a bad key there is refused by this route, not opened as a texts session.
  const viaEntry = await TexTexts.fetch(ask(TEXTS_EVENTS_PATH, { ledger: "not-a-key", chat: "group-1", events: [] }), {}, {});
  assert.equal(viaEntry.status, 400);
});

test("the judge is told what Tex is doing now: running jobs by title, never a finished one", async () => {
  const job = (at, job, state, title) => ({ v: 1, id: `j${at}`, at: T0 - at, kind: "job", job, state, ...(title ? { title } : {}) });
  // Newest first, as the ledger reads.
  const entries = [job(1_000, "a", "keep_going"), job(2_000, "b", "done", "Old report"), job(3_000, "a", "started", "Find a \"quiet\" venue"), job(4_000, "b", "started", "Old report")];
  const store = { read: async (_key, options) => (assert.deepEqual(options.kinds, ["job"]), { entries }) };
  const facts = await nowFacts(store, GROUP_KEY, { now: T0 });
  assert.equal(facts.length, 1);
  assert.match(facts[0], /^Tex is working on a job in this chat: "Find a  quiet  venue", started \d\d:\d\d UTC\.$/);
  // A slow or missing ledger gives no facts, never a slower verdict.
  assert.deepEqual(await nowFacts({ read: () => new Promise(() => {}) }, GROUP_KEY, { timeoutMs: 5 }), []);
  assert.deepEqual(await nowFacts(null, GROUP_KEY), []);
});

test("what Tex is doing reaches the judge's state for a group decide", async () => {
  let seen = "";
  const engine = async (state) => ((seen = state), { act: { choice: "quiet", confidence: 0.8 } });
  const ledger = () => ({ read: async () => ({ entries: [{ v: 1, id: "j1", at: Date.now() - 1_000, kind: "job", job: "a", state: "started", title: "Plan the trip" }] }), append: async () => {} });
  await decideForTexts(ask(TEXTS_DECIDE_PATH, groupBody()), {}, { engine, ledger, waitUntil: () => {} });
  assert.match(seen, /<now>\nTex is working on a job in this chat: "Plan the trip"/);
});

test("the judge is told which conversations are open, by title and newest lines, never a finished one (Dev2, 2026-11-12)", async () => {
  const thread = (at, id, status, title, texts) => ({ v: 1, id: `th${at}`, at: T0 - at, kind: "thread", thread: id, status, title, description: "words never shown", texts });
  const reads = [];
  const store = {
    read: async (chat, options) => {
      reads.push({ chat, kinds: options.kinds });
      if (chat.endsWith(".threads")) return { entries: [thread(1_000, "t2", "open", "Quiz for Tex", [id(5), id(6), id(7)]), thread(2_000, "t1", "finished", "Dinner plans", [id(1)]), thread(3_000, "t1", "open", "Dinner plans", [id(1)])] };
      return { entries: [] };
    },
  };
  const facts = await nowFacts(store, GROUP_KEY, { now: T0 });
  assert.deepEqual(facts, [`Open conversation "Quiz for Tex", its newest lines <${id(6)}> <${id(7)}>.`]);
  assert.deepEqual(reads.map((read) => read.chat).sort(), [GROUP_KEY, GROUP_KEY, GROUP_KEY, `${GROUP_KEY}.threads`]);
  assert.ok(!facts.join("").includes("words never shown"));
});

test("the judge is told the names the chat gave its guests, the newest per guest (Dev2, 2026-11-12)", async () => {
  const name = (at, guest, said) => ({ v: 1, id: `name${at}`, at: T0 - at, kind: "name", guest, name: said, text: `${guest} is ${said}` });
  const store = {
    read: async (chat, options) => (options.kinds?.includes("name") ? { entries: [name(1, "guest-6ce3", "Boba"), name(2, "guest-66ef", "Instinct"), name(3, "guest-6ce3", "Instinct")] } : { entries: [] }),
  };
  const facts = await nowFacts(store, GROUP_KEY, { now: T0 });
  assert.deepEqual(facts, ["People here known by a guest label, by name: guest-6ce3 is Boba; guest-66ef is Instinct."]);
});
