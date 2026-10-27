/**
 * The texting Worker's routes beside `/agent` (`src/agent/textingRoutes.js`):
 * `/agent/events`, `/agent/cancel`, `/agent/stale`, the widened steer, and a
 * texted turn shown the chat's event log when it names what it covers
 * (docs/design/tex-event-log/CONTRACT.md sections 2 and 4).
 *
 * Sabotage these and a test here fails (each was run):
 *
 *  1. A route not checking the client or the write scope (drop the
 *     `texting(session) || hasScope` check in `handleEvents`) → "only the
 *     texting Worker with write scope reaches the three routes".
 *  2. `http/route.js` not resolving the session for them (drop
 *     `TEXTING_ROUTES.has(path)` from the authenticated list) → "no token is
 *     refused the same as a bad one, on every route".
 *  3. `runTurn` not asking `steer.cancelled()` after a round → "a cancelled
 *     turn stops after its current round".
 *  4. `cancelledTurn` not withdrawing the turn's asks → "a cancelled turn's
 *     asks are withdrawn".
 *  5. `handleStale` disarming every pending ask instead of the named ones →
 *     "stale ends only the named asks, and only this person's".
 *  6. `route.js` passing `shown` instead of the log's history → "a turn that
 *     covers logged events is shown the transcript".
 *  7. `route.js` asking only `historyIsTainted(shown)` (drop `logged?.tainted`)
 *     → "a turn shown an answer from a tainted turn is untrusted, …".
 *  8. `route.js` not recording a named turn (drop `recordTurn`), or recording
 *     it after the answer (`afterAnswer`) → "a named turn's record is written
 *     before its answer".
 *  9. `route.js` not marking the texted-yes exit clean (drop `outcome.clean =
 *     true` at the `settled` return) → "a turn released by a texted answer
 *     leaves a clean record, so the next logged turn is trusted".
 * 10. `recordedTurn` recording `clean: true` by default (`clean: false` →
 *     `true` in its `outcome`) together with dropping `outcome.clean = false`
 *     in `route.js`'s catch → "a turn that fails is recorded not clean".
 *     Either alone fails nothing: a provider error throws before `clean` is
 *     set, so the default is the layer it meets; the catch is for a throw
 *     after the turn returned.
 * 11. `route.js` not asking `steer.endCancelled()` after the turn → "a cancel
 *     after the last round still withdraws the turn's asks".
 * 12. `steer.js` `track` not marking a write (drop `await committed(...)`) →
 *     "no cancel once the turn has changed something".
 * 13. `cancelTurn` not checking the running state (drop the `before?.user`
 *     test) together with its re-check after marking (always `return true`)
 *     → "no cancel for a turn that is not running, or not this person's".
 *     Either alone fails nothing: each is a layer behind the other.
 *
 * Changed behaviour (2026-10-27, not a sabotage): `/agent/cancel` answers
 * `{ cancelled: false }` and marks nothing unless the named turn is running
 * for this person and has not yet changed anything, so the tests that
 * cancelled a turn before it started now cancel it from inside its first
 * model round.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { cancelledTurn } from "../src/agent/textingRoutes.js";
import { logPrefix } from "../src/agent/log.js";
import { LOG_PREFACE, TURNS_PREFIX } from "../src/agent/loggedTurn.js";
import { CANCEL_PREFIX, RUNNING_PREFIX, steerFor } from "../src/agent/steer.js";
import { createPending, PENDING_PREFIX } from "../src/tools/approvals.js";
import { LOGICAL_DELETE_CONTENT_TYPE } from "../src/store/logicalDelete.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { conversationText, conversationTurns } from "./agentConversationFixture.mjs";

const S3_ENDPOINT = "https://s3.example-textingroutes.test";
const TOKEN_TEXTS = `cat_troutes_texts_${"0".repeat(24)}`;
const TOKEN_READONLY = `cat_troutes_ro_${"0".repeat(24)}`;
const TOKEN_OTHER = `cat_troutes_other_${"0".repeat(24)}`;
const TOKEN_GROUP = `cat_troutes_group_${"0".repeat(24)}`;
const TOKEN_UNKNOWN = `cat_troutes_nobody_${"0".repeat(24)}`;
const TURN = "turn-0000-cccc";
const CHAT = "chat-ada-1";

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

const requests = [];
let script = [];
/** Run inside a model call, before its reply (`during(n)`, n = calls so far): a cancel that lands mid-turn. */
let during = null;
const controlPlane = createControlPlaneStub();
let bucket;
const restore = [];
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };

