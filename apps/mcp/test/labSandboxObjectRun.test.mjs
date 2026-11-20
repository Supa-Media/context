// A Lab test text's whole run is handed to its test chat's own object (`crossRuns.js` `objectRun`, op `text.run`), never
// kept by the request that sent it: a Worker stops a request's `waitUntil` 30 s after it answers, and in production
// (2026-11-17, jobs j6401134c and j25f68f92) every background job longer than that logged `carry_on` and then nothing.
//
// What this proves (the hand-off, on a fake clock: whether Cloudflare keeps the object alive is proven in the Lab, not
// here): a sent text's request keeps no work of its own; the object keeps the run, whose job runs past 80 s of the clock
// and reaches its report (a Tex row `from: "job"`), and the text's running mark is freed after it; a request whose
// object answered without taking the run runs it itself, and one whose call failed with no answer never runs it twice;
// a run that fails before its turn frees the mark; `alive` keeps the mark fresh without touching its steps; and the
// Worker's own wiring (`route.js` `carryWith`) sends `text.run` to `objectRun`. Fake ids, numbers and words only.
//
// Sabotage (temporary local edit, reverted, 2026-11-17): `addRow` back to running the turn under the request's
// `waitUntil` (no `runInObject`) fails "the request keeps no work".

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { handleLabSandbox, newIds, open, DAILY_SENDS } from "../../../packages/lab/gateway/labSandbox/route.js";
import { objectRun, objectCarry, runInObject } from "../../../packages/lab/gateway/labSandbox/crossRuns.js";
import { runChatTurn } from "../../../packages/lab/gateway/labSandbox/chatRun.js";
import { streamTurn, wantsProgress } from "../../../packages/tex/gateway/agent/progress.js";
import { eventEntry } from "../../../packages/tex/gateway/agent/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";

const ALICE = "tok_alice_example_000000000000";
const JOB_MS = 90_000;

/** `/agent` as a gateway answers it: the text's turn starts a job, whose own turn takes `JOB_MS`, and its report texts. */
function jobGateway(clock, call, rowId) {
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, job: Boolean(body.job), event: body.event ?? null });
    if (path === "/agent") {
      if (body.job) clock.t += JOB_MS;
      const answer = body.job
        ? { answer: "Three caterers: Ana's Kitchen, Blue Fig, Olive.", turn: body.turn ?? "j" }
        : body.event === "job_report"
          ? { answer: "Found three caterers: Ana's Kitchen, Blue Fig and Olive.", turn: body.turn ?? "r" }
          : { answer: "On it: looking for caterers now.", turn: body.turn ?? "t", jobs: [{ id: "job0caterers1", title: "Find caterers", brief: "Three caterers near Ana.", doneWhen: "three caterers" }] };
      const reply = () => Response.json(answer);
      return wantsProgress(request) ? streamTurn(async () => reply()) : reply();
    }
    if (path === "/agent/events") {
      await call("ledger.append", { entries: (body.events ?? []).map(eventEntry), by: rowId });
      return Response.json({ written: [...new Set((body.events ?? []).map((e) => e.id))] });
    }
    return Response.json({ events: [] });
  };
  const textsRoute = async (request) => (new URL(request.url).pathname === "/texts/old-line" ? Response.json({ to: "pass" }) : Response.json({ error: "unknown_route" }, { status: 404 }));
  return { asked, agentRoute, textsRoute };
}

