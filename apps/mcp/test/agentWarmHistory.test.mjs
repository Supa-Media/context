/**
 * TEX'S HISTORY COMES ONLY FROM THE WARM COPY (`src/agent/warmCopy.js`).
 *
 * 2026-10-31 16:57 UTC: a one-to-one text read 150 exchange files
 * (`.context/agent/events/`) one at a time before its model, 7 s, though the
 * texting line held a copy of that history. Every person's text after a job's
 * report re-read them: the report turn names no texts, so it never read the
 * chat's log, and the copy it handed back left the chat out. And every write
 * to the history the copy's turns didn't make (a routine's text, a check-in,
 * the Worker's fixed texts, a yes the gateway settled) dropped the copy.
 *
 * Seyi: "the saved copy needs to be the only source of truth", and "if it
 * falls behind that's a bigger issue". So every write reaches the copy: one
 * made in the turn's own request is added to it there (`writes`), and one made
 * by a routine or a check-in is handed back sealed for the person's texting
 * turn (`sealBeside`), kept by the Worker and added by the next text.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `chatRead?.events !== undefined` put back into `seal`'s condition: "a
 *    job's report hands the history on" and "the text after a job's report
 *    reads no history" fail;
 *  - `withWrites` dropped from `history` (the request's writes left out):
 *    "a write this request made is in the history" fails;
 *  - `beside` dropped from the runner's answer in `route.js`: "a routine's
 *    write reaches the next text's copy" fails;
 *  - the texting client dropped from `sealBeside`'s session (sealed for the
 *    routine's own): "sealed for the person's texting turn alone" fails;
 *  - `writes !== null` dropped from the copy's chat: the same test fails (a
 *    copy handed a write it can't open is used, behind).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { openBeside, openWarm, sealBeside, sealWarm, warmTurn, withWrites } from "../src/agent/warmCopy.js";
import { TOLD } from "../src/agent/conversation.js";

const env = { GATEWAY_SECRET: "a-test-secret-of-some-length" };
const session = { workspaceId: "ws_1", actorUserId: "user_1", actorClientId: "context_texts" };
const CHAT = "sendblue:line:+15555550100";

/** The history's exchange keys read (GET and list) while `run` runs, before its model is asked (after the reply, a memory nudge reads a few on its own). */
async function historyReadsDuring(world, run) {
  const asked = world.model.requests.length;
  const inner = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const key = decodeURIComponent(url.pathname) + (url.searchParams.get("prefix") ?? "");
    if ((method === "GET" || method === "HEAD") && key.includes(".context/agent/events/") && world.model.requests.length === asked) reads.push(key);
    if (method === "PUT") written.add(key);
    return inner(input, init);
  };
  const written = new Set();
  try {
    const result = await run();
    return { result, reads: reads.filter((key) => !written.has(key)) }; // a write checks its own new key first: that is no read of the history
  } finally {
    globalThis.fetch = inner;
  }
}

let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

test("a job's report hands the history on, though it read no log", async () => {
  const now = Date.now();
  const history = [{ role: "user", text: "hi Tex", id: "0000000000001-aaaa", at: 1 }, { role: "assistant", text: "Hey." }];
  const hot = warmTurn(env, session, {}, { eligible: true, now });
  await hot.history(async () => history);
  const opened = await openWarm(env, session, await hot.seal({}), now);
  assert.deepEqual(opened.chat.history, history);
  assert.equal(opened.chat.events, undefined, "a log it didn't read is never carried");
  // The next turn reads the log (or the Worker holds it) and takes the history from the copy.
  const next = warmTurn(env, session, { warm: await sealWarm(env, session, { v: 1, chat: opened.chat }) }, { eligible: true, now });
  assert.deepEqual(await next.history(async () => assert.fail("the history is the copy's")), history);
  assert.deepEqual(await next.events(CHAT, async () => ["read"]), [], "no events in the copy: the log is read");
});

const write = (at, question, answer, fields = {}) => ({ question, answer, at, id: `${String(9_999_999_999_999 - at).padStart(13, "0")}-${fields.tag ?? "t" + at}`, tainted: false, tools: [], sources: [], thread: null, theirs: false, ...fields });

test("a write this request made is in the history, and in the copy it hands back", async () => {
  const now = Date.now();
  const held = [{ role: "user", text: "hi Tex", id: write(1_000, "", "").id, at: 1_000 }, { role: "assistant", text: "Hey." }];
  const writes = [];
  const hot = warmTurn(env, session, { warm: await sealWarm(env, session, { v: 1, chat: { at: now, history: held } }) }, { eligible: true, now, writes: () => writes });
  writes.push(write(2_000, "(fixed text)", TOLD.setup));
  const history = await hot.history(async () => assert.fail("the history is the copy's"));
  assert.deepEqual(history.map((turn) => turn.text), ["hi Tex", "Hey.", "(fixed text)", TOLD.setup]);
  writes.push(write(3_000, "yes", "Sent."));
  const opened = await openWarm(env, session, await hot.seal({ wrote: true }), now);
  assert.deepEqual(opened.chat.history.map((turn) => turn.text), ["hi Tex", "Hey.", "(fixed text)", TOLD.setup, "yes", "Sent."], "a yes the gateway settled reads no history and still reaches the copy");
});

