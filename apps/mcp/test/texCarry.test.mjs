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
 *  6. `stretch.js` replaying a result whatever grant read it, or a stubbed call's arguments → "another grant".
 *  5. `turn.js` mapping history turns to `{role, text}` only → "carries text 1's".
 *  7. `stretch.js` `sharedHomeRead` returning false → "the chat's home"; returning true for any note read, or for
 *     a mail read → "private reads"; true with no home or for a path beside it → "unclear".
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, textTex, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { gatewayBody, CONTEXT_BETA } from "../src/agent/aiGateway.js";
import { STUB_GRANT, STUB_OTHER, STUB_OUTSIDE, STUB_WITHHELD, sharedHomeRead, stretchSince, stretchTurns } from "../src/agent/stretch.js";

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
const tool = (turn, at, extra = {}) => ({ kind: "tool", seq: at, at, id: `t${at}`, turn, name: "read_note", args: { path: "a.md" }, ok: true, result: "secret plans", grant: "grant_1", ...extra });
const G = { grant: "grant_1" };
const A = "a".repeat(64);
const B = "b".repeat(64);

test("the stretch is the run with no gap over an hour", () => {
  assert.equal(stretchSince([text("1", 0, A, "x"), text("2", 2 * H, A, "y"), reply("t", 2 * H + 5)]), 2 * H);
  assert.equal(stretchSince([text("1", 0, A, "x"), text("2", H - 1, A, "y")]), 0);
  assert.equal(stretchSince([]), null);
});

test("a turn that read from outside is carried with its results stubbed", () => {
  const entries = [text("1", 10, A, "read the page"), tool("t1", 11), text("2", 12, "tex", "It says hi", "t1"), reply("t1", 13, false)];
  const turns = stretchTurns(entries, [tool("t1", 11)], { since: 0, ...G });
  assert.equal(turns[1].calls[0].result, STUB_OUTSIDE);
  assert.deepEqual(turns[1].calls[0].args, {}, "a stubbed call keeps no arguments");
  const clean = stretchTurns([...entries.slice(0, 3), reply("t1", 13, true)], [tool("t1", 11)], { since: 0, ...G });
  assert.equal(clean[1].calls[0].result, "secret plans");
});

test("a group: another member's reads are stubbed, the asker's own are carried", () => {
  const entries = [text("1", 10, A, "what's in my notes?"), text("2", 12, "tex", "Plans.", "t1"), reply("t1", 13)];
  const other = stretchTurns(entries, [tool("t1", 11)], { since: 0, group: true, asker: B, ...G })[1].calls[0];
  assert.equal(other.result, STUB_OTHER);
  assert.deepEqual(other.args, {}, "another member's query is not carried either");
  assert.equal(stretchTurns(entries, [tool("t1", 11)], { since: 0, group: true, asker: A, ...G })[1].calls[0].result, "secret plans");
  assert.equal(stretchTurns(entries, [tool("t1", 11)], { since: 0, group: true, asker: null, ...G })[1].calls[0].result, STUB_OTHER, "an unknown asker is someone else");
});

test("another workspace's read is never carried, and the call keeps a stable id", () => {
  const entries = [text("1", 10, A, "q"), text("2", 12, "tex", "a", "t1"), reply("t1", 13)];
  const [, answer] = stretchTurns(entries, [tool("t1", 11, { withheld: "other_workspace", result: undefined })], { since: 0, ...G });
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

test("a result read under another grant, or none recorded, is stubbed, arguments and all", () => {
  const entries = [text("1", 10, A, "q"), text("2", 12, "tex", "a", "t1"), reply("t1", 13)];
  const narrower = stretchTurns(entries, [tool("t1", 11)], { since: 0, grant: "grant_2" })[1].calls[0];
  assert.equal(narrower.result, STUB_GRANT);
  assert.deepEqual(narrower.args, {});
  assert.equal(stretchTurns(entries, [tool("t1", 11, { grant: undefined })], { since: 0, ...G })[1].calls[0].result, STUB_GRANT, "an entry with no grant");
  assert.equal(stretchTurns(entries, [tool("t1", 11)], { since: 0 })[1].calls[0].result, STUB_GRANT, "a turn with no grant");
  const same = stretchTurns(entries, [tool("t1", 11)], { since: 0, ...G })[1].calls[0];
  assert.equal(same.result, "secret plans");
  assert.deepEqual(same.args, { path: "a.md" });
});

// Dev2, 2026-11-10: the chat's own home carries for every member; a member's private reads stay theirs.
const HOME = "tex/groups/blue-river";
const asked = [text("1", 10, A, "what did we plan?"), text("2", 12, "tex", "The picnic.", "t1"), reply("t1", 13)];
const forBo = (entry, home = HOME) => stretchTurns(asked, [entry], { since: 0, group: true, asker: B, grant: "grant_bo", home })[1].calls[0];

test("a group: a read of the chat's home by Ada carries for Bo, under Bo's own grant", () => {
  const shared = forBo(tool("t1", 11, { args: { path: `${HOME}/about.md`, context: "@context-lc" }, result: "We are the river club.", grant: "grant_ada" }));
  assert.equal(shared.result, "We are the river club.");
  assert.deepEqual(shared.args, { path: `${HOME}/about.md`, context: "@context-lc" });
  assert.equal(forBo(tool("t1", 11, { name: "list_notes", args: { prefix: HOME }, grant: "grant_ada" })).result, "secret plans", "the home folder itself");
  assert.equal(forBo(tool("t1", 11, { args: { path: `${HOME}/about.md` }, grant: undefined })).result, STUB_GRANT, "still never under no grant recorded");
});

test("a group: Ada's private reads stay stubbed for Bo, arguments and all", () => {
  for (const entry of [
    tool("t1", 11, { name: "read_email", args: { id: "m1", context: "@context-lc" }, grant: "grant_ada" }),
    tool("t1", 11, { name: "search_email", args: { query: "rent", prefix: HOME }, grant: "grant_ada" }),
    tool("t1", 11, { name: "calendar_events", args: { prefix: HOME }, grant: "grant_ada" }),
    tool("t1", 11, { args: { path: `${HOME}/about.md`, mail: true }, grant: "grant_ada" }),
  ]) {
    const call = forBo(entry);
    assert.equal(call.result, STUB_OTHER, entry.name);
    assert.deepEqual(call.args, {}, `${entry.name} keeps no arguments`);
  }
});

test("a group: a read whose scope is unclear is stubbed", () => {
  for (const [args, home] of [
    [{ path: `${HOME}/about.md` }, null],
    [{ path: "tex/groups/blue-riverbank/about.md" }, HOME],
    [{ path: `${HOME}/../other-chat/about.md` }, HOME],
    [{ path: "notes/plans.md" }, HOME],
    [{}, HOME],
    [{ path: `${HOME}/about.md`, context: "@shared-team" }, HOME],
  ]) assert.equal(forBo(tool("t1", 11, { args, grant: "grant_ada" }), home).result, STUB_OTHER, JSON.stringify(args));
  assert.equal(forBo(tool("t1", 11, { args: { query: "picnic" }, name: "search_notes", grant: "grant_ada" })).result, STUB_OTHER, "a search with no folder");
  assert.equal(sharedHomeRead(tool("t1", 11, { args: { path: `${HOME}/a.md` }, withheld: "other_workspace" }), HOME), false, "another workspace's");
});