/** The route over in-memory test chats whose objects keep work in `kept.object` (or cannot, `objectKeeps: false`). */
function world({ objectKeeps = true } = {}) {
  const kept = { request: [], object: [] };
  const clock = { t: Date.now(), start: 0 };
  const gateways = [];
  // The turn as the object runs it: the real `runChatTurn`, on a gateway double and a clock the job moves.
  const runTurn = (args) => {
    const call = async (op, body = {}) => (await args.stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
    const gw = jobGateway(clock, call, args.row.id);
    gateways.push(gw);
    clock.start = clock.t;
    return runChatTurn({ ...args, env: {}, agentRoute: gw.agentRoute, textsRoute: gw.textsRoute, now: () => clock.t, sleep: async (ms) => void (clock.t += ms) });
  };
  runTurn.logsText = () => true;
  const pieces = async () => ({ open, newIds, runTurn, max: DAILY_SENDS });
  const carry = (env, state, body, op) => (op === "text.run" ? objectRun : objectCarry)(env, state, body, pieces);
  const made = new Map();
  const object = (name) => {
    const state = { storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} }, ...(objectKeeps ? { waitUntil: (work) => void kept.object.push(work) } : {}) };
    if (!made.has(name)) made.set(name, new LabSandboxObject(state, env, { carry }));
    return made.get(name);
  };
  const env = { LAB_SANDBOX: { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) }, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (body.accessToken !== ALICE) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: "u_alice", chats: [] });
    if (body.action === "set" || body.action === "draft") return answer({ status: "not_found" });
    if (body.action === "session") return answer({ status: "ok", session: { grantId: "g1", clientId: "c", actorUserId: "u_alice", scopes: ["context:read"], defaultWorkspaceId: "ws_a", workspaces: [{ workspaceId: "ws_a", role: "owner", kind: "personal", slug: "alfa" }] }, people: [{ handle: "alfa", name: "You" }] });
    return answer({ status: "bad_request" });
  };
  const call = async (body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: (work) => void kept.request.push(work) }, { runTurn, origin: "https://gateway.example.invalid" });
    return { status: response.status, body: await response.json() };
  };
  return { kept, clock, gateways, made, call, restore: () => (globalThis.fetch = original) };
}

test("a test text's job running over 80 s reaches its report: the object keeps the run, the request keeps nothing", async () => {
  const w = world();
  try {
    const { sandboxId } = (await w.call({ op: "open", source: "chat" })).body;
    const sent = await w.call({ op: "send", sandboxId, text: "find us a caterer for Saturday" });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    // Whatever a Worker would cut 30 s after answering is nothing: the request keeps no work.
    assert.equal(w.kept.request.length, 0, "the request keeps no work");
    assert.equal(w.kept.object.length, 1, "the test chat's object keeps the run");
    await Promise.all(w.kept.object);
    assert.ok(w.clock.t - w.clock.start > 80_000, `the job ran past 80 s (${w.clock.t - w.clock.start} ms)`);
    assert.ok(w.gateways[0].asked.some((a) => a.job), "the job's own turn was asked");
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    const reply = rows.find((r) => r.id === `${sent.body.msgId}r`);
    assert.equal(reply?.text, "On it: looking for caterers now.");
    const report = rows.filter((r) => r.from === "job" && r.reply === sent.body.msgId);
    assert.ok(report.length >= 1, `the job's report arrived (${rows.filter((r) => !r.prod).map((r) => `${r.id}:${r.from ?? ""}:${r.text}`).join(" | ")})`);
    assert.match(report.at(-1).text, /caterers/i);
    const state = await w.call({ op: "get", sandboxId });
    assert.equal(state.body.running ?? null, null, "the text's running mark is freed after its job");
  } finally {
    w.restore();
  }
});

test("a test chat's object that cannot keep the run leaves it to the request that sent the text", async () => {
  const w = world({ objectKeeps: false });
  try {
    const { sandboxId } = (await w.call({ op: "open", source: "chat" })).body;
    const sent = await w.call({ op: "send", sandboxId, text: "find us a caterer" });
    assert.equal(sent.status, 200);
    assert.equal(w.kept.request.length, 1, "the request runs it");
    await Promise.all(w.kept.request);
    const rows = (await w.call({ op: "get", sandboxId })).body.rows;
    assert.ok(rows.some((r) => r.from === "job"), "its job still reported");
  } finally {
    w.restore();
  }
});

test("an object runs only a run it was handed whole, with a token, and can keep", () => {
  const env = { LAB_SANDBOX: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => Response.json({}) }) } };
  const pieces = async () => ({});
  const kept = [];
  const state = { waitUntil: (work) => void kept.push(work) };
  const whole = { turn: { about: { kind: "one" }, row: { id: "t1" } }, token: ALICE, who: { userId: "u_alice" }, asker: { sandboxId: "0123456789abcdef" } };
  assert.deepEqual(objectRun(env, state, { ...whole, token: undefined }, pieces), { running: false }, "no token, no run");
  assert.deepEqual(objectRun(env, state, { ...whole, turn: { about: { kind: "one" } } }, pieces), { running: false }, "no row, no run");
  assert.deepEqual(objectRun(env, {}, whole, pieces), { running: false }, "an object that cannot keep it says so");
  assert.equal(kept.length, 0);
});

