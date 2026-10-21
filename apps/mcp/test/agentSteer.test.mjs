/**
 * Steer (`src/agent/steer.js`, Dev 2026-10-19): a text sent while Tex works
 * joins the turn already running, after its next tool round, and the answer
 * names the texts it took so the texting Worker drops them from its queue.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `runTurn` not asking `steer.next()` after a round → "a text sent while
 *     Tex works reaches the model after its tool round".
 *  2. `anthropicMessages` sending the words as a user message of their own →
 *     "steered words ride in the tool results' user message".
 *  3. `handleSteer` taking another client's call → "only the texting Worker
 *     may steer".
 *  4. The route not clearing the turn's folder → "… and the folder is gone".
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { MAX_STEERED, STEER_PREFIX, steerFor, steeredLine } from "../src/agent/steer.js";
import { anthropicMessages } from "../src/agent/providers.js";
import { LOGICAL_DELETE_CONTENT_TYPE } from "../src/store/logicalDelete.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { conversationText } from "./agentConversationFixture.mjs";

const S3_ENDPOINT = "https://s3.example-steer.test";
const TOKEN_TEXTS = `cat_steer_texts_${"0".repeat(24)}`;
const TOKEN_OTHER = `cat_steer_other_${"0".repeat(24)}`;
const TURN = "turn-0000-aaaa";

/* ---------------- the pieces ---------------- */

function memoryStore() {
  const data = new Map();
  return {
    data,
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

const texts = { actorClientId: "context_texts" };

test("a turn takes each text once, oldest first, at most five, and clears only its own folder", async () => {
  const store = memoryStore();
  const steer = steerFor(store, texts, { turn: TURN });
  assert.equal(await steer.next(), null);
  await store.put(`${STEER_PREFIX}${TURN}/2-e2.json`, JSON.stringify({ id: "e2", text: "second" }));
  await store.put(`${STEER_PREFIX}${TURN}/1-e1.json`, JSON.stringify({ id: "e1", text: "first" }));
  await store.put(`${STEER_PREFIX}other-turn-1/1-x.json`, JSON.stringify({ id: "x", text: "not mine" }));
  assert.equal(await steer.next(), steeredLine(["first", "second"]));
  assert.equal(await steer.next(), null, "taken once");
  for (let i = 3; i < 10; i += 1) await store.put(`${STEER_PREFIX}${TURN}/${i}-e${i}.json`, JSON.stringify({ id: `e${i}`, text: `t${i}` }));
  await steer.next();
  assert.equal(steer.taken.length, MAX_STEERED);
  assert.deepEqual(steer.taken, ["e1", "e2", "e3", "e4", "e5"]);
  await steer.clear();
  assert.deepEqual([...store.data.keys()], [`${STEER_PREFIX}other-turn-1/1-x.json`]);
});

test("no steer for a turn the Worker didn't name, or a client that isn't texting", () => {
  const store = memoryStore();
  assert.equal(steerFor(store, texts, {}), null);
  assert.equal(steerFor(store, texts, { turn: "../../x" }), null);
  assert.equal(steerFor(store, { actorClientId: "claude" }, { turn: TURN }), null);
});

test("a group's background job can be steered when its object names the turn", () => {
  // Only a group's job turns are named (`apps/agent/src/jobRun.ts`); its ordinary turns never are.
  const store = memoryStore();
  assert.notEqual(steerFor(store, { actorClientId: "context_texts_group" }, { turn: TURN }), null);
  assert.equal(steerFor(store, { actorClientId: "context_texts_group" }, {}), null);
});

test("steered words ride in the tool results' user message", () => {
  const out = anthropicMessages([
    { role: "user", text: "book a table" },
    { role: "assistant", text: "", toolCalls: [{ id: "t1", name: "fetch", args: {} }] },
    { role: "tool", toolCallId: "t1", name: "fetch", content: "ok" },
    { role: "user", text: "make it Friday" },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[2].role, "user");
  assert.deepEqual(out[2].content.map((block) => block.type), ["tool_result", "text"]);
  assert.equal(out[2].content[1].text, "make it Friday");
  assert.ok(!("pendingTools" in out[2]));
});

/* ---------------- texted turns, end to end ---------------- */

const requests = [];
let script = [];
const controlPlane = createControlPlaneStub();
let bucket;
const restore = [];
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };

function reply(step) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, [name, input]] of (step.calls ?? []).entries()) content.push({ type: "tool_use", id: `toolu_s_${requests.length}_${i}`, name, input });
  return { content, stop_reason: (step.calls ?? []).length > 0 ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
}

