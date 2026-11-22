// A Lab test chat on a pull request's code (packages/lab/gateway/labSandbox/preview.js, bridge.js; Dev2, 2026-11-22:
// test chats gain "run on PR #N's code", run on that pull request's own preview, never production's data). Production
// keeps a stand-in and a mailbox; a GitHub workflow on main takes the mailbox's calls to the preview and hands answers
// back, reaching production only with GitHub's signed token for that workflow. Fake ids and tokens only.
//
// Sabotage (temporary local edits, reverted, 2026-11-22):
//   preview.js handleBridge passing no `workflow` to verify (the bench's default)  "only the preview workflow" fails
//   bridge.js take without the run check                                          "another run is refused" fails
//   route.js `open` ignoring `code`                                              "opens on the preview" fails
//   preview.js forwardToPreview without asOurs                                     "the preview's id is put back" fails
//   bridge.js call timeout keeping a call nobody took                              "dropped, never run twice" fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { BridgeMailbox, RUNNER_GONE_MS } from "../../../packages/lab/gateway/labSandbox/bridge.js";
import { handleLabSandbox } from "../../../packages/lab/gateway/labSandbox/route.js";
import { BRIDGE_AUDIENCE, BRIDGE_WORKFLOW, asOurs, handleBridge, previewOf } from "../../../packages/lab/gateway/labSandbox/preview.js";
import { AUDIENCE as BENCH_AUDIENCE, ISSUER, REPOSITORY, WORKFLOW as BENCH_WORKFLOW, verifyGithubToken } from "../../../packages/lab/gateway/bench/oidc.js";
import { carry } from "../../../packages/sandbox/src/lab-bridge.mjs";
import { durableSql } from "./texStoreFixture.mjs";

const ALICE = "tok_alice_example_000000000000";
const BOB = "tok_bob_example_00000000000000";
const PREVIEW_ID = "0123456789abcdef";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const sign = async (claims) => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
    const body = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  };
  return { sign, keys: async () => [jwk] };
}

function memoryStorage() {
  const kv = new Map();
  return {
    sql: durableSql(),
    get: async (k) => structuredClone(kv.get(k)),
    put: async (k, v) => void kv.set(k, structuredClone(v)),
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    deleteAll: async () => kv.clear(),
  };
}

function objects() {
  const made = new Map();
  const object = (name) => {
    if (!made.has(name)) made.set(name, new LabSandboxObject({ storage: memoryStorage() }));
    return made.get(name);
  };
  return { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }), names: () => [...made.keys()] };
}

test("previewOf reads a pull request, main, or refuses", () => {
  assert.equal(previewOf(undefined), null);
  assert.equal(previewOf("main"), null);
  assert.deepEqual(previewOf("#4012"), { pr: 4012 });
  assert.deepEqual(previewOf("pr12"), { pr: 12 });
  assert.deepEqual(previewOf("12"), { pr: 12 });
  for (const bad of ["#0", "#12345678", "feature/x", 12, "#12;x"]) assert.ok(previewOf(bad).error, String(bad));
});

test("asOurs puts the preview's id back to this test chat's, everywhere", () => {
  assert.deepEqual(asOurs({ sandboxId: PREVIEW_ID, link: `/lab?testchat=${PREVIEW_ID}` }, PREVIEW_ID, "ffffffffffffffff"), { sandboxId: "ffffffffffffffff", link: "/lab?testchat=ffffffffffffffff" });
  assert.deepEqual(asOurs({ a: 1 }, null, "x"), { a: 1 });
});

test("only the preview workflow on main gets in the mailbox's door; the bench's token does not, nor the other way", async () => {
  const { sign, keys } = await signer();
  const now = 1_800_000_000_000;
  const good = { iss: ISSUER, aud: BRIDGE_AUDIENCE, exp: now / 1000 + 300, iat: now / 1000, repository: REPOSITORY, ref: "refs/heads/main", job_workflow_ref: BRIDGE_WORKFLOW, run_id: "77" };
  const env = { LAB_SANDBOX: objects() };
  const door = async (claims) => {
    const token = await sign(claims);
    const response = await handleBridge(new Request("https://gateway.example.invalid/tex-lab/sandbox/bridge", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ op: "take", bridge: "a".repeat(32), waitMs: 0 }) }), env, { verify: (t, opts) => verifyGithubToken(t, { ...opts, keys, now }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await door(good)).status, 200, "the preview workflow on main");
  assert.equal((await door({ ...good, job_workflow_ref: BENCH_WORKFLOW, aud: BENCH_AUDIENCE })).status, 403, "only the preview workflow: the bench's is refused");
  assert.equal((await door({ ...good, job_workflow_ref: BENCH_WORKFLOW })).status, 403, "the bench's workflow with this audience is refused");
  assert.equal((await door({ ...good, ref: "refs/heads/feature", job_workflow_ref: BRIDGE_WORKFLOW.replace("refs/heads/main", "refs/heads/feature") })).status, 403, "a branch is refused");
  assert.equal((await door({ ...good, aud: BENCH_AUDIENCE })).status, 403, "the bench's audience is refused");
  assert.equal((await door({ ...good, run_id: "x" })).status, 403, "a token naming no run");
  // The bench's own door is unchanged: the preview's token is refused there.
  assert.match((await verifyGithubToken(await sign(good), { keys, now })).refused, /not meant for the bench/);
  const none = await handleBridge(new Request("https://gateway.example.invalid/tex-lab/sandbox/bridge", { method: "POST", body: "{}" }), env);
  assert.equal(none.status, 401);
});