test("a call to the object that failed with no answer is never run again by the request; an answer that refused is", async () => {
  const thrown = (error) => ({ fetch: async () => { throw error; } });
  const carry = (stub) => ({ token: ALICE, who: { userId: "u_alice" }, origin: "https://gateway.example.invalid", config: null, asker: { stub, sandboxId: "0123456789abcdef" } });
  assert.equal(await runInObject({ about: {}, row: { id: "t1" } }, carry(thrown(new Error("network lost")))), "unknown");
  assert.equal(await runInObject({ about: {}, row: { id: "t1" } }, carry({ fetch: async () => Response.json({ error: "gone" }, { status: 410 }) })), "refused");
  assert.equal(await runInObject({ about: {}, row: { id: "t1" } }, carry({ fetch: async () => Response.json({ running: false }) })), "refused");
  assert.equal(await runInObject({ about: {}, row: { id: "t1" } }, carry({ fetch: async () => Response.json({ running: true }) })), "object");
});

test("a run that fails before its turn frees its text's mark; alive keeps a mark fresh and its steps as they were", async () => {
  const objects = new Map();
  const env = { LAB_SANDBOX: { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => objects.get(id.name).fetch(request) }) } };
  const kept = [];
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} }, waitUntil: (work) => void kept.push(work) }, env);
  objects.set("labsandbox:u_alice:0123456789abcdef", object);
  const call = async (op, body = {}) => (await object.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  await call("init", { about: { kind: "one", sandboxId: "0123456789abcdef" }, rows: [], history: [] });
  assert.equal((await call("claim", { msgId: "t1", staleMs: 60_000 })).ok, true);
  await call("beat", { msgId: "t1", node: "fd", steps: [{ node: "fd" }] });
  const before = (await call("state")).meta.running;
  assert.equal((await call("alive", { msgId: "t1" })).ok, true);
  assert.equal((await call("alive", { msgId: "t2" })).ok, false, "never another text's mark");
  const after = (await call("state")).meta.running;
  assert.deepEqual([after.node, after.steps], [before.node, before.steps], "its node and steps untouched");
  const broken = async () => {
    throw new Error("could not load");
  };
  assert.deepEqual(objectRun(env, { waitUntil: (work) => void kept.push(work) }, { turn: { about: { kind: "one" }, row: { id: "t1" } }, token: ALICE, who: { userId: "u_alice" }, asker: { sandboxId: "0123456789abcdef" } }, broken), { running: true });
  await Promise.all(kept);
  assert.equal((await call("state")).meta.running, undefined, "the mark is freed");
});

test("the Worker's own wiring runs text.run as objectRun: the object takes the run and keeps it", async () => {
  // The route module sets the object's `text.run` (`carryWith`) when it loads; this object is handed none of its own.
  const kept = [];
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} }, waitUntil: (work) => void kept.push(work) }, { LAB_SANDBOX: { idFromName: (name) => ({ name }), get: () => ({ fetch: async () => Response.json({ error: "refused" }, { status: 422 }) }) } });
  const call = async (op, body = {}) => (await object.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  await call("init", { about: { kind: "one", sandboxId: "0123456789abcdef" }, rows: [], history: [] });
  assert.deepEqual(await call("text.run", { turn: { about: { kind: "one" }, row: { id: "t1" } }, who: { userId: "u_alice" }, asker: { sandboxId: "0123456789abcdef" } }), { running: false }, "no token, no run");
  assert.deepEqual(await call("text.run", { turn: { about: { kind: "one", sandboxId: "0123456789abcdef" }, row: { id: "t1", who: "You", text: "hi", at: Date.now() } }, token: ALICE, who: { userId: "u_alice" }, origin: "https://gateway.example.invalid", asker: { sandboxId: "0123456789abcdef" } }), { running: true });
  assert.equal(kept.length, 1, "the object keeps it");
  await Promise.all(kept);
});
