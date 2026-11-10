/**
 * Tex's cached prefix stays the same from one text to the next (Dev2, 2026-11-10), so the one-hour prompt cache
 * (`aiGateway.js`) is read across texts: Anthropic caches tools, then system, then messages, and a changed tool
 * list misses all of it, a changed system prompt misses the system and the history.
 *
 * Two consecutive texts, through the real `/agent` route, for a 1:1 chat and a group. Between them the time, the
 * question, the background jobs running and, in the group, who tagged change. The tools and the system prompt must be
 * byte-identical, and the second text's messages must start with exactly the first text's history (cache marks aside:
 * a mark moves to the newest history, the bytes before it do not).
 *
 * Covers the memory history (`conversation.js`, `readGroupMemory`). Not covered: a turn shown the rendered log
 * (`loggedTurn.js`), which is one block rebuilt every text; it carries no hour mark (`historyCached`, checked below
 * on `gatewayBody`).
 *
 * Sabotage these and a test here fails:
 *  1. `background.js` offering only the job tools that apply now → both turns.
 *  2. `runTheModel.js` putting `taggedLine` or the running jobs back in `threadNote` → both turns.
 *  (The calendar copy's age out of `system.context` is held by `texCalendarCache.test.mjs`.)
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { gatewayBody } from "../src/agent/aiGateway.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { fakeModel, PRIVACY_MANIFEST } from "./agentEgressFixtures.mjs";
import { texStoreNamespace, withAgentHome } from "./texStoreFixture.mjs";
import { seedChat } from "./agentConversationFixture.mjs";

const S3_ENDPOINT = "https://s3.example-prefix.test";
const TOKEN_GROUP = `cat_prefix_group_${"0".repeat(22)}`;
const TOKEN_TEXTS = `cat_prefix_texts_${"0".repeat(22)}`;
const KEY = "a".repeat(64);
const MEMBERS = "b".repeat(64);
const NOW = Date.now();
const JOB = { id: "job-12-abcdef", title: "Logo in green", state: "running", startedAt: NOW - 6 * 60_000 };

let world;
before(() => {
  world = { previousFetch: globalThis.fetch };
});
after(() => {
  globalThis.fetch = world.previousFetch;
});

beforeEach(async () => {
  world.restore?.();
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  controlPlane.serveTreesFrom(null, { s3 });
  const model = fakeModel();
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    return url.startsWith(AI_GATEWAY_ORIGIN) ? model.handle(url, init) : withStubs(input, init);
  };
  const binding = (bucket) => ({
    provider: "s3", status: "active", endpoint: S3_ENDPOINT, region: "auto", bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEAA", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAA", forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  });
  controlPlane.addWorkspace("ws_prefix_own", "ada", binding("tenant-prefix-own"));
  controlPlane.addWorkspace("ws_prefix_team", "band", binding("tenant-prefix-team"), { kind: "shared" });
  await controlPlane.addGrant({ accessToken: TOKEN_GROUP, workspaceId: "ws_prefix_team", role: "editor", scopes: ["context:read", "context:write"], clientId: "context_texts_group", clientName: "Tex (group chats)", userId: "user_ada" });
  await controlPlane.addGrant({ accessToken: TOKEN_TEXTS, workspaceId: "ws_prefix_own", role: "owner", scopes: ["context:read", "context:write", "context:private"], clientId: "context_texts", clientName: "Context (texts)", userId: "user_ada" });
  controlPlane.setBuiltinVerdict("ws_prefix_team", BUILTIN_ALLOWED);
  controlPlane.setBuiltinVerdict("ws_prefix_own", BUILTIN_ALLOWED);
  s3.bucketFor("tenant-prefix-team").set("privacy.md", { body: PRIVACY_MANIFEST, etag: "t0" });
  s3.bucketFor("tenant-prefix-own").set("privacy.md", { body: PRIVACY_MANIFEST, etag: "p0" });
  const tex = texStoreNamespace();
  // The 1:1 chat so far, in the person's ledger, as the gateway keeps it.
  seedChat(withAgentHome(s3.bucketFor("tenant-prefix-own"), tex, "ws_prefix_own"), [{ role: "user", text: "remember the logo" }, { role: "assistant", text: "Noted." }]);
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: tex.namespace, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
  Object.assign(world, { model, env, restore: () => (restoreControlPlane(), restoreS3()) });
});

async function ask(token, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    world.env,
    ctx,
  );
  const text = await response.text();
  await settle();
  assert.equal(response.status, 200, text);
}

/** The request without its cache marks: where a mark sits is not part of the cached bytes. */
const unmarked = (value) => JSON.parse(JSON.stringify(value), (key, inner) => (key === "cache_control" ? undefined : inner));