function mailbox() {
  let t = 1_000_000;
  const kv = new Map();
  const state = { storage: { get: async (k) => structuredClone(kv.get(k)), put: async (k, v) => void kv.set(k, structuredClone(v)), setAlarm: async () => {} } };
  const box = new BridgeMailbox(state, { now: () => t });
  return { box, tick: (ms) => (t += ms) };
}

test("the mailbox: a call waits for its answer, one run holds it, and an open's answer names the preview's id", async () => {
  const { box, tick } = mailbox();
  assert.deepEqual(await box.serve("bridge.open", { pr: 12, userId: "u_alice", sandboxId: "s1" }), { ok: true });
  assert.equal((await box.serve("bridge.open", { pr: 12, userId: "u_alice", sandboxId: "s1" })).error, "taken");
  const opened = box.serve("bridge.call", { kind: "open", body: { op: "open" }, waitMs: 5_000 });
  // A Durable Object's input gate keeps one call's read and write together; the in-memory storage here does not.
  await new Promise((r) => setTimeout(r, 5));
  const taken = await box.serve("bridge.take", { run: "77", waitMs: 0 });
  assert.equal(taken.pr, 12);
  assert.deepEqual(taken.calls.map((c) => c.n), [1]);
  assert.equal((await box.serve("bridge.take", { run: "78", waitMs: 0 })).refused, "another run holds this test chat", "another run is refused");
  assert.equal((await box.serve("bridge.answer", { run: "78", n: 1, status: 200, answer: {} })).refused, "another run holds this test chat");
  await box.serve("bridge.answer", { run: "77", n: 1, status: 200, answer: { sandboxId: PREVIEW_ID } });
  assert.deepEqual(await opened, { status: 200, answer: { sandboxId: PREVIEW_ID } });
  assert.equal((await box.serve("bridge.status", {})).previewId, PREVIEW_ID);
  // The run that held it went quiet: another may take it over.
  tick(RUNNER_GONE_MS + 1);
  assert.ok(Array.isArray((await box.serve("bridge.take", { run: "78", waitMs: 0 })).calls));
});

test("a call nobody took is dropped at its timeout, never run twice; an open stays for the run", async () => {
  const { box } = mailbox();
  await box.serve("bridge.open", { pr: 12, userId: "u_alice", sandboxId: "s1" });
  const sent = await box.serve("bridge.call", { body: { op: "send", text: "hi" }, waitMs: 0 });
  assert.equal(sent.timeout, true);
  assert.equal(sent.dropped, true, "dropped, never run twice");
  const open = await box.serve("bridge.call", { kind: "open", body: { op: "open" }, waitMs: 0 });
  assert.equal(open.dropped, false);
  assert.deepEqual((await box.serve("bridge.take", { run: "77", waitMs: 0 })).calls.map((c) => c.body.op), ["open"]);
});

test("Reset stops the run and answers every waiting call", async () => {
  const { box } = mailbox();
  await box.serve("bridge.open", { pr: 12, userId: "u_alice", sandboxId: "s1" });
  const waiting = box.serve("bridge.call", { body: { op: "send" }, waitMs: 5_000 });
  await new Promise((r) => setTimeout(r, 5));
  await box.serve("bridge.stop", {});
  assert.equal((await waiting).status, 410);
  assert.equal((await box.serve("bridge.take", { run: "77", waitMs: 0 })).stop, true);
  assert.equal((await box.serve("bridge.call", { body: { op: "send" } })).error, "stopped");
});

/** Production's route with a fake control plane, the mailbox door, and a fake preview behind a carry loop. */
function world() {
  const env = { LAB_SANDBOX: objects(), CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const people = { [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" }, [BOB]: { userId: "u_bob", workspaceId: "ws_bob" } };
  const dispatched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const who = people[body.accessToken];
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!who) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: who.userId, chats: [] });
    if (body.action === "previewChat") {
      dispatched.push(body.args);
      return answer({ status: "ok" });
    }
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, {});
    return { status: response.status, body: await response.json() };
  };
  const door = async (body) => {
    const response = await handleBridge(new Request("https://gateway.example.invalid/tex-lab/sandbox/bridge", { method: "POST", headers: { authorization: "Bearer eyJ.fake.token" }, body: JSON.stringify(body) }), env, { verify: async () => ({ claims: { run_id: "77" } }) });
    return { status: response.status, answer: await response.json() };
  };
  return { env, call, door, dispatched, restore: () => (globalThis.fetch = original) };
}

