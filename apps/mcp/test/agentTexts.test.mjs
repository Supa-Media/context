/**
 * TEX READS THE PERSON'S OWN TEXTS — the Mac's Messages backup
 * (`docs/decisions/communications/messages-backup.md`), reached from a 1:1 Tex
 * turn through `search { texts: true }` and `fetch texts:<id>`.
 *
 * Dev2, 2026-11-05: "if I say like, hey, look at the thing this person sent
 * me, it's able to find it." The backup and its tools existed, but the tools
 * are unlisted on the MCP, so the v1 list a Tex turn starts from dropped them,
 * and `fetch texts:` in Tex meant its own chat history. These checks drive
 * `/agent` end to end with a scripted model over a real (node:sqlite) index.
 *
 * Sabotage record (temporary local edits, reverted):
 *   the Tex turn not asking for texts (`checkItMayRun`, the old list)       1
 *   `resolve` routing every `texts:` id to earlier_texts                     1
 *   `grantedToolsFor` not asking `store.texts` (cleared or not)              1
 *     (the team-grant turn still passes: the scope filter holds them back too)
 *   `searchTool` returning the base description                              1
 *
 * Fake names, numbers and credentials only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_PLANE_ORIGIN,
  DESCRIPTOR,
  GATEWAY_SECRET,
  S3_ENDPOINT,
  createControlPlaneStub,
  createD1Backend,
  createS3Backend,
  createWorkerCtx,
  s3Binding,
  worker,
} from "./searchProjection/fixtures.mjs";
import { DECISION_MODEL } from "../src/agent/decide.js";
import { grantedToolsFor, sixToolsOver } from "../src/agent/sixTools.js";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const tok = (name) => `cat_agtexts_${name}_`.padEnd(40, "0");
const T = { mac: tok("mac"), tex: tok("tex"), texTeam: tok("texteam") };

const BATCH = {
  v: 1,
  records: [
    { v: 1, kind: "chat", id: "chat-ada", members: ["+15550100100"], service: "iMessage" },
    { v: 1, kind: "person", handle: "+15550100100", name: "Ada Example" },
    { v: 1, kind: "message", id: "m-1", chat: "chat-ada", at: "2026-11-04T09:00:00.000Z", me: false, from: "+15550100100", text: "the venue deposit is due Friday", service: "iMessage" },
    { v: 1, kind: "message", id: "m-2", chat: "chat-ada", at: "2026-11-04T09:05:00.000Z", me: true, text: "thanks, on it", service: "iMessage" },
  ],
};

function fakeAi() {
  const calls = [];
  let script = [];
  return {
    calls,
    install(replies) {
      script = [...replies];
    },
    async run(model, input) {
      if (model === DECISION_MODEL) return { answers: { answered: { type: "noul", noul: 0.9 } } };
      calls.push({ model, input });
      const next = script.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      return next;
    },
  };
}

function chat(text, toolCalls = []) {
  return {
    choices: [{ message: { content: text, tool_calls: toolCalls.map((call, i) => ({ id: `call_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

async function setUp() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), d1.install(), controlPlane.install()];
  controlPlane.addWorkspace("ws_agt_mine", "agtmine", s3Binding("agt-mine", { ...DESCRIPTOR, state: "ready" }));
  const all = ["context:read", "context:write", "context:private"];
  const grant = (accessToken, scopes, clientId) => controlPlane.addGrant({ accessToken, workspaceId: "ws_agt_mine", role: "owner", scopes, clientId, clientName: clientId, userId: "user_agt" });
  await grant(T.mac, all, "context_desktop");
  await grant(T.tex, all, "context_texts");
  await grant(T.texTeam, ["context:read", "context:write"], "context_texts");
  controlPlane.setBuiltinVerdict("ws_agt_mine", { allowed: true, remaining: 50 });
  const ai = fakeAi();
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET, AI: ai };
  controlPlane.serveTreesFrom(env, { s3 });
  return {
    env,
    ai,
    restore: () => {
      for (const restore of restores.reverse()) restore();
      d1.close();
    },
  };
}

async function request(world, token, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://gateway.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    world.env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: response.status, body: parsed };
}

const toolReplies = (call) => (call?.input?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content).join("\n");
const offeredTool = (call, name) => (call?.input?.tools ?? []).map((tool) => tool.function ?? tool).find((tool) => tool.name === name);

test("1:1 Tex finds what a person texted them, and reads the conversation around it", async () => {
  const world = await setUp();
  try {
    assert.equal((await request(world, T.mac, "/messages/imessage/batch", BATCH)).status, 200);
    world.ai.install([
      chat("", [{ name: "search", args: { query: "", args: { texts: true, with: "Ada" } } }]),
      chat("", [{ name: "fetch", args: { id: "texts:chat-ada" } }]),
      chat("Ada said the venue deposit is due Friday."),
    ]);
    const answered = await request(world, T.tex, "/agent", { question: "what did Ada send me about the venue?" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body?.answer, "Ada said the venue deposit is due Friday.");
    assert.match(offeredTool(world.ai.calls[0], "search")?.description ?? "", /texts: true/);
    assert.match(offeredTool(world.ai.calls[0], "fetch")?.description ?? "", /texts:<id> reads one of their own text conversations/);
    const searched = toolReplies(world.ai.calls[1]);
    assert.match(searched, /Ada Example: the venue deposit is due Friday/);
    assert.match(searched, /texts:chat-ada/);
    const read = toolReplies(world.ai.calls[2]);
    assert.match(read, /Ada Example: the venue deposit is due Friday/);
    assert.match(read, /you: thanks, on it/);
  } finally {
    world.restore();
  }
});

test("a Tex grant not cleared for texts is not offered them, and its search for them is refused", async () => {
  const world = await setUp();
  try {
    await request(world, T.mac, "/messages/imessage/batch", BATCH);
    world.ai.install([chat("", [{ name: "search", args: { query: "venue", args: { texts: true } } }]), chat("I can't see those.")]);
    const answered = await request(world, T.texTeam, "/agent", { question: "what did Ada send me?" });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.doesNotMatch(offeredTool(world.ai.calls[0], "search")?.description ?? "", /texts: true/);
    assert.doesNotMatch(toolReplies(world.ai.calls[1]), /venue deposit/);
  } finally {
    world.restore();
  }
});

test("only a cleared store and a Tex turn that asks are handed the texts tools", async () => {
  const session = { workspaceKind: "personal", role: "owner", scope: "private", scopes: ["context:read", "context:write", "context:private"] };
  const names = async (store, options) => (await grantedToolsFor(session, store, options)).map((tool) => tool.name);
  const cleared = () => ({ texts: { cleared: true }, readObject: async () => null, get: async () => null });
  assert.ok((await names(cleared(), { texts: true })).includes("search_texts"));
  assert.ok((await names(cleared(), { texts: true })).includes("read_texts"));
  assert.ok(!(await names(cleared())).includes("search_texts"), "a surface that did not ask (a dream, a check-in) is not handed them");
  assert.ok(!(await names({ readObject: async () => null, get: async () => null }, { texts: true })).includes("search_texts"), "an uncleared store is not");
});

test("texts:<id> reads a backed-up conversation where the turn holds them; bare texts: stays this chat's own", () => {
  const tools = ["search_notes", "read_note", "earlier_texts", "search_texts", "read_texts"].map((name) => ({ name, description: `${name}.`, inputSchema: { type: "object" } }));
  const { resolve } = sixToolsOver(tools);
  assert.deepEqual(resolve("fetch", { id: "texts:" }), { name: "earlier_texts", args: {} });
  assert.deepEqual(resolve("fetch", { id: "texts:chat-ada", args: { since: "2026-11-01" } }), { name: "read_texts", args: { chat: "chat-ada", since: "2026-11-01" } });
  assert.equal(resolve("search", { query: "", args: { texts: true, with: "Ada" } }).name, "search_texts");
  const without = sixToolsOver(tools.filter((tool) => !tool.name.endsWith("_texts") || tool.name === "earlier_texts"));
  assert.deepEqual(without.resolve("fetch", { id: "texts:chat-ada" }), { name: "earlier_texts", args: {} });
});