/** Three texts; the second and third requests are compared, so the third has a history to read back. */
async function assertStable(token, bodies) {
  const sent = [];
  for (const [i, body] of bodies.entries()) {
    world.model.install([{ text: `Answer ${i}.` }]);
    await ask(token, body);
    sent.push(world.model.requests.at(-1));
  }
  const [, first, second] = sent;
  assert.deepEqual(second.tools, first.tools, "the tool list is the same, byte for byte, from one text to the next");
  assert.deepEqual(second.system, first.system, "the system prompt is the same, byte for byte, from one text to the next");
  const history = first.messages.slice(0, -1); // everything before the person's new text: what the hour mark covers
  assert.ok(history.length > 0, "the compared text has a history to read back");
  assert.ok(JSON.stringify(first.messages.at(-2)).includes('"ttl":"1h"'), "the history ends on the hour mark");
  assert.deepEqual(unmarked(second.messages.slice(0, history.length)), unmarked(history), "the next text starts with this text's history, unchanged");
  return { first, second };
}

test("a 1:1 text: tools, system and history read back across texts while the clock and the jobs change", async () => {
  const { first, second } = await assertStable(TOKEN_TEXTS, [
    { question: "hi", conversation: "texts", timeZone: "UTC", running: [] },
    { question: "what's on my list?", conversation: "texts", timeZone: "UTC", running: [] },
    { question: "and the logo?", conversation: "texts", timeZone: "UTC", running: [JOB] },
  ]);
  assert.match(JSON.stringify(second.messages.at(-1)), /Logo in green/, "the job running now is said with the text");
  assert.doesNotMatch(JSON.stringify(first.messages.at(-1)), /Logo in green/);
});

test("a group: tools, system and history read back across texts while the tagger changes", async () => {
  const { first, second } = await assertStable(TOKEN_GROUP, [
    { question: "hello", group: { key: KEY, members: MEMBERS, from: "ada" }, timeZone: "UTC", running: [] },
    { question: "what's the setlist?", group: { key: KEY, members: MEMBERS, from: "ada" }, timeZone: "UTC", running: [] },
    { question: "and the opener?", group: { key: KEY, members: MEMBERS, from: "bo" }, timeZone: "UTC", running: [JOB] },
  ]);
  assert.match(JSON.stringify(first.messages.at(-1)), /@ada tagged you/);
  assert.match(JSON.stringify(second.messages.at(-1)), /@bo tagged you/);
});

test("a history rebuilt every text (the rendered log) carries no hour mark", () => {
  const messages = [{ role: "user", text: "(The chat so far) ..." }, { role: "user", text: "now" }];
  const body = gatewayBody({ model: "anthropic/claude-sonnet-5", system: { stable: "s", context: "c" }, messages, tools: [], cachedThrough: 0 });
  assert.doesNotMatch(JSON.stringify(body.messages), /"ttl":"1h"/);
  const marks = JSON.stringify(body).match(/cache_control/g).length;
  assert.ok(marks <= 4, "within Anthropic's four breakpoints");
});