function reply(step) {
  const content = [];
  if (step.text) content.push({ type: "text", text: step.text });
  for (const [i, [name, input]] of (step.calls ?? []).entries()) content.push({ type: "tool_use", id: `toolu_r_${requests.length}_${i}`, name, input });
  return { content, stop_reason: (step.calls ?? []).length > 0 ? "tool_use" : "end_turn", usage: { input_tokens: 5, output_tokens: 2 } };
}

async function raw(path, body, token = TOKEN_TEXTS) {
  const { ctx, settle } = createWorkerCtx();
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await worker.fetch(new Request(`https://mcp.context.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
  const text = await response.text();
  await settle();
  return { status: response.status, text, challenge: response.headers.get("WWW-Authenticate") };
}

async function call(path, body, token = TOKEN_TEXTS) {
  const { status, text } = await raw(path, body, token);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status, body: json };
}

const live = (key) => bucket.has(key) && bucket.get(key).contentType !== LOGICAL_DELETE_CONTENT_TYPE;
const liveKeys = (prefix) => [...bucket.keys()].filter((key) => key.startsWith(prefix) && live(key));

const NOW = Date.now();
let seq = 0;
function event(fields = {}) {
  const at = fields.at ?? NOW;
  seq += 1;
  return { id: `${String(at).padStart(13, "0")}-${String(seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields };
}

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
      if (during !== null && !/"client":"reflect"/.test(meta)) await during(requests.length);
      if (script[0]?.fail) return new Response("{}", { status: 500 });
      const step = script.shift() ?? { text: "Done." };
      return new Response(JSON.stringify(reply(step)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return below(input, init);
  };
  restore.push(() => {
    globalThis.fetch = below;
  });
  controlPlane.addWorkspace("ws_troutes", "troutes", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "tenant-troutes",
    accessKeyId: "AKIAEXAMPLEEXAMPLETR",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLETR",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  controlPlane.setBuiltinVerdict("ws_troutes", BUILTIN_ALLOWED);
  const write = ["context:read", "context:write", "context:private"];
  for (const [accessToken, clientId, scopes] of [
    [TOKEN_TEXTS, "context_texts", write],
    [TOKEN_READONLY, "context_texts", ["context:read", "context:private"]],
    [TOKEN_OTHER, "claude", write],
    [TOKEN_GROUP, "context_texts_group", write],
  ]) {
    await controlPlane.addGrant({ workspaceId: "ws_troutes", role: "owner", userId: "user_troutes", accessToken, scopes, clientId });
  }
  controlPlane.serveTreesFrom(env, { s3 });
  bucket = s3.bucketFor("tenant-troutes");
});

after(() => {
  for (const undo of restore.reverse()) undo();
});

beforeEach(() => {
  requests.length = 0;
  script = [];
  during = null;
  for (const key of [...bucket.keys()]) bucket.delete(key);
  bucket.set("1-projects/plan.md", { body: "# Plan\n\nThe plan.\n", etag: "n0" });
});

const ROUTES = [
  ["/agent/events", () => ({ conversation: "texts", events: [event()] })],
  ["/agent/cancel", () => ({ turn: TURN })],
  ["/agent/stale", () => ({ asks: ["a1"] })],
];

/* ---------------- auth ---------------- */

test("only the texting Worker with write scope reaches the three routes", async () => {
  for (const [path, body] of ROUTES) {
    for (const token of [TOKEN_OTHER, TOKEN_READONLY]) {
      const refused = await call(path, body(), token);
      assert.equal(refused.status, 403, `${path} refuses ${token}`);
      assert.deepEqual(refused.body, { error: "forbidden" });
    }
    assert.equal((await call(path, body())).status, 200, `${path} answers the texting Worker`);
  }
});

test("no token is refused the same as a bad one, on every route", async () => {
  const agent = await raw("/agent", { question: "hi" }, TOKEN_UNKNOWN);
  assert.equal(agent.status, 401);
  for (const [path, body] of ROUTES) {
    const none = await raw(path, body(), null);
    const unknown = await raw(path, body(), TOKEN_UNKNOWN);
    assert.equal(none.status, 401, path);
    assert.deepEqual([unknown.status, unknown.text, unknown.challenge], [agent.status, agent.text, agent.challenge], `${path} refuses like /agent`);
    assert.equal(none.text, (await raw("/agent", { question: "hi" }, null)).text, `${path} with no token`);
  }
  assert.deepEqual(liveKeys(".context/agent/"), []);
});

/* ---------------- events ---------------- */

test("events are written to the chat's log, idempotently, and refused whole on one bad event", async () => {
  const first = event({ text: "hello Tex" });
  const ok = await call("/agent/events", { conversation: "texts", events: [first] });
  assert.deepEqual(ok, { status: 200, body: { written: [first.id] } });
  assert.deepEqual(liveKeys(await logPrefix(CHAT)), [`${await logPrefix(CHAT)}${first.id}.json`]);
  assert.deepEqual((await call("/agent/events", { conversation: "texts", events: [first] })).body, { written: [first.id] });
  const bad = await call("/agent/events", { conversation: "texts", events: [event(), event({ kind: "tool_result" })] });
  assert.deepEqual(bad, { status: 400, body: { error: "invalid_request", error_description: "events[1].kind" } });
  assert.equal(liveKeys(await logPrefix(CHAT)).length, 1);
  assert.equal((await call("/agent/events", { conversation: "texts", events: Array.from({ length: 51 }, () => event()) })).status, 400);
});

test("a person's chat is the texting grant's, and a group's the group grant's", async () => {
  assert.equal((await call("/agent/events", { conversation: "texts", events: [event()] }, TOKEN_GROUP)).status, 400);
  assert.equal((await call("/agent/events", { conversation: { group: CHAT }, events: [event()] })).status, 400);
  assert.equal((await call("/agent/events", { conversation: { group: CHAT }, events: [event()] }, TOKEN_GROUP)).status, 200);
  assert.equal((await call("/agent/events", { conversation: { group: "another-chat" }, events: [event()] }, TOKEN_GROUP)).status, 400, "every event is the named chat's");
});

/* ---------------- cancel ---------------- */

test("a cancelled turn stops after its current round", async () => {
  assert.equal((await call("/agent/cancel", { turn: "../x" })).status, 400);
  script = [{ calls: [["fetch", { id: "1-projects/plan.md" }]] }, { text: "Should never be asked." }];
  let cancelled = null;
  during = async (n) => {
    if (n === 1) cancelled = (await call("/agent/cancel", { turn: TURN })).body;
  };
  const response = await call("/agent", { question: "read my plan", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.equal(response.status, 200);
  assert.equal(response.body.cancelled, true);
  assert.equal(response.body.answer, "");
  assert.deepEqual(cancelled, { cancelled: true });
  assert.equal(requests.length, 1, "no round after the one it was in");
  assert.ok(!conversationText(bucket).includes("read my plan"), "nothing kept as said");
  assert.deepEqual(liveKeys(CANCEL_PREFIX), [], "its mark is cleared");
});

test("a turn nobody cancelled runs as before, and clears nothing of another turn's", async () => {
  bucket.set(`${CANCEL_PREFIX}turn-other-0001.json`, { body: "{}", etag: "c0" });
  script = [{ calls: [["fetch", { id: "1-projects/plan.md" }]] }, { text: "Here's the plan." }];
  const response = await call("/agent", { question: "read my plan", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.equal(response.body.answer, "Here's the plan.");
  assert.equal(response.body.cancelled, undefined);
  assert.deepEqual(response.body.askIds, [], "no asks armed, none named");
  assert.deepEqual(liveKeys(CANCEL_PREFIX), [`${CANCEL_PREFIX}turn-other-0001.json`]);
  assert.deepEqual(liveKeys(RUNNING_PREFIX), [], "not running once it answered");
});

test("no cancel for a turn that is not running, or not this person's", async () => {
  assert.deepEqual((await call("/agent/cancel", { turn: TURN })).body, { cancelled: false });
  bucket.set(`${RUNNING_PREFIX}${TURN}.json`, { body: JSON.stringify({ user: "user_someone_else", wrote: false }), etag: "r0" });
  assert.deepEqual((await call("/agent/cancel", { turn: TURN })).body, { cancelled: false });
  assert.deepEqual(liveKeys(CANCEL_PREFIX), [], "nothing marked");
});

test("no cancel once the turn has changed something", async () => {
  script = [{ calls: [["write_note", { path: "1-projects/new.md", content: "# New\n\nHi.\n" }]] }, { text: "Wrote it." }];
  let cancelled = null;
  during = async (n) => {
    if (n === 2) cancelled = (await call("/agent/cancel", { turn: TURN })).body;
  };
  const response = await call("/agent", { question: "write a note called new", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.ok(response.body.steps.some((step) => step.tool === "write_note" && step.ok), "the write ran");
  assert.deepEqual(cancelled, { cancelled: false });
  assert.equal(response.body.cancelled, undefined);
  assert.equal(response.body.answer, "Wrote it.");
  assert.deepEqual(liveKeys(CANCEL_PREFIX), []);
});

test("a cancel after the last round still withdraws the turn's asks", async () => {
  script = [{ calls: [["create_workspace", { slug: "racehandle", name: "racehandle" }]] }, { text: "Want me to claim racehandle?" }];
  let cancelled = null;
  during = async (n) => {
    if (n === 2) cancelled = (await call("/agent/cancel", { turn: TURN })).body; // the final round: no round check follows it
  };
  const response = await call("/agent", { question: "claim the handle racehandle", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.ok(response.body.steps.some((step) => step.tool === "create_workspace"), "the claim was held for a yes");
  assert.deepEqual(cancelled, { cancelled: true });
  assert.equal(response.body.cancelled, true);
  assert.equal(response.body.answer, "");
  const armed = liveKeys(PENDING_PREFIX).map((key) => JSON.parse(bucket.get(key).body)).filter((record) => record.texting === true);
  assert.deepEqual(armed, [], "its ask is withdrawn");
  assert.ok(!conversationText(bucket).includes("claim the handle"), "nothing kept as said");
  assert.deepEqual(liveKeys(CANCEL_PREFIX), []);
  assert.deepEqual(liveKeys(RUNNING_PREFIX), []);
});

test("a cancelled turn's asks are withdrawn", async () => {
  const store = memoryStore();
  const actor = { userId: "user_a", clientId: "context_texts" };
  const mine = await createPending(store, { name: "send_email", args: { to: "a@example.com" }, actor, texting: true });
  const earlier = await createPending(store, { name: "send_email", args: { to: "b@example.com" }, actor, texting: true });
  const steer = steerFor(store, { actorClientId: "context_texts" }, { turn: TURN });
  await store.put(`${CANCEL_PREFIX}${TURN}.json`, "{}");
  const response = await cancelledTurn(store, { actorUserId: "user_a" }, { ledger: { asked: [{ id: mine.id }] }, steer, transcript: null, steps: [] });
  assert.deepEqual(await response.json(), { cancelled: true, answer: "", asked: 0, steps: [] });
  const left = [...store.data.keys()].filter((key) => key.startsWith(PENDING_PREFIX)).map((key) => JSON.parse(store.data.get(key)).id);
  assert.deepEqual(left, [earlier.id], "only the asks this turn raised");
  assert.equal(store.data.has(`${CANCEL_PREFIX}${TURN}.json`), false);
});

/* ---------------- stale ---------------- */

test("stale ends only the named asks, and only this person's", async () => {
  const scratch = memoryStore();
  const texts = { clientId: "context_texts" };
  const named = await createPending(scratch, { name: "send_email", args: { to: "a@example.com" }, actor: { ...texts, userId: "user_troutes" }, texting: true });
  const kept = await createPending(scratch, { name: "send_email", args: { to: "b@example.com" }, actor: { ...texts, userId: "user_troutes" }, texting: true });
  const theirs = await createPending(scratch, { name: "send_email", args: { to: "c@example.com" }, actor: { ...texts, userId: "user_someone_else" }, texting: true });
  for (const [key, body] of scratch.data) bucket.set(key, { body, etag: `e-${key.length}` });
  const response = await call("/agent/stale", { asks: [named.id, theirs.id] });
  assert.deepEqual(response, { status: 200, body: { disarmed: 1 } });
  const armed = liveKeys(PENDING_PREFIX).map((key) => JSON.parse(bucket.get(key).body)).filter((record) => record.texting === true).map((record) => record.id).sort();
  assert.deepEqual(armed, [kept.id, theirs.id].sort());
  assert.equal((await call("/agent/stale", { asks: "all" })).status, 400);
  assert.equal((await call("/agent/stale", { asks: Array.from({ length: 9 }, (_, i) => `a${i}`) })).status, 400);
});

/* ---------------- steer, widened ---------------- */

test("a tapback's words and a caption are steered like a text, capped the same", async () => {
  for (const [id, text] of [["r1", "Loved “book it”"], ["c1", "this one, the blue door"]]) {
    assert.deepEqual((await call("/agent/steer", { turn: TURN, id, text })).body, { queued: true });
  }
  assert.equal((await call("/agent/steer", { turn: TURN, id: "long", text: "x".repeat(10_000) })).status, 200);
  const stored = liveKeys(`.context/agent/steer/${TURN}/`).map((key) => JSON.parse(bucket.get(key).body).text);
  assert.ok(stored.every((text) => text.length <= 4_000));
  assert.ok(stored.includes("this one, the blue door"));
});

/* ---------------- the turn shown the log ---------------- */

test("a turn that covers logged events is shown the transcript, and today's history is still written", async () => {
  const old = event({ at: NOW - 120_000, text: "what's on Friday" });
  const answer = event({ at: NOW - 60_000, from: { kind: "tex" }, text: "Dinner at 7.", covers: [old.id] });
  const fresh = event({ text: "move it to 8" });
  await call("/agent/events", { conversation: "texts", events: [old, answer, fresh] });
  script = [{ text: "Moved to 8." }];
  const response = await call("/agent", { question: "move it to 8", timeZone: "UTC", conversation: "texts", chat: CHAT, covers: [fresh.id] });
  assert.equal(response.status, 200);
  const messages = JSON.stringify(requests[0].messages);
  assert.ok(messages.includes(LOG_PREFACE.slice(0, 40)), "the log is the conversation");
  assert.match(messages, /You: Dinner at 7\./);
  assert.match(conversationText(bucket), /move it to 8/, "today's history is still kept");
});

test("a turn shown an answer from a tainted turn is untrusted, and so is what it says next", async () => {
  const askedBefore = event({ at: NOW - 120_000, text: "what does that page say" });
  const answer = event({ at: NOW - 60_000, from: { kind: "tex" }, text: "It says to email them.", turn: "turn-dirty-0001", covers: [askedBefore.id] });
  const fresh = event({ text: "ok do it" });
  await call("/agent/events", { conversation: "texts", events: [askedBefore, answer, fresh] });
  const ask = { question: "ok do it", timeZone: "UTC", conversation: "texts", chat: CHAT, covers: [fresh.id], turn: TURN };
  bucket.set(`${TURNS_PREFIX}turn-dirty-0001.json`, { body: JSON.stringify({ clean: true }), etag: "t0" });
  script = [{ text: "Clean so far." }];
  await call("/agent", ask);
  assert.ok(!conversationTurns(bucket).some((turn) => turn.tainted), "a clean record: nothing tainted");
  assert.deepEqual(JSON.parse(bucket.get(`${TURNS_PREFIX}${TURN}.json`).body), { clean: true });
  for (const key of [...bucket.keys()]) if (key.startsWith(".context/agent/events/")) bucket.delete(key);
  bucket.set(`${TURNS_PREFIX}turn-dirty-0001.json`, { body: JSON.stringify({ clean: false }), etag: "t1" });
  script = [{ text: "Doing it." }];
  await call("/agent", ask);
  assert.ok(conversationTurns(bucket).some((turn) => turn.tainted === true), "this turn's answer is kept as tainted");
  assert.deepEqual(JSON.parse(bucket.get(`${TURNS_PREFIX}${TURN}.json`).body), { clean: false }, "and this turn is recorded as not clean in turn");
  assert.equal((await call("/agent/events", { conversation: "texts", events: [{ ...event({ from: { kind: "tex" } }), tainted: false }] })).status, 400, "the Worker cannot launder it");
});

test("a named turn's record is written before its answer", async () => {
  script = [{ text: "Hi." }];
  // The record's write is slow, so an answer that did not wait for it returns first.
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes(".context/agent/turns/") && (init?.method ?? input.method) === "PUT") await new Promise((resolve) => setTimeout(resolve, 100));
    return below(input, init);
  };
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/agent", { method: "POST", headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json" }, body: JSON.stringify({ question: "hi", timeZone: "UTC", conversation: "texts", turn: TURN }) }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.ok(live(`${TURNS_PREFIX}${TURN}.json`), "there when the answer is, before deferred work settles");
  await response.text();
  await settle();
  globalThis.fetch = below;
});

test("a turn with no log for its chat is today's turn", async () => {
  script = [{ text: "Sure." }];
  const response = await call("/agent", { question: "hello", timeZone: "UTC", conversation: "texts", chat: CHAT, covers: [event().id] });
  assert.equal(response.status, 200);
  assert.ok(!JSON.stringify(requests[0].messages).includes(LOG_PREFACE.slice(0, 40)));
});

/* ---------------- every exit of a named turn is recorded ---------------- */

test("a turn released by a texted answer leaves a clean record, so the next logged turn is trusted", async () => {
  const scratch = memoryStore();
  await createPending(scratch, { name: "send_email", args: { to: "a@example.com" }, actor: { clientId: "context_texts", userId: "user_troutes" }, texting: true });
  for (const [key, body] of scratch.data) bucket.set(key, { body, etag: `e-${key.length}` });
  const settled = await call("/agent", { question: "no", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.match(settled.body.answer, /dropped/);
  assert.equal(requests.length, 0, "no model ran");
  assert.deepEqual(JSON.parse(bucket.get(`${TURNS_PREFIX}${TURN}.json`).body), { clean: true });
  const asked = event({ at: NOW - 60_000, text: "no" });
  const said = event({ at: NOW - 30_000, from: { kind: "tex" }, text: settled.body.answer, turn: TURN, covers: [asked.id] });
  const fresh = event({ text: "thanks" });
  await call("/agent/events", { conversation: "texts", events: [asked, said, fresh] });
  script = [{ text: "Any time." }];
  await call("/agent", { question: "thanks", timeZone: "UTC", conversation: "texts", chat: CHAT, covers: [fresh.id], turn: "turn-next-0001" });
  assert.ok(!conversationTurns(bucket).some((turn) => turn.tainted), "not untrusted");
  assert.deepEqual(JSON.parse(bucket.get(`${TURNS_PREFIX}turn-next-0001.json`).body), { clean: true });
});

test("a turn that fails is recorded not clean", async () => {
  script = [{ fail: true }];
  const response = await call("/agent", { question: "hi", timeZone: "UTC", conversation: "texts", turn: TURN });
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(bucket.get(`${TURNS_PREFIX}${TURN}.json`).body), { clean: false });
  assert.deepEqual(liveKeys(RUNNING_PREFIX), [], "not left running");
});