test("a test chat with code \"#12\" opens on the preview, its calls carried there and the preview's id put back", async () => {
  const w = world();
  try {
    const opened = await w.call(ALICE, { op: "open", code: "#12", source: "maya" });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.code, "#12", "opens on the preview");
    assert.equal(opened.body.preview.starting, true);
    assert.equal(w.dispatched.length, 1);
    assert.equal(w.dispatched[0].pr, 12);
    const ours = opened.body.sandboxId;

    // Before the preview answered the open: get says starting, a text is refused saying so.
    assert.equal((await w.call(ALICE, { op: "get", sandboxId: ours })).body.preview.starting, true);
    assert.equal((await w.call(ALICE, { op: "send", sandboxId: ours, text: "hi" })).status, 409);
    // Another person's test chat does not exist for them.
    assert.equal((await w.call(BOB, { op: "get", sandboxId: ours })).status, 404);
    assert.equal((await w.call(ALICE, { op: "list" })).body.chats.find((c) => c.sandboxId === ours).code, "#12");

    // The workflow: the preview answers each call (its own id for the test chat), carried by the same loop CI runs.
    const seen = [];
    const preview = async (body) => {
      seen.push(body);
      if (body.op === "open") return { status: 200, answer: { sandboxId: PREVIEW_ID, people: [{ handle: "maya" }], rows: [] } };
      if (body.op === "send") return { status: 200, answer: { sandboxId: body.sandboxId, rowId: "t1", line: `/lab?testchat=${body.sandboxId}` } };
      if (body.op === "reset") return { status: 200, answer: { ok: true } };
      return { status: 200, answer: { sandboxId: body.sandboxId, rows: [{ id: "t1" }] } };
    };
    let rounds = 0;
    const prod = async (body) => {
      if (body.op === "take" && ++rounds > 30) return { status: 200, answer: { stop: true } };
      return await w.door({ ...body, waitMs: 20, bridge: w.dispatched[0].bridge });
    };
    const ran = carry({ pr: 12, prod, preview, log: () => {} });

    let sent;
    for (let i = 0; i < 50 && !sent; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const tried = await w.call(ALICE, { op: "send", sandboxId: ours, text: "hi" });
      if (tried.status === 200) sent = tried;
    }
    assert.ok(sent, "a text is answered once the preview's open is");
    assert.equal(seen[0].op, "open");
    assert.equal(seen[0].versionId, "main");
    const forwarded = seen.find((b) => b.op === "send");
    assert.equal(forwarded.sandboxId, PREVIEW_ID, "the preview is asked with its own id");
    assert.equal(forwarded.text, "hi");
    assert.equal(sent.body.sandboxId, ours, "the preview's id is put back");
    assert.equal(sent.body.line, `/lab?testchat=${ours}`);
    assert.equal((await w.call(ALICE, { op: "about", sandboxId: ours })).body.code, "#12");

    // Reset: the preview's test chat too, the run told to stop, the stand-in gone.
    assert.equal((await w.call(ALICE, { op: "reset", sandboxId: ours })).status, 200);
    assert.equal(await ran >= 2, true);
    assert.ok(seen.some((b) => b.op === "reset" && b.sandboxId === PREVIEW_ID), "the preview's test chat is reset too");
    assert.equal((await w.call(ALICE, { op: "get", sandboxId: ours })).status, 404);
  } finally {
    w.restore();
  }
});

test("a bad code is refused before anything starts", async () => {
  const w = world();
  try {
    const refused = await w.call(ALICE, { op: "open", code: "feature/x" });
    assert.equal(refused.status, 400);
    assert.equal(w.dispatched.length, 0);
  } finally {
    w.restore();
  }
});

test("the carry loop stops on a wrong pull request, a refusal, or a reset", async () => {
  const run = async (answers) => {
    const queue = [...answers];
    return await carry({ pr: 12, prod: async () => queue.shift() ?? { status: 200, answer: { stop: true } }, preview: async () => ({ status: 200, answer: {} }), log: () => {} });
  };
  const before = process.exitCode;
  assert.equal(await run([{ status: 200, answer: { pr: 13, calls: [] } }]), 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
  assert.equal(await run([{ status: 200, answer: { refused: "another run holds this test chat" } }]), 0);
  assert.equal(await run([{ status: 200, answer: { pr: 12, calls: [{ n: 1, body: { op: "get" } }] } }, { status: 200, answer: { stop: true } }]), 1);
});
