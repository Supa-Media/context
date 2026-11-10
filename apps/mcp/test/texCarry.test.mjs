/**
 * Tex carries the tool calls and results of the chat's current stretch into the next text (owner-approved, Dev2,
 * 2026-11-10, 80/20 step 4; `src/agent/stretch.js`), so a follow-up reuses what it already looked up.
 *
 * Through the real `/agent` route, with the texts named as the Worker names them (`covers`, the rendered-log path
 * production takes): text 2 carries text 1's `tool_use` and `tool_result`; a gap over an hour drops them; the
 * prefix up to the history's end stays the same bytes from one text to the next. Then the stubs, on `stretchTurns`:
 * a turn that read from outside, another group member's reads, another workspace's.
 *
 * Sabotage these and a test here fails:
 *  1. `stretch.js` `STRETCH_GAP_MS` raised to a day → "an hour quiet".
 *  2. `stretch.js` dropping the `turn.tainted` stub → "a turn that read from outside".
 *  3. `stretch.js` replaying another member's results (`other` forced false) → "a group".
 *  4. `loggedTurn.js` rendering the stretch into the log block too (`all` unfiltered) → "byte-stable".
 *  5. `turn.js` mapping history turns to `{role, text}` only → "carries text 1's".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, textTex, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { gatewayBody, CONTEXT_BETA } from "../src/agent/aiGateway.js";
import { STUB_OTHER, STUB_OUTSIDE, STUB_WITHHELD, stretchSince, stretchTurns } from "../src/agent/stretch.js";

let world;
const realNow = Date.now;
let offset = 0;
before(async () => {
  world = await createEgressWorld();
  Date.now = () => realNow() + offset;
});
after(() => {
  Date.now = realNow;
  world.restore();
});

const blocks = (request) => (request?.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content.map((block) => ({ role: message.role, ...block })) : []));
const unmarked = (value) => JSON.parse(JSON.stringify(value), (key, inner) => (key === "cache_control" ? undefined : inner));

test("text 2 carries text 1's tool_use and tool_result; the prefix is byte-stable; an hour quiet drops them", async () => {
  offset = -(3_600_000 + 20 * 60_000);
  world.bucket.set("1-projects/venue.md", { body: "# Venue\n\nThe hall on Elm St, doors at 6.\n", etag: "v1" });
  world.model.install([{ toolCalls: [{ name: "search_notes", args: { query: "venue" } }] }, { text: "The hall on Elm St." }]);
  await textTex(world.env, TOKEN_TEXTS, "where is the venue?");
  const firstTurn = world.model.requests.length;

  offset += 5 * 60_000;
  world.model.install([{ text: "Doors at 6." }]);
  await textTex(world.env, TOKEN_TEXTS, "and when do doors open?");
  const second = world.model.requests.at(-1);
  const uses = blocks(second).filter((block) => block.type === "tool_use");
  const results = blocks(second).filter((block) => block.type === "tool_result");
  assert.equal(uses.length, 1, "text 1's call is carried");
  assert.equal(uses[0].name, "search_notes");
  assert.deepEqual(uses[0].input, { query: "venue" });
  assert.equal(results[0].tool_use_id, uses[0].id, "its result answers the same call");
  assert.match(String(results[0].content), /venue/i);
  assert.ok(world.model.requests.length > firstTurn);
  // Every carried turn ends on its reply, so the new text is a turn of its own.
  assert.equal(second.messages.at(-2).role, "assistant");
  assert.match(JSON.stringify(second.messages.at(-2)), /The hall on Elm St/);
  assert.deepEqual(second.context_management?.edits?.[0]?.type, "clear_tool_uses_20250919");

  offset += 5 * 60_000;
  world.model.install([{ text: "Yes." }]);
  await textTex(world.env, TOKEN_TEXTS, "is parking free?");
  const third = world.model.requests.at(-1);
  const history = second.messages.slice(0, -1);
  assert.ok(JSON.stringify(history.at(-1)).includes('"ttl":"1h"'), "the history ends on the hour mark");
  assert.deepEqual(unmarked(third.messages.slice(0, history.length)), unmarked(history), "the next text starts with this text's history, byte for byte");
  assert.deepEqual(third.tools, second.tools);
  assert.deepEqual(third.system, second.system);

  offset = 0; // over an hour after the third text (the grant would expire on a clock moved forward)
  const before = world.model.requests.length;
  world.model.install([{ text: "Sure." }]);
  await textTex(world.env, TOKEN_TEXTS, "who is catering?");
  assert.equal(world.model.requests.length, before + 1, "the fourth text reached the model");
  const fresh = world.model.requests.at(-1);
  assert.equal(blocks(fresh).filter((block) => block.type === "tool_use" || block.type === "tool_result").length, 0, "an hour quiet: words only");
  assert.match(JSON.stringify(fresh.messages), /Elm St/, "the words are still there, in the log");
});

const H = 3_600_000; // the hour, written out: a test that read the constant would move with it
const text = (id, at, who, words, turn) => ({ kind: "text", seq: at, at, eid: id, id: `ev${id}`, event: "text", from: who === "tex" ? { kind: "tex" } : { kind: "person", who }, text: words, ...(turn ? { turn, delivered: true } : {}) });
const reply = (turn, at, clean = true) => ({ kind: "reply", seq: at, at, turn, clean });
const tool = (turn, at, extra = {}) => ({ kind: "tool", seq: at, at, id: `t${at}`, turn, name: "read_note", args: { path: "a.md" }, ok: true, result: "secret plans", ...extra });
const A = "a".repeat(64);
const B = "b".repeat(64);

test("the stretch is the run with no gap over an hour", () => {
  assert.equal(stretchSince([text("1", 0, A, "x"), text("2", 2 * H, A, "y"), reply("t", 2 * H + 5)]), 2 * H);
  assert.equal(stretchSince([text("1", 0, A, "x"), text("2", H - 1, A, "y")]), 0);
  assert.equal(stretchSince([]), null);
});

test("a turn that read from outside is carried with its results stubbed", () => {
  const entries = [text("1", 10, A, "read the page"), tool("t1", 11), text("2", 12, "tex", "It says hi", "t1"), reply("t1", 13, false)];
  const turns = stretchTurns(entries, [tool("t1", 11)], { since: 0 });
  assert.equal(turns[1].calls[0].result, STUB_OUTSIDE);
  const clean = stretchTurns([...entries.slice(0, 3), reply("t1", 13, true)], [tool("t1", 11)], { since: 0 });
  assert.equal(clean[1].calls[0].result, "secret plans");
});

test("a group: another member's reads are stubbed, the asker's own are carried", () => {
  const entries = [text("1", 10, A, "what's in my notes?"), text("2", 12, "tex", "Plans.", "t1"), reply("t1", 13)];
  assert.equal(stretchTurns(entries, [tool("t1", 11)], { since: 0, group: true, asker: B })[1].calls[0].result, STUB_OTHER);
  assert.equal(stretchTurns(entries, [tool("t1", 11)], { since: 0, group: true, asker: A })[1].calls[0].result, "secret plans");
  assert.equal(stretchTurns(entries, [tool("t1", 11)], { since: 0, group: true, asker: null })[1].calls[0].result, STUB_OTHER, "an unknown asker is someone else");
});

test("another workspace's read is never carried, and the call keeps a stable id", () => {
  const entries = [text("1", 10, A, "q"), text("2", 12, "tex", "a", "t1"), reply("t1", 13)];
  const [, answer] = stretchTurns(entries, [tool("t1", 11, { withheld: "other_workspace", result: undefined })], { since: 0 });
  assert.equal(answer.calls[0].result, STUB_WITHHELD);
  assert.equal(answer.calls[0].id, "toolu_t11");
});

test("context editing rides only on a texted turn's body, with its beta named", () => {
  const messages = [{ role: "user", text: "hi" }];
  assert.ok(gatewayBody({ model: "anthropic/claude-sonnet-5", system: "s", messages, tools: [], cachedThrough: 0 }).context_management);
  assert.equal(gatewayBody({ model: "anthropic/claude-sonnet-5", system: "s", messages, tools: [] }).context_management, undefined);
  assert.equal(CONTEXT_BETA, "context-management-2025-06-27");
});

test("a 400 naming context_management is sent once more without it, beta header and all, and remembered", async () => {
  const { requestViaGateway, resetContextEdits } = await import("../src/agent/aiGateway.js");
  resetContextEdits();
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ body, beta: init.headers["anthropic-beta"] ?? null });
    if (body.context_management) return new Response('{"error":{"message":"context_management: Extra inputs are not permitted"}}', { status: 400 });
    return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} });
  };
  const call = { model: "anthropic/claude-sonnet-5", system: "s", messages: [{ role: "user", text: "hi" }], tools: [], cachedThrough: 0 };
  const config = { url: "https://gateway.example.invalid/v1/messages", token: "t", creditKey: null };
  assert.equal((await requestViaGateway(call, config, { fetchImpl, wait: async () => {} })).text, "ok");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].beta, CONTEXT_BETA);
  assert.equal(sent[1].beta, null);
  assert.equal(sent[1].body.context_management, undefined);
  await requestViaGateway(call, config, { fetchImpl, wait: async () => {} });
  assert.equal(sent.length, 3, "remembered: the next body goes without it");
  resetContextEdits();
});
