/**
 * WARMING THE CACHE (Dev2, 2026-11-20, the cache rules: "the cache is warmed when the chat opens or the person starts
 * typing"; node `warm`, on the shelf; `src/agent/warmPrefix.js`, `graph/nodes/warm.js`, `textsWarm.js`,
 * `packages/tex/gateway/texStore/warm.js`). A turn keeps the request its first round sent, cut at the history's end; a read receipt,
 * an open chat or typing sends that prefix again, byte for byte, with a one-token answer.
 * Sabotage: cut at the last mark instead of the first in `keptPrefix` and "the kept prefix is the history" fails; drop
 * `rawBody` in `aiGateway.js` and "sent byte for byte" fails; drop the day check in the node and "another day" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestBuiltin } from "../../../packages/tex/gateway/agent/builtin.js";
import { aiGatewayConfig, requestViaGateway, resetCreditState, resetHourMarks } from "../../../packages/tex/gateway/agent/aiGateway.js";
import { keptPrefix, prefixKeeper, warmRequest, warmWired, WARM_ASK } from "../../../packages/tex/gateway/agent/warmPrefix.js";
import { warmNode, WARM_AGAIN_MS } from "../../../packages/tex/gateway/agent/graph/nodes/warm.js";
import { warmChat, warmForTexts, warmPlace } from "../../../packages/tex/gateway/agent/textsWarm.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { texWarm, WARM_FRESH_MS, MAX_WARM_BYTES } from "../../../packages/tex/gateway/texStore/warm.js";
import { TexObjectRefused } from "../../../packages/tex/gateway/texStore/objects.js";
import { durableSql, texStoreNamespace } from "./texStoreFixture.mjs";
import { ledgerFor } from "../../../packages/tex/gateway/agent/ledger.js";

const MODEL = "anthropic/claude-haiku-5-5";
const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);
const OK = { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 900 } };
const env = () => ({ AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "gw", AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}` });
const HISTORY = [{ role: "user", text: "when is the dentist" }, { role: "assistant", text: "Tuesday at 3." }];

function gateway() {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify(OK), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { sent, fetchImpl };
}

async function aTurn(onSent) {
  resetCreditState();
  resetHourMarks();
  const { sent, fetchImpl } = gateway();
  const tools = [{ name: "search_notes", description: "Search.", inputSchema: { type: "object" } }];
  await requestBuiltin({ model: MODEL, system: { stable: "You are Tex.", context: "About them: likes tea." }, messages: [...HISTORY, { role: "user", text: "move it to Thursday" }], tools, cachedThrough: HISTORY.length }, null, { gateway: aiGatewayConfig(env()), fetchImpl, now: () => NOW, onSent });
  return sent[0];
}

test("the kept prefix is the history: the round's request cut at its first mark, with the same tools and system", async () => {
  let told = null;
  const body = await aTurn((sent) => (told = sent));
  assert.deepEqual(told, body, "told the request as it went");
  const prefix = keptPrefix(body);
  assert.equal(prefix.messages.length, 2);
  assert.deepEqual(prefix.messages, body.messages.slice(0, 2));
  assert.deepEqual(prefix.system, body.system);
  assert.deepEqual(prefix.tools, body.tools);
  assert.equal(keptPrefix({ ...body, messages: body.messages.slice(-1) }), null, "no history: nothing to keep");
  const warm = warmRequest(prefix);
  assert.equal(warm.max_tokens, 1);
  assert.equal(warm.messages.at(-1).content[0].text, WARM_ASK);
  assert.deepEqual(warm.messages.slice(0, 2), body.messages.slice(0, 2));
});

test("a warming request is sent byte for byte, never rebuilt", async () => {
  const body = await aTurn(() => {});
  const { sent, fetchImpl } = gateway();
  resetCreditState();
  const answer = await requestViaGateway({ model: MODEL }, aiGatewayConfig(env()), { rawBody: warmRequest(keptPrefix(body)), fetchImpl });
  assert.deepEqual(sent[0], warmRequest(keptPrefix(body)));
  assert.equal(answer.usage.cacheRead, 900);
});

test("a turn keeps its first round's prefix once, in its chat's home", async () => {
  const kept = [];
  const home = { keepWarm: async (chat, data) => void kept.push({ chat, data }) };
  const keep = prefixKeeper({ store: { texLedger: () => home }, session: { workspaceKind: "personal", workspaceId: "ws_1" }, timeZone: "America/New_York", now: () => NOW, log: () => {} });
  const body = await aTurn(() => {});
  keep({ ...body, messages: body.messages.slice(-1) });
  keep(body);
  keep(body);
  await Promise.resolve();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].chat, "texts");
  assert.equal(kept[0].data.day, "2026-11-20");
  assert.equal(kept[0].data.zone, "America/New_York");
  assert.equal(prefixKeeper({ store: {}, session: { workspaceKind: "personal", workspaceId: "ws_1" } }), null, "no home: nothing kept");
});

test("the chat's home keeps one prefix per chat, fresh two hours past its last use, wiped with the ledger", () => {
  let now = NOW;
  const store = texWarm(durableSql(), { now: () => now });
  const body = { model: "m", messages: [{ role: "user", content: [] }] };
  store.put("texts", { day: "2026-11-20", zone: "UTC", body });
  assert.deepEqual(store.get("texts"), { at: NOW, used: NOW, day: "2026-11-20", zone: "UTC", body });
  assert.equal(store.get("other"), null);
  assert.throws(() => store.put("texts", { day: "x", body }), TexObjectRefused);
  assert.throws(() => store.put("texts", { day: "2026-11-20", body: { messages: [{ text: "x".repeat(MAX_WARM_BYTES) }] } }), TexObjectRefused);
  now += 60_000;
  store.used("texts");
  assert.equal(store.get("texts").used, NOW + 60_000);
  now += WARM_FRESH_MS + 60_001;
  assert.equal(store.get("texts"), null, "stale");
  now = NOW;
  store.put("texts", { day: "2026-11-20", body });
  store.wipe();
  assert.equal(store.get("texts"), null);
});

function fakeHome(kept) {
  const state = { kept, used: [] };
  state.home = { warmOf: async () => state.kept, warmUsed: async (chat) => void state.used.push(chat) };
  return state;
}

test("the node warms a prefix from today not sent in the last 50 minutes, and says why it skips any other", async () => {
  const prefix = { model: "claude-haiku-5-5", messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }] };
  const asked = [];
  const request = async (call, _config, options) => (asked.push({ call, options }), { usage: { input: 3, output: 1, cacheRead: 900, cacheWrite: 0 } });
  const run = (state, now, ask = request) => warmNode({ owner: { person: "ws1" }, chat: "texts", cause: "read" }, { ctx: { env: {}, now: () => now, request: ask, ledgerOf: () => state.home } });
  assert.equal((await run(fakeHome(null), NOW)).why, "nothing kept");
  const kept = { at: NOW, used: NOW, day: "2026-11-20", zone: "UTC", body: prefix };
  assert.equal((await run(fakeHome(kept), NOW + 60_000)).why, "still warm");
  assert.equal((await run(fakeHome(kept), NOW + 86_400_000)).why, "another day");
  const state = fakeHome(kept);
  const warmed = await run(state, NOW + WARM_AGAIN_MS + 1);
  assert.deepEqual(warmed.when, ["warmed"]);
  assert.equal(warmed.usage.cacheRead, 900);
  assert.equal(asked[0].call.model, "anthropic/claude-haiku-5-5");
  assert.deepEqual(asked[0].options.rawBody, warmRequest(prefix));
  assert.equal(asked[0].options.metadata.client, "warm");
  assert.deepEqual(state.used, ["texts"], "marked as sent again");
  const failing = await run(fakeHome(kept), NOW + WARM_AGAIN_MS + 1, async () => { throw new TypeError("boom"); });
  assert.equal(failing.why, "error:TypeError");
  assert.equal((await run({ home: null }, NOW)).why, "no home");
});

test("the kept prefix goes through the chat's own home, never another's", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const body = { model: "m", messages: [] };
  await ledgerFor(env, { person: "ws1" }).keepWarm("texts", { day: "2026-11-20", zone: "UTC", body });
  assert.deepEqual((await ledgerFor(env, { person: "ws1" }).warmOf("texts")).body, body);
  assert.equal(await ledgerFor(env, { person: "ws2" }).warmOf("texts"), null, "another person's home has none of it");
});

test("/texts/warm is off while no config wires node warm, runs it on the chat's home when one does, and refuses a body that names no home", async () => {
  assert.equal(warmWired({ ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.filter((node) => node.id !== "warm") }), false, "on the shelf");
  assert.equal(warmWired({ nodes: [{ id: "warm" }] }), true);
  assert.equal(warmWired({ nodes: [{ id: "warm", on: false }] }), false);
  const post = (body) => new Request("https://gateway/texts/warm", { method: "POST", body: JSON.stringify(body) });
  assert.deepEqual(await warmChat({}, warmPlace({ person: "ws1" }), "read", { config: { nodes: [] } }), { when: ["skip"], why: "off" });
  assert.equal((await warmForTexts(post({ person: "../x", cause: "read" }), {})).status, 400);
  assert.equal((await warmForTexts(post({ person: "ws1", cause: "sneeze" }), {})).status, 400);
  assert.deepEqual(warmPlace({ chat: "a".repeat(64) }), { owner: { chat: "a".repeat(64) }, chat: "a".repeat(64) });
  assert.equal(warmPlace({ chat: "not-a-key" }), null);
  const ran = [];
  const graph = { runNode: async (id, input) => (ran.push({ id, input }), { ran: true, output: { when: ["warmed"], ms: 5 } }) };
  const out = await warmChat({}, warmPlace({ person: "ws1" }), "typing", { graph, config: { nodes: [{ id: "warm" }] } });
  assert.deepEqual(out, { when: ["warmed"], ms: 5 });
  assert.deepEqual(ran, [{ id: "warm", input: { owner: { person: "ws1" }, chat: "texts", cause: "typing" } }]);
});