test("writes are placed by when they happened, each once", () => {
  const history = [{ role: "user", text: "a", id: write(1_000, "", "").id, at: 1_000 }, { role: "assistant", text: "A" }, { role: "user", text: "c", id: write(3_000, "", "").id, at: 3_000 }, { role: "assistant", text: "C" }];
  const b = write(2_000, "b", "B");
  assert.deepEqual(withWrites(history, [b, b, write(1_000, "a", "A")]).map((turn) => turn.text), ["a", "A", "b", "B", "c", "C"]);
  assert.equal(withWrites(history, []), history);
  assert.equal(withWrites(history, [{ question: "no id", answer: "x", at: 5 }]), history, "a write that isn't one is left out");
});

test("a write beside the copy is sealed for the person's texting turn alone", async () => {
  const routine = { ...session, actorClientId: "context_routines" };
  const sealed = await sealBeside(env, routine, [write(2_000, "(routine)", "Morning!")]);
  assert.match(sealed, /^tw1\./);
  assert.doesNotMatch(sealed, /Morning/);
  assert.deepEqual((await openBeside(env, session, [sealed])).map((one) => one.answer), ["Morning!"]);
  assert.equal(await openBeside(env, { ...session, actorUserId: "user_2" }, [sealed]), null, "never on another person's turn");
  assert.equal(await openBeside(env, session, [sealed, "tw1.junk"]), null, "one that won't open: the copy can't be trusted whole");
  assert.deepEqual(await openBeside(env, session, undefined), []);

  // A copy handed a write it can't open is not used: the history is read whole rather than shown behind.
  const now = Date.now();
  const hot = warmTurn(env, session, { warm: await sealWarm(env, session, { v: 1, chat: { at: now, history: [] } }), beside: ["tw1.junk"] }, { eligible: true, now });
  assert.equal(await hot.history(async () => "read whole"), "read whole");
  assert.equal(await sealBeside(env, routine, []), null, "nothing written, nothing handed back");
});

test("the text after a job's report reads no history, nor one after a routine's text or a fixed text", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const first = event(now - 9_000, { text: "hi Tex" });
    world.model.install([{ text: "Hey Seyi." }]);
    const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi Tex", conversation: "texts", covers: [first.id], chat: CHAT, recent: [first], turn: "turn-hist-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));

    // A job reports to the chat's own turn: no texts named, so no log read.
    world.model.install([{ text: "Your application is drafted." }]);
    const report = await request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", event: "job_report", jobReport: { title: "Application", state: "done", texts: ["Drafted every answer."] }, chat: CHAT, recent: [first], turn: "turn-hist-0002", warm: one.body.warm });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.match(report.body.warm, /^tw1\./);

    const second = event(now - 1_000, { text: "what did you say?" });
    world.model.install([{ text: "That it's drafted." }]);
    const two = await historyReadsDuring(world, () => request(world.env, TOKEN_TEXTS, "/agent", { question: "what did you say?", conversation: "texts", covers: [second.id], chat: CHAT, recent: [first, second], turn: "turn-hist-0003", warm: report.body.warm }));
    assert.equal(two.result.status, 200, JSON.stringify(two.result.body));
    assert.deepEqual(two.reads, [], "the history came from the copy the report handed on");
    assert.match(JSON.stringify(world.model.requests.at(-1).messages), /hi Tex/);

    // A routine texts them: what it wrote to their texts comes back sealed, and the next text adds it to the copy.
    world.model.install([{ text: "Nothing changed since yesterday." }]);
    const routine = await request(world.env, TOKEN_ROUTINE, "/agent", { routine: { path: "routines/daily/brief.md" } });
    assert.equal(routine.status, 200, JSON.stringify(routine.body));
    assert.match(routine.body.beside ?? "", /^tw1\./, "a routine's write reaches the next text's copy");
    world.model.install([{ text: "Glad it's quiet." }]);
    const three = await historyReadsDuring(world, () => request(world.env, TOKEN_TEXTS, "/agent", { question: "good to know", conversation: "texts", turn: "turn-hist-0004", warm: two.result.body.warm, beside: [routine.body.beside], told: ["setup"] }));
    assert.equal(three.result.status, 200, JSON.stringify(three.result.body));
    assert.deepEqual(three.reads, [], "the routine's text and the fixed text came with the copy, nothing read");
    const shown = JSON.stringify(world.model.requests.at(-1).messages);
    assert.match(shown, /Nothing changed since yesterday\./);
    assert.ok(shown.includes(TOLD.setup.slice(0, 40)), "the Worker's fixed text is in the history");
  } finally {
    world.restore();
  }
});