async function call(path, body, token = TOKEN_TEXTS) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const json = await response.json().catch(() => null);
  await settle();
  return { status: response.status, body: json };
}

// A deleted object is a tombstone underneath (`src/store/logicalDelete.js`): gone to everything above it.
const steerKeys = () =>
  [...bucket.keys()].filter((key) => key.startsWith(STEER_PREFIX) && bucket.get(key).contentType !== LOGICAL_DELETE_CONTENT_TYPE);

before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  restore.push(controlPlane.install());
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) {
      const body = JSON.parse(init.body);
      const meta = new Headers(init.headers).get("cf-aig-metadata") ?? "";
      if (!/"client":"reflect"/.test(meta)) requests.push(body);
      const step = script.shift() ?? { text: "Done." };
      return new Response(JSON.stringify(reply(step)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });
  controlPlane.addWorkspace("ws_steer", "steerer", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-steer",
    accessKeyId: "AKIAEXAMPLEEXAMPLEST",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEST",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  controlPlane.setBuiltinVerdict("ws_steer", BUILTIN_ALLOWED);
  for (const [accessToken, clientId] of [[TOKEN_TEXTS, "context_texts"], [TOKEN_OTHER, "claude"]]) {
    await controlPlane.addGrant({
      workspaceId: "ws_steer",
      role: "owner",
      userId: "user_steer",
      accessToken,
      scopes: ["context:read", "context:write", "context:private"],
      clientId,
    });
  }
  controlPlane.serveTreesFrom(env, { s3 });
  bucket = s3.bucketFor("tenant-steer");
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  requests.length = 0;
  script = [];
  for (const key of [...bucket.keys()]) bucket.delete(key);
  bucket.set("1-projects/plan.md", { body: "# Plan\n\nThe plan.\n", etag: "n0" });
});

test("only the texting Worker may steer, with a well-formed turn and text", async () => {
  assert.equal((await call("/agent/steer", { turn: TURN, id: "e2", text: "hi" }, TOKEN_OTHER)).status, 403);
  assert.equal((await call("/agent/steer", { turn: "short", id: "e2", text: "hi" })).status, 400);
  assert.equal((await call("/agent/steer", { turn: TURN, id: "e/2", text: "hi" })).status, 400);
  assert.equal((await call("/agent/steer", { turn: TURN, id: "e2", text: "  " })).status, 400);
  assert.deepEqual(steerKeys(), []);
  const ok = await call("/agent/steer", { turn: TURN, id: "e2", text: "make it Friday" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { queued: true });
  assert.equal(steerKeys().length, 1);
});

test("a text sent while Tex works reaches the model after its tool round, is answered with it, and the folder is gone", async () => {
  await call("/agent/steer", { turn: TURN, id: "e2", text: "make it Friday" });
  script = [{ calls: [["fetch", { id: "1-projects/plan.md" }]] }, { text: "Booked for Friday." }];
  const response = await call("/agent", { question: "book us a table", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.steered, ["e2"]);
  assert.ok(!JSON.stringify(requests[0].messages).includes("make it Friday"), "not before the round it arrived during");
  const second = requests[1].messages.at(-1);
  assert.equal(second.role, "user");
  assert.deepEqual(second.content.map((block) => block.type), ["tool_result", "text"]);
  assert.match(second.content[1].text, /make it Friday/);
  assert.match(conversationText(bucket), /make it Friday/, "kept in the conversation with its turn");
  assert.deepEqual(steerKeys(), []);
});

test("a turn with no tool round takes nothing, and what was sent is answered on its own", async () => {
  await call("/agent/steer", { turn: TURN, id: "e2", text: "make it Friday" });
  script = [{ text: "Sure." }];
  const response = await call("/agent", { question: "hi", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.equal(response.status, 200);
  assert.equal(response.body.steered, undefined);
  assert.ok(!conversationText(bucket).includes("make it Friday"));
  assert.deepEqual(steerKeys(), [], "cleared all the same");
});
