// The Lab's test chats (src/labSandbox/; Dev2, 2026-11-16: "have all the changes in the workspace / group chat object
// be sandboxed so it doesn't actually affect production"; docs/decisions/texting-assistant/lab-sandbox.md).
//
// What these prove: a test turn's write never reaches the real object (it lands in the test chat's own object and is
// read back from there), nothing leaves (no control-plane write, no non-read tool, no texting Worker), and one person
// never reaches another's test chat or a chat they are not in. Fake ids and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-16):
//   wire.js `put` sent on to the real object            "a put lands in the test chat ..." fails
//   wire.js default branch answering the real object    "an unknown or writing op is refused ..." fails
//   policy.js `controlPlaneAnswer` passing every route   "a control-plane write is refused ..." fails
//   policy.js noNotes passing personal reads             "a shared test chat reads no mail ..." fails
//   policy.js READ_TOOLS holding send_email               "a tool that changes or sends ..." fails
//   route.js `sandboxStub` named without the userId       "another person's test chat ..." fails
//   texConfig.js `draftStep` ignoring the draft's model   "a draft's models, efforts ..." fails
//   aiGateway.js `tex` always main's config                "a draft's models, efforts ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject, sandboxTables, serveSandbox } from "../src/labSandbox/object.js";
import { sandboxNamespace } from "../src/labSandbox/wire.js";
import { CONTROL_PLANE_READS, controlPlaneAnswer, LAB_SANDBOX_KEY, NO_NOTES_PERSONAL_READS, sandboxedTool, sandboxEnvOf, sandboxGateOf, toolAnswer, withoutKeys } from "../src/labSandbox/policy.js";
import { sandboxGate, stepsOf, turnBody } from "../src/labSandbox/harness.js";
import { noteOwnWorkspace } from "../src/tools/etagPlace.js";
import { handleLabSandbox, MAX_DRAWN_GRAPH, MAYA_CONVO } from "../src/labSandbox/route.js";
import { withDraft } from "../src/agent/graph/turnGraph.js";
import { TEX_CONFIG, texConfigOf, texEffort, texModel, texSetupFront, texTimeoutMs, texWords } from "../src/agent/texConfig.js";
import { createTransport } from "../src/controlPlane/client.js";
import { createEmailMethods } from "../src/controlPlane/email.js";
import { createCalendarMethods } from "../src/controlPlane/calendar.js";
import { createGoogleChatMethods } from "../src/controlPlane/googleChat.js";
import { aiGatewayConfig } from "../src/agent/aiGateway.js";
import { texBucket, texStoreStub, texTimers } from "../src/texStore/wire.js";
import { durableSql, texStoreNamespace } from "./texStoreFixture.mjs";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

/** A test chat's object over an in-memory SQLite, and a namespace that hands it out by name. */
function sandboxNamespaceFixture() {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return objects.get(name);
  };
  return { objects, idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

/** One test chat about a group chat's Tex object, and the gate its text's turn carries. */
async function groupChatGate() {
  const ns = sandboxNamespaceFixture();
  const stub = ns.get(ns.idFromName("labsandbox:u1:0123456789abcdef"));
  const about = { kind: "group", owner: `chat:${KEY}`, ledgerChat: KEY };
  await stub.fetch(new Request("https://lab-sandbox.internal/init", { method: "POST", body: JSON.stringify({ about, rows: [], history: [] }) }));
  await stub.fetch(new Request("https://lab-sandbox.internal/row.add", { method: "POST", body: JSON.stringify({ row: { id: "t1", who: "ana", text: "hi", prod: false } }) }));
  return { stub, about, gate: sandboxGate(stub, about, "t1") };
}

const state = async (stub) => (await stub.fetch(new Request("https://lab-sandbox.internal/state", { method: "POST", body: "{}" }))).json();

test("a put lands in the test chat's object and is read back there; the real object never sees it", async () => {
  const real = texStoreNamespace();
  const { stub, gate } = await groupChatGate();
  const env = { TEX_STORE: sandboxNamespace(real.namespace, gate) };
  const bucket = texBucket(texStoreStub(env, { chat: KEY }));
  await bucket.put("notes/plan.md", "a test plan");
  assert.equal(await (await bucket.get("notes/plan.md")).text(), "a test plan", "read back from the overlay");
  assert.deepEqual(real.keysIn(`chat:${KEY}`), [], "the real object holds nothing");
  assert.ok(!real.calls.some((call) => call.op === "put"), "no put reached the real object");
  await bucket.delete("notes/plan.md");
  assert.equal(await bucket.get("notes/plan.md"), null, "a delete hides it");
  await gate.flush();
  const writes = (await state(stub)).writes;
  assert.ok(writes.some((w) => /saved notes\/plan\.md/.test(w.summary) && w.by === "t1"), "the save is listed, by the text that made it");
});

test("a key the real object holds is read through until the test chat changes it", async () => {
  const real = texStoreNamespace();
  const direct = texBucket(texStoreStub({ TEX_STORE: real.namespace }, { chat: KEY }));
  await direct.put("notes/about.md", "the real about");
  const { gate } = await groupChatGate();
  const sandboxed = texBucket(texStoreStub({ TEX_STORE: sandboxNamespace(real.namespace, gate) }, { chat: KEY }));
  assert.equal(await (await sandboxed.get("notes/about.md")).text(), "the real about");
  await sandboxed.put("notes/about.md", "changed in the test");
  assert.equal(await (await sandboxed.get("notes/about.md")).text(), "changed in the test");
  assert.equal(real.textIn(`chat:${KEY}`, "notes/about.md"), "the real about", "the real note is as it was");
  const listed = await sandboxed.list({ prefix: "notes/" });
  assert.deepEqual(listed.objects.map((o) => o.key), ["notes/about.md"]);
});

test("the test chat's ledger is the sandbox's; another chat's is read as it is and never written", async () => {
  const real = texStoreNamespace();
  const { stub, gate } = await groupChatGate();
  const env = { TEX_STORE: sandboxNamespace(real.namespace, gate) };
  const ours = texBucket(texStoreStub(env, { chat: KEY }));
  const entry = { id: "ev1", at: Date.now(), kind: "text", event: "text", from: { kind: "person" }, text: "x" };
  await ours.ledgerAppend(KEY, [entry]);
  assert.equal((await ours.ledgerRead(KEY, { before: Number.MAX_SAFE_INTEGER })).entries.length, 1);
  assert.deepEqual(real.ledgerIn(`chat:${KEY}`, KEY), [], "nothing in the real ledger");
  const theirs = texBucket(texStoreStub(env, { chat: OTHER_KEY }));
  await theirs.ledgerAppend(OTHER_KEY, [entry]);
  assert.deepEqual(real.ledgerIn(`chat:${OTHER_KEY}`, OTHER_KEY), [], "another chat's ledger is never written");
  assert.equal((await serveSandbox(sandboxTables(durableSql()), "state", {})).rows.length, 0);
  assert.equal((await state(stub)).meta.chat.ledgerChat, KEY);
});

test("an alarm never arms, and an unknown or writing op is refused and listed", async () => {
  const real = texStoreNamespace();
  const { stub, gate } = await groupChatGate();
  const env = { TEX_STORE: sandboxNamespace(real.namespace, gate), WORKSPACE_STORE: sandboxNamespace(real.namespace, gate) };
  const raw = texStoreStub(env, { chat: KEY });
  await texTimers(raw).schedule({ id: "r1", at: Date.now() + 60_000, payload: {} });
  assert.ok(!real.calls.some((call) => call.op === "schedule"), "no alarm reached the real object");
  const refusedCall = await raw.fetch(new Request("https://tex-store.internal/ws.rows.write", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.rows.write" })) } }));
  assert.equal(refusedCall.status, 422);
  const unnamed = await raw.fetch(new Request("https://tex-store.internal/x", { method: "POST" }));
  assert.equal(unnamed.status, 422);
  assert.ok(!real.calls.some((call) => call.op === "ws.rows.write"));
  await gate.flush();
  const kinds = (await state(stub)).writes.map((w) => w.kind);
  assert.ok(kinds.includes("reminder") && kinds.includes("other"), kinds.join());
});

test("a test chat reaches objects by name only", () => {
  const ns = sandboxNamespace({ idFromName: (name) => ({ name, toString: () => name }), get: () => ({}) }, { record() {} });
  assert.throws(() => ns.idFromString("abc"), /by name only/);
  assert.throws(() => ns.newUniqueId(), /makes no objects/);
  assert.throws(() => ns.get({ toString: () => "forged" }), /by name only/);
});

test("a control-plane write is refused and listed; reads pass; the storage binding comes back keyless", () => {
  const writes = [];
  const gate = { record: (w) => writes.push(w) };
  assert.deepEqual(controlPlaneAnswer("/gateway/email/send", { to: "x@example.invalid" }, gate), { refuse: 403 });
  assert.deepEqual(controlPlaneAnswer("/gateway/calendar/write", {}, gate), { refuse: 403 });
  assert.deepEqual(controlPlaneAnswer("/gateway/privacy", { op: "setAccess" }, gate), { refuse: 403 });
  assert.deepEqual(writes.map((w) => w.kind), ["Email", "Calendar", "Sharing"]);
  assert.deepEqual(controlPlaneAnswer("/gateway/time-zone", {}, gate), { pass: true });
  assert.deepEqual(controlPlaneAnswer("/gateway/privacy", { op: "resolveHandles" }, gate), { pass: true });
  assert.equal(controlPlaneAnswer("/gateway/binding", { startEncryptionRotation: true }, gate).refuse, 403);
  const binding = controlPlaneAnswer("/gateway/binding", {}, gate);
  assert.equal(binding.pass, true);
  assert.deepEqual(binding.transform({ binding: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "s3cr3t-example" } }), { binding: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "lab-sandbox-no-key" } });
  assert.equal(withoutKeys({ a: [{ password: "p" }] }).a[0].password, "lab-sandbox-no-key");
  assert.deepEqual(controlPlaneAnswer("/gateway/builtin-model", {}, gate), { answer: { verdict: { allowed: true, remaining: 100 } } });
  for (const path of CONTROL_PLANE_READS) assert.ok(!/send|write|create|delete|invite|set$/.test(path), `${path} reads only`);
});

test("the control-plane client sends nothing for a test turn's write, and sends a read", async () => {
  const sent = [];
  const gate = { record() {} };
  const env = { CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000", [LAB_SANDBOX_KEY]: gate };
  const { post } = createTransport(env, async (url) => (sent.push(url), new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })));
  await assert.rejects(post("/gateway/email/send", {}));
  await post("/gateway/time-zone", {});
  assert.deepEqual(sent, ["https://control.example.invalid/gateway/time-zone"]);
});

test("a tool that changes or sends is answered as done and listed; a read runs; a browser is refused", async () => {
  // A gate with no object behind it (`call`): every write falls through to the recorded stub, as before.
  const writes = [];
  const gate = { record: (w) => writes.push(w) };
  for (const name of ["send_email", "write_note", "remember", "background", "vault_list", "report_problem", "write"]) {
    const answer = await toolAnswer(name, { to: "x@example.invalid" }, gate);
    assert.equal(answer.content[0].text, "Done.", `${name}: read as a real call's success, never as a test`);
  }
  for (const name of ["browse", "fill_login", "delegate", "add_computer"]) {
    const answer = await toolAnswer(name, {}, gate);
    assert.equal(answer.isError, true, name);
    assert.match(answer.content[0].text, /no browser and no computer/, name);
  }
  assert.equal(writes.filter((w) => w.kind === "Refused").length, 4);
  assert.equal(await toolAnswer("read_note", { path: "a.md" }, gate), null);
  assert.equal(await toolAnswer("search_email", {}, gate), null);
  // A job tool runs: the job it starts runs in the test chat (`jobs.js`), on the same fences.
  assert.equal(await toolAnswer("start_background_job", { title: "x", brief: "y" }, gate), null);
  assert.equal(writes[0].kind, "Email");
  assert.equal((await toolAnswer("write_note", { path: "tex/routines/x.md" }, gate)) && writes.at(-1).kind, "Reminder");
});

test("a real turn's tools run as they are: only a test turn's env carries the gate", async () => {
  const call = { name: "send_email", args: { to: "x@example.invalid" } };
  assert.equal(await sandboxedTool({ PLAIN: "x" }, call), null);
  assert.equal(await sandboxedTool({ [LAB_SANDBOX_KEY]: { notAGate: true } }, call), null, "a gate without record() is no gate");
  assert.equal((await sandboxedTool({ [LAB_SANDBOX_KEY]: { record() {} } }, call)).content[0].text, "Done.");
});

test("a test turn's env has no texting Worker, jobs, browser, chats or sandboxes, and analytics keep nothing", () => {
  const kept = [];
  const env = {
    PLAIN: "x", GATEWAY_SECRET: "gw", AGENT_WORKER_SECRET: "agent", AI: { run() {} },
    TEXTING: { fetch() {} }, SITE_SHOTS: {}, TEX_JOB: {}, TEX_CHAT: {}, LAB_SANDBOX: {}, PRESENCE_ROOM: {}, LIVE_TICKET: {}, TEX_EVAL: {},
    TEX_TIMING: { writeDataPoint: (p) => kept.push(p) },
  };
  const gate = { record() {} };
  const out = sandboxEnvOf(env, { gate, workspaces: { idFromName() {} }, tex: null });
  for (const name of ["TEXTING", "TEX_JOB", "TEX_CHAT", "LAB_SANDBOX", "PRESENCE_ROOM", "LIVE_TICKET", "TEX_EVAL", "AGENT_WORKER_SECRET", "TEX_STORE"]) assert.equal(out[name], undefined, name);
  assert.equal(out.PLAIN, "x");
  assert.equal(out.AI, env.AI);
  out.TEX_TIMING.writeDataPoint({ n: 1 });
  assert.deepEqual(kept, []);
  assert.equal(sandboxGateOf(out), gate);
  assert.equal(sandboxGateOf(env), null, "a real env carries no gate");
  assert.equal(out.SITE_SHOTS, undefined, "a screenshot binding with no fetch is not handed on");
});

test("retry, back and drop cut a test text's rows, writes, overlay and ledger entries, and keep the real start", () => {
  const tables = sandboxTables(durableSql());
  const real = { v: 1, id: "ev0", eid: "0000000000001-000001", at: 1, kind: "text", event: "text", from: { kind: "person" }, text: "real" };
  tables.init({ about: { ledgerChat: "texts" }, rows: [{ id: "r0", who: "You", text: "real", prod: true }], history: [real] });
  for (const n of [1, 2]) {
    tables.addRow({ id: `t${n}`, who: "You", text: `test ${n}`, prod: false });
    tables.ledgerAppend([{ id: `ev${n}`, at: n + 1, kind: "text", event: "text", from: { kind: "person" }, text: `test ${n}` }], `t${n}`);
    tables.addRow({ id: `t${n}r`, reply: `t${n}`, who: "Tex", text: `reply ${n}`, prod: false });
    tables.addWrite({ kind: "Note", summary: `saved ${n}`, by: `t${n}` });
    tables.kvPut("obj#chat", `notes/${n}.md`, { meta: { key: `notes/${n}.md` }, body: btoa(`n${n}`), by: `t${n}` });
  }
  tables.cutAfter("t1");
  assert.deepEqual(tables.rows().map((r) => r.id), ["r0", "t1", "t1r"]);
  assert.deepEqual(tables.writes().map((w) => w.summary), ["saved 1"]);
  assert.equal(tables.kvGet("obj#chat", "notes/2.md"), null);
  assert.equal(tables.ledger.read("texts", { before: Number.MAX_SAFE_INTEGER }).entries.length, 2);
  tables.cutFrom("t1");
  assert.deepEqual(tables.rows().map((r) => r.id), ["r0"]);
  assert.deepEqual(tables.writes(), []);
  assert.deepEqual(tables.ledger.read("texts", { before: Number.MAX_SAFE_INTEGER }).entries.map((e) => e.text), ["real"]);
  tables.wipe();
  assert.deepEqual(tables.rows(), []);
});

test("a draft's wiring runs only where every wire names a step; its on and off apply", () => {
  const first = TEX_CONFIG.nodes.find((n) => n.on !== false && n.id !== "readTheText");
  const draft = { nodes: [{ id: first.id, on: false }], edges: [{ from: "nope", to: "readTheText", mode: "wait" }] };
  const out = withDraft(TEX_CONFIG, draft);
  assert.equal(out.nodes.find((n) => n.id === first.id).on, false);
  assert.equal(out.edges, TEX_CONFIG.edges, "a wire to a step this config lacks keeps main's wiring");
  assert.equal(withDraft(TEX_CONFIG, null), TEX_CONFIG);
  assert.equal(TEX_CONFIG.nodes.find((n) => n.id === first.id).on, first.on, "main's config is untouched");
});

test("a draft's models, efforts, time limits and prompt words run in a test chat, and only there", async () => {
  const words = texWords(TEX_CONFIG);
  const draft = {
    nodes: [
      { id: "fd", model: "opus-5-5", effort: "high" },
      { id: "reviewer", model: "sonnet-5-5", effort: "medium", timeoutS: 12 },
      { id: "classifier", model: "lab-only-model" },
    ],
    edges: [],
    modules: { "p-rules": { text: "Draft rules only." } },
  };
  const out = withDraft(TEX_CONFIG, draft);
  assert.equal(texModel("fd", out), TEX_CONFIG.models["opus-5-5"]);
  assert.deepEqual(texEffort("fd", out), { effort: "high" });
  assert.equal(texModel("reviewer", out), TEX_CONFIG.models["sonnet-5-5"]);
  assert.equal(texTimeoutMs("reviewer", out), 12_000);
  assert.equal(texModel("classifier", out), texModel("classifier"), "a model main's table has no id for keeps main's");
  assert.equal(texWords(out).rules, "Draft rules only.");
  assert.equal(texWords(TEX_CONFIG).rules, words.rules, "main's words are untouched");
  // The texting setup a test turn reads takes the draft's front-door model and words.
  const front = texSetupFront(out);
  assert.equal(front.models.main, TEX_CONFIG.models["opus-5-5"]);
  assert.equal(front.models.effort, "high");
  // Through the env: a gate with the draft gives it, every real env gives main's.
  const gate = { record() {}, config: draft };
  assert.equal(texModel("reviewer", texConfigOf({ [LAB_SANDBOX_KEY]: gate })), TEX_CONFIG.models["sonnet-5-5"]);
  assert.equal(texConfigOf({}), TEX_CONFIG);
  // Each judge reads its model off the AI gateway config (`config?.tex`): a test turn's carries the draft, a real one's nothing.
  const road = { AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", AI_GATEWAY_ID: "tex", AI_GATEWAY_TOKEN: "x".repeat(32) };
  assert.equal(texModel("reviewer", aiGatewayConfig({ ...road, [LAB_SANDBOX_KEY]: gate }).tex), TEX_CONFIG.models["sonnet-5-5"]);
  assert.equal(aiGatewayConfig(road).tex, undefined);
  assert.equal(texModel("reviewer", texConfigOf({})), texModel("reviewer"));
});

test("a group test text is sent as the person written as, and steps come from the node entries", () => {
  const about = { kind: "group", chatKey: KEY, members: OTHER_KEY, people: [{ handle: "ana", name: "Ana" }, { handle: "kai", name: "Kai" }] };
  const body = turnBody({ about, text: "@Tex hi", as: "kai", eid: "1700000000000-000001", turn: "labturn01", rows: [{ who: "ana", text: "morning" }] });
  assert.equal(body.group.from, "kai");
  assert.deepEqual(body.group.chat, [{ from: "ana", text: "morning" }]);
  const guest = turnBody({ about, text: "hi", as: "Sam", eid: "1700000000000-000002", turn: "labturn02", rows: [] });
  assert.equal(guest.group.from, "");
  assert.equal(guest.group.asker, "Sam");
  assert.equal(turnBody({ about: { kind: "one" }, text: "hi", as: "You", eid: "1700000000000-000003", turn: "labturn03", rows: [] }).conversation, "texts");
  assert.deepEqual(stepsOf([{ kind: "step", step: "node", name: "fd", ms: 12, ok: true, output: { reply: "x" } }, { kind: "text" }]), [{ node: "fd", out: '{"reply":"x"}', ms: 12, ok: true }]);
});

/** The route over a fake control plane: `people` maps a token to who it is. */
function routeWorld(people, options = {}) {
  const ns = sandboxNamespaceFixture();
  const env = { LAB_SANDBOX: ns, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const who = people[body.accessToken];
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    if (!who) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: who.userId, chats: [{ key: KEY, name: "Team" }] });
    if (body.action === "set") return answer({ status: "not_found" });
    if (body.action === "draft") return answer({ status: "not_found" });
    if (body.action === "session") {
      if (body.args.chat !== "me") return answer({ status: "not_found", error: "There is no such chat." });
      return answer({ status: "ok", session: { grantId: "g1", clientId: "context_texts", actorUserId: who.userId, scopes: ["context:read"], defaultWorkspaceId: who.workspaceId, workspaces: [{ workspaceId: who.workspaceId, role: "owner", kind: "personal", slug: "alfa" }] }, people: [{ handle: "alfa", name: "You" }] });
    }
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, options);
    return { status: response.status, body: await response.json() };
  };
  return { call, env, ns, restore: () => (globalThis.fetch = original) };
}

const ALICE = "tok_alice_example_000000000000";
const BOB = "tok_bob_example_00000000000000";

test("a stranger is refused; the chats are the person's 1:1 and their groups", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" } });
  try {
    assert.equal((await w.call(BOB, { op: "chats" })).status, 403);
    // Each chat says what it is and how many people it holds (the Lab's picker; a count the control plane leaves out is 1).
    assert.deepEqual((await w.call(ALICE, { op: "chats" })).body.chats, [{ chatId: "me", name: "You and Tex", kind: "1:1", people: 1 }, { chatId: KEY, name: "Team", kind: "group", people: 1 }]);
    assert.equal((await w.call(ALICE, { op: "open", source: "chat", chatId: OTHER_KEY })).status, 404, "a chat they are not in does not exist");
  } finally {
    w.restore();
  }
});

test("a Dev conversation opens as a test chat; another person's test chat does not exist for them", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" }, [BOB]: { userId: "u_bob", workspaceId: "ws_bob" } });
  try {
    const opened = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip" });
    assert.equal(opened.status, 200);
    assert.match(opened.body.sandboxId, /^[0-9a-f]{16}$/);
    assert.ok(opened.body.rows.length > 0 && opened.body.rows.every((row) => row.prod === true && row.eid === undefined));
    const mine = await w.call(ALICE, { op: "get", sandboxId: opened.body.sandboxId });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.running, null);
    assert.equal((await w.call(BOB, { op: "get", sandboxId: opened.body.sandboxId })).status, 404);
    assert.equal((await w.call(BOB, { op: "reset", sandboxId: opened.body.sandboxId })).status, 404);
    assert.equal((await w.call(ALICE, { op: "drop", sandboxId: opened.body.sandboxId, msgId: opened.body.rows[0].id })).status, 400, "a real text is never cut");
    assert.equal((await w.call(ALICE, { op: "open", source: "set", convId: "no-such-conversation" })).status, 404);
    assert.equal((await w.call(ALICE, { op: "reset", sandboxId: opened.body.sandboxId })).status, 200);
    assert.equal((await w.call(ALICE, { op: "get", sandboxId: opened.body.sandboxId })).status, 404, "reset deletes it");
    // Maya's own conversation left the sets (Dev2, 2026-11-17): her test account opens fresh, with no history.
    assert.equal(MAYA_CONVO, "maya-and-tex");
    const maya = await w.call(ALICE, { op: "open", source: "maya" });
    assert.equal(maya.status, 200);
    assert.deepEqual(maya.body.rows, []);
  } finally {
    w.restore();
  }
});

test("about, use and read answer only the person's own test chat, and read only its own history file", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" }, [BOB]: { userId: "u_bob", workspaceId: "ws_bob" } });
  try {
    const opened = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip" });
    const sandboxId = opened.body.sandboxId;
    const about = await w.call(ALICE, { op: "about", sandboxId });
    assert.equal(about.status, 200);
    assert.equal(about.body.source, "set");
    assert.equal(about.body.kind, "1:1");
    assert.equal(about.body.versionId, "main");
    assert.equal(about.body.rows, opened.body.rows.length);
    assert.equal(about.body.testRows, 0);
    const read = await w.call(ALICE, { op: "read", sandboxId, options: { kinds: ["text"], limit: 3, chat: "someone-else" } });
    assert.equal(read.status, 200);
    assert.equal(read.body.entries.length, 3, "the limit is kept and a chat named in options is ignored");
    assert.ok(read.body.entries.every((entry) => entry.kind === "text"));
    assert.equal((await w.call(ALICE, { op: "use", sandboxId, versionId: "no-such-draft" })).status, 404, "a draft that is not there is refused");
    assert.equal((await w.call(ALICE, { op: "use", sandboxId, versionId: "main" })).body.versionId, "main");
    for (const op of ["about", "read", "use"]) assert.equal((await w.call(BOB, { op, sandboxId, versionId: "main" })).status, 404, `${op}: another person's test chat does not exist for them`);
  } finally {
    w.restore();
  }
});

test("list shows the person's own test chats, who opened and last used each; never another's; reset takes one off", async () => {
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" }, [BOB]: { userId: "u_bob", workspaceId: "ws_bob" } });
  try {
    const ai = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", by: "AI (Claude Code)" });
    const lab = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip" });
    await w.call(ALICE, { op: "use", sandboxId: lab.body.sandboxId, versionId: "main", by: "AI (Claude Code)" });
    const listed = (await w.call(ALICE, { op: "list" })).body.chats;
    assert.deepEqual(listed.map((c) => c.sandboxId), [lab.body.sandboxId, ai.body.sandboxId], "newest used first");
    assert.equal(listed[1].openedBy, "AI (Claude Code)");
    assert.equal(listed[0].openedBy, "Lab");
    assert.equal(listed[0].lastBy, "AI (Claude Code)");
    assert.equal(listed[0].running, null);
    assert.equal(listed[0].rows, lab.body.rows.length);
    assert.equal((await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", by: "<script>" })).status, 200);
    assert.ok((await w.call(ALICE, { op: "list" })).body.chats.every((c) => c.openedBy !== "<script>"), "a name that is not a name is the Lab");
    assert.deepEqual((await w.call(BOB, { op: "list" })).body.chats, [], "one person never lists another's");
    await w.call(ALICE, { op: "reset", sandboxId: ai.body.sandboxId });
    assert.ok(!(await w.call(ALICE, { op: "list" })).body.chats.some((c) => c.sandboxId === ai.body.sandboxId));
  } finally {
    w.restore();
  }
});

test("a computer list is read through; the binding cache and a turn's own run markers are not listed as changes", async () => {
  const real = texStoreNamespace();
  const { stub, gate } = await groupChatGate();
  const env = { TEX_STORE: sandboxNamespace(real.namespace, gate) };
  const raw = texStoreStub(env, { chat: KEY });
  const call = (op, body = "{}") => raw.fetch(new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body }));
  await call("ws.machine.list");
  assert.ok(real.calls.some((c) => c.op === "ws.machine.list"), "a computer list reaches the real object");
  const cached = await call("ws.binding.put", JSON.stringify({ sealed: "x" }));
  assert.equal(cached.status, 200);
  assert.ok(!real.calls.some((c) => c.op === "ws.binding.put"), "the binding is never written to the real object");
  const bucket = texBucket(raw);
  await bucket.put("state/agent/running/lab1.json", "{}");
  assert.equal(await (await bucket.get("state/agent/running/lab1.json")).text(), "{}", "the marker is kept for the turn");
  await bucket.delete("state/agent/running/lab1.json");
  await gate.flush();
  assert.deepEqual((await state(stub)).writes, [], "nothing listed");
});

test("a test chat opens on the whole real chat, never a cutoff; get pages with after and shows a running text's steps", async () => {
  const { eventEntry, ledgerFor, ONE_TO_ONE_CHAT } = await import("../src/agent/ledger.js");
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" } });
  const real = texStoreNamespace();
  w.env.TEX_STORE = real.namespace;
  try {
    const ledger = ledgerFor(w.env, { person: "ws_alice" });
    const start = Date.now() - 10_000_000;
    const TEXTS = 5_321; // over one ledger read (5,000) and over many seed pieces
    for (let at = 0; at < TEXTS; at += 100) {
      const entries = [];
      for (let i = at; i < Math.min(TEXTS, at + 100); i += 1) {
        // Each of Tex's texts is a turn's answer, kept with its `reply` and a step's log, as a real chat's ledger is.
        entries.push(eventEntry({ id: `${String(start + i).padStart(13, "0")}-${String(i).padStart(6, "0")}`, at: start + i, chat: ONE_TO_ONE_CHAT, kind: "text", from: i % 2 ? { kind: "tex" } : { kind: "person" }, text: `text ${i}`, ...(i % 2 ? { delivered: true, turn: `turn${i}` } : {}) }));
        if (i % 2) entries.push({ id: `turn${i}r`, at: start + i, kind: "reply", turn: `turn${i}`, clean: true }, { id: `turn${i}s`, at: start + i, kind: "step", step: "node", name: "fd", ok: true });
      }
      for (let from = 0; from < entries.length; from += 100) await ledger.append(ONE_TO_ONE_CHAT, entries.slice(from, from + 100));
    }
    const opened = await w.call(ALICE, { op: "open", source: "chat", chatId: "me" });
    assert.equal(opened.status, 200, JSON.stringify(opened.body).slice(0, 200));
    assert.equal(opened.body.rows.length, TEXTS, "every real text, none cut off");
    assert.equal(opened.body.rows[0].text, "text 0");
    assert.equal(opened.body.rows.at(-1).text, `text ${TEXTS - 1}`);
    const id = opened.body.sandboxId;
    // Tex's history in the test chat is the real chat's, rebuilt as a turn rebuilds it: every exchange, never none.
    const { conversationFromLedger } = await import("../src/agent/ledgerConversation.js");
    const { DESK_LEDGER } = await import("../src/texStore/desk.js");
    const copied = w.ns.get(w.ns.idFromName(`labsandbox:u_alice:${id}`));
    const read = await (await copied.fetch(new Request("https://lab-sandbox.internal/ledger.read", { method: "POST", body: JSON.stringify({ chat: ONE_TO_ONE_CHAT, options: { ...DESK_LEDGER.options, slim: false } }) }))).json();
    assert.ok(read.entries.some((entry) => entry.kind === "reply"), "the replies are copied");
    assert.ok(!read.entries.some((entry) => entry.kind === "step"), "the steps' logs are not");
    assert.ok(conversationFromLedger(read.entries).length > 0, "a turn there reads the chat's history");
    const all = await w.call(ALICE, { op: "get", sandboxId: id });
    assert.equal(all.body.rows.length, TEXTS);
    const tail = await w.call(ALICE, { op: "get", sandboxId: id, after: opened.body.rows.at(-3).id });
    assert.deepEqual(tail.body.rows.map((r) => r.text), [`text ${TEXTS - 2}`, `text ${TEXTS - 1}`]);
    assert.equal(tail.body.total, TEXTS);
    // A text running: its row carries the steps its turn reported so far.
    const stub = w.ns.get(w.ns.idFromName(`labsandbox:u_alice:${id}`));
    const call = async (op, fields) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(fields) }))).json();
    await call("row.add", { row: { id: "t1", who: "You", text: "hi", prod: false, at: Date.now() } });
    await call("meta", { key: "running", value: { msgId: "t1", node: "triage", at: Date.now(), steps: [{ node: "text", out: null, ms: 1, ok: true }, { node: "triage", out: null, ms: 2, ok: true }] } });
    const live = await w.call(ALICE, { op: "get", sandboxId: id, after: opened.body.rows.at(-1).id });
    assert.deepEqual(live.body.rows[0].steps.map((s) => s.node), ["text", "triage"]);
    assert.deepEqual(live.body.running.steps.map((s) => s.node), ["text", "triage"]);
  } finally {
    w.restore();
  }
});

// Dev2, 2026-11-16: a draft with edits not saved yet left the test chat on "There is no such draft." and its history,
// the texts to play, unreadable. The Lab sends the draft as drawn; its texts run that, and the chat says so.
test("a draft not saved yet opens with its history when the Lab sends it as drawn, and its texts run that draft", async () => {
  const ran = [];
  const runTurn = async ({ config }) => {
    ran.push(config);
  };
  const w = routeWorld({ [ALICE]: { userId: "u_alice", workspaceId: "ws_alice" } }, { runTurn });
  try {
    const first = TEX_CONFIG.nodes[0];
    const drawn = { nodes: [{ id: first.id, on: false }], edges: [] };
    const refusedOpen = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", versionId: "vunsaved1" });
    assert.equal(refusedOpen.status, 404, "a draft neither saved nor sent is still not there");
    assert.equal((await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", versionId: "vunsaved1", graph: "{not json" })).status, 400);
    assert.equal((await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", versionId: "vunsaved1", graph: JSON.stringify({ nodes: [] }) })).status, 400, "a graph has steps and wires");
    assert.equal((await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", versionId: "vunsaved1", graph: "x".repeat(MAX_DRAWN_GRAPH + 1) })).status, 400);

    const opened = await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", versionId: "vunsaved1", graph: JSON.stringify(drawn) });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.ok(opened.body.rows.length > 0, "the chat's history shows, to read and play");
    const sandboxId = opened.body.sandboxId;
    const about = await w.call(ALICE, { op: "about", sandboxId });
    assert.equal(about.body.versionId, "vunsaved1");
    assert.equal(about.body.drawn, true);
    assert.equal(about.body.graph, undefined, "the drawn graph is given only when asked");
    assert.deepEqual((await w.call(ALICE, { op: "about", sandboxId, graph: true })).body.graph, drawn);

    // A text without a graph (an AI texting in the chat the Lab opened) runs the draft as last drawn, not "no such draft".
    assert.equal((await w.call(ALICE, { op: "send", sandboxId, text: "hi" })).status, 200);
    assert.deepEqual(ran.at(-1), drawn);

    // A text the Lab sends carries the draft as drawn now, and the chat keeps it.
    const later = { nodes: [{ id: first.id, on: true }], edges: [] };
    const other = (await w.call(ALICE, { op: "open", source: "set", convId: "wedding-trip", versionId: "vunsaved1", graph: JSON.stringify(drawn) })).body.sandboxId;
    assert.equal((await w.call(ALICE, { op: "send", sandboxId: other, text: "hi", graph: JSON.stringify(later) })).status, 200);
    assert.deepEqual(ran.at(-1), later);
    assert.deepEqual((await w.call(ALICE, { op: "about", sandboxId: other, graph: true })).body.graph, later, "the chat keeps the draft its last text ran");
  } finally {
    w.restore();
  }
});

// A 1:1 test turn reads the person's group chats from the list the Lab read for this chat (`agent/groupChats.js`;
// Dev2, 2026-11-17), never from the control plane with the Lab's own token, and its reads run for real.
test("a 1:1 test turn's group list is the one the Lab read for the chat, and group_chats runs for real", async () => {
  const gate = { record: () => {}, groups: [{ key: "a".repeat(64), name: "Tex Devs", people: ["jhon"], lastSeenAt: 1 }] };
  assert.deepEqual(controlPlaneAnswer("/gateway/agent/identity", { accessToken: "lab_x", expectedWorkspaceId: "w", groups: true }, gate), { answer: { groups: gate.groups } });
  assert.deepEqual(controlPlaneAnswer("/gateway/agent/identity", { accessToken: "lab_x", groups: true }, { record: () => {}, groups: null }), { answer: { groups: null } });
  assert.deepEqual(controlPlaneAnswer("/gateway/agent/identity", { accessToken: "lab_x", expectedWorkspaceId: "w" }, gate), { pass: true });
  assert.equal(await toolAnswer("group_chats", { op: "search", words: "texas" }, { record: () => assert.fail("not recorded as a write") }), null);
  assert.equal(await toolAnswer("read_day", { day: "2026-11-09" }, { record: () => assert.fail("not recorded as a write") }), null);
});

test("a chat shared with the developers runs with none of its person's notes: an empty store of its own, never theirs", async () => {
  // Dev2, 2026-11-17: Sayo's shared 1:1 stalled on every test text: the store asked for his workspace's key with the
  // developer's token, which is handed only to its members, and the turn never started. It runs on an empty store now.
  const { storeForBinding } = await import("../src/store/factory.js");
  const shared = { noNotes: true, record: () => assert.fail("a store open is not a change") };
  const answered = controlPlaneAnswer("/gateway/binding", { expectedWorkspaceId: "ws_sharer" }, shared);
  assert.deepEqual(answered.answer.binding, { provider: "r2-binding", bindingName: "LAB_NO_NOTES", status: "active", workspaceId: "ws_sharer" }, "answered here, never sent with the developer's token");
  const env = sandboxEnvOf({ NATIVE_BINDINGS: "NOTES", NOTES: { get: async () => assert.fail("never the real bucket") } }, { gate: shared });
  const store = storeForBinding(answered.answer.binding, env);
  assert.equal(await store.get("areas/diary.md"), null, "every read is empty");
  await assert.rejects(store.put("areas/new.md", "x"), /without its person's notes/, "and nothing is kept");
  // The developer's own test chat is untouched: its binding is the real one, keys blanked.
  assert.deepEqual(controlPlaneAnswer("/gateway/binding", { expectedWorkspaceId: "ws_me" }, { record: () => {} }).pass, true);
  assert.equal(sandboxEnvOf({ NATIVE_BINDINGS: "NOTES" }, { gate: {} }).NATIVE_BINDINGS, "NOTES");
});

test("a shared test chat reads no mail, calendar, Google Chat or other personal data: empty here, never sent", async () => {
  // The session is the sharer's (`texLabSandbox.ts` `sharedSessionFor`) and the token on the turn is the caller's
  // (`sessionFromPayload` keeps it; `texLabSandbox.ts` sends none). A pass would ask the control plane with both, and
  // the answer would be whichever of the two that pair resolved to. Fake words only; the stub below is what a live
  // call would have returned, and it must never be asked.
  const LEAK = "sharer-lease-secret";
  const shared = { noNotes: true, record: () => assert.fail("an empty read is not a change") };
  const poisoned = {
    ok: true,
    results: [{ address: "sharer@example.invalid", id: "m1", threadId: "t", date: "2026-11-01T00:00:00.000Z", from: "landlord@example.invalid", to: "sharer@example.invalid", subject: LEAK, snippet: LEAK }],
    mailboxes: [{ address: "sharer@example.invalid", folder: "inbox/email", state: "ok" }],
    days: [{ address: "sharer@example.invalid", date: "2026-11-17", text: LEAK }],
    messages: [{ id: "c1", from: "them", text: LEAK, at: "2026-11-17T00:00:00.000Z" }],
    spaces: [{ name: "spaces/AAA", displayName: "Family" }],
    place: { space: "spaces/AAA" },
    from: "sharer@example.invalid",
    accounts: ["sharer@example.invalid"],
    mailbox: { name: "inbox", address: "sharer@example.invalid" },
    apps: [{ app: "slack", account: "sharer@example.invalid" }],
    identity: { name: "Sayo", phones: ["+15555550100"], emails: ["sharer@example.invalid"] },
    links: [{ url: "https://context.example.invalid/s/secret" }],
    profiles: [{ userId: "user_sharer", email: "sharer@example.invalid" }],
    machines: [{ machineId: "machine_sharer", workspaceId: "ws_sharer" }],
    google: { ok: true, url: "https://context.example.invalid/add-gmail" },
    status: "done",
    entries: [{ name: "bank", sites: ["bank.example"] }],
    allowed: true,
  };
  const sent = [];
  const env = {
    CONTROL_PLANE_URL: "https://control.example.invalid",
    GATEWAY_SECRET: "gw-secret-example-not-real-000000",
    [LAB_SANDBOX_KEY]: shared,
  };
  const { post } = createTransport(env, async (url) => {
    sent.push(String(url));
    return new Response(JSON.stringify(poisoned), { headers: { "content-type": "application/json" } });
  });
  const email = createEmailMethods({ post });
  const calendar = createCalendarMethods({ post });
  const chat = createGoogleChatMethods({ post });
  const token = "dev-token-example-not-real";
  const workspace = "ws_sharer";

  const searched = await email.personMailSearch(token, workspace, { query: "lease" });
  assert.equal(searched.ok, true);
  assert.deepEqual(searched.results, []);
  assert.deepEqual(searched.mailboxes, []);
  const opened = await email.personMailRead(token, workspace, "sharer@example.invalid", "m1");
  assert.deepEqual(opened, { ok: false, refused: "not_found" });
  const days = await calendar.personCalendarDays(token, workspace, { date: "2026-11-17", days: 1 });
  assert.equal(days.ok, true);
  assert.deepEqual(days.days, []);
  const recent = await chat.googleChatRecent(token, workspace, { since: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(recent, { ok: true, messages: [] });
  const convo = await chat.googleChatConversation(token, workspace, { space: "spaces/AAA" });
  assert.equal(convo.ok, true);
  assert.deepEqual(convo.messages, []);
  assert.equal(convo.place.space, "spaces/AAA");
  const dm = await chat.googleChatConversation(token, workspace, { to: "guest@example.invalid" });
  assert.equal(dm.ok, true);
  assert.deepEqual(dm.messages, []);
  const spaces = await chat.googleChatSpaces(token, workspace, {});
  assert.equal(spaces.ok, true);
  assert.deepEqual(spaces.spaces, []);
  assert.deepEqual(spaces.accounts, []);

  const direct = [
    ["/gateway/mail/get", { accessToken: token, mailboxId: "mb_example" }, { mailbox: null }],
    ["/gateway/mail/jobs", { accessToken: token, workspaceId: workspace, path: "inbox/x.md" }, { mailboxes: [] }],
    ["/gateway/mail-health", { accessToken: token, expectedWorkspaceId: workspace }, { mailboxes: [] }],
    ["/gateway/connect/apps", { accessToken: token, expectedWorkspaceId: workspace }, { apps: [] }],
    ["/gateway/workspaces/connect-google", { accessToken: token, expectedWorkspaceId: workspace, kind: "gmail" }, { google: null }],
    ["/gateway/links/list", { accessToken: token, expectedWorkspaceId: workspace }, { links: [] }],
    ["/gateway/access/profiles", { people: [{ userId: "user_sharer" }] }, { profiles: [] }],
    ["/gateway/machines/owned", { userId: "user_sharer" }, { machines: [] }],
    ["/gateway/machines/for-chat", { groupKey: "a".repeat(64) }, { machines: [] }],
    ["/gateway/transcription/consent", { accessToken: token, expectedWorkspaceId: workspace }, { allowed: false }],
    ["/gateway/agent/identity", { accessToken: token, expectedWorkspaceId: workspace }, { identity: null }],
    ["/gateway/agent/identity", { accessToken: token, asker: true }, { identity: null }],
    ["/gateway/vault/text", { accessToken: token, expectedWorkspaceId: workspace, op: "list" }, { status: "done", entries: [] }],
  ];
  for (const [path, body, answer] of direct) {
    assert.deepEqual(await post(path, body), answer, path);
    assert.equal(JSON.stringify(answer).includes(LEAK), false, path);
  }
  const covered = new Set([
    "/gateway/email/search", "/gateway/email/read", "/gateway/calendar/days", "/gateway/chat/recent", "/gateway/chat/spaces",
    ...direct.map(([path]) => path),
  ]);
  for (const route of NO_NOTES_PERSONAL_READS) assert.ok(covered.has(route), `${route} has no empty-read case`);
  assert.deepEqual(sent, [], "a shared test chat never calls the control plane for these");
  assert.equal(JSON.stringify(searched).includes(LEAK), false);
  assert.equal(JSON.stringify(days).includes(LEAK), false);
  assert.equal(JSON.stringify(recent).includes(LEAK), false);

  // The filtered group list stays (only chats shared with the developers). A vault change is still a refusal.
  const noted = [];
  const noting = { noNotes: true, groups: [{ key: "a".repeat(64), name: "Shared", people: ["jhon"], lastSeenAt: 1 }], record: (row) => noted.push(row) };
  assert.equal(controlPlaneAnswer("/gateway/agent/identity", { accessToken: token, groups: true }, noting).answer.groups.length, 1);
  assert.equal(controlPlaneAnswer("/gateway/vault/text", { op: "share", entry: "e1", to: "chat" }, noting).refuse, 403);
  assert.equal(noted.length, 1);

  // The developer's own test chat still reads for real.
  const ownSent = [];
  const own = createTransport(
    { ...env, [LAB_SANDBOX_KEY]: { record() {} } },
    async (url) => (ownSent.push(String(url)), new Response(JSON.stringify({ ok: true, results: [], mailboxes: [] }), { headers: { "content-type": "application/json" } })),
  );
  const ownSearch = await createEmailMethods({ post: own.post }).personMailSearch(token, "ws_me", { query: "lease" });
  assert.equal(ownSearch.ok, true);
  assert.deepEqual(ownSent, ["https://control.example.invalid/gateway/email/search"]);
});

test("a test chat refuses a write carrying another workspace's etag, as the gateway does (2026-11-17)", async () => {
  // The Lab replayed the incident: Tex read @crystal-care's index.md, then wrote the bare path with that etag, and the
  // stub said "Saved". The gate learns which workspace a plain path means from the routed reads (`etagPlace.js`).
  const writes = [];
  const gate = { record: (w) => writes.push(w) };
  noteOwnWorkspace(gate, "@seyi");
  const placed = "@crystal-care/n1:c2.doc.r0";
  const wrong = await toolAnswer("write_note", { path: "index.md", content: "x", expected_etag: placed }, gate);
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /@crystal-care/);
  assert.match(wrong.content[0].text, /@seyi\/index\.md/);
  assert.equal(writes.at(-1).kind, "Refused");
  const right = await toolAnswer("write_note", { path: "@crystal-care/index.md", content: "x", expected_etag: placed }, gate);
  assert.equal(right.isError, undefined, "addressed where it was read, it saves");
  // The same call naming both workspaces: the gateway refuses it in `addressByPath`, before the etag check. The test
  // chat answers the write itself, so it has to say that refusal rather than "Done."
  const two = await toolAnswer("write_note", { path: "@crystal-care/index.md", context: "@seyi", content: "x", expected_etag: placed }, gate);
  assert.equal(two.isError, true);
  assert.match(two.content[0].text, /names two workspaces/);
  assert.match(two.content[0].text, /@seyi/);
  assert.match(two.content[0].text, /@crystal-care/);
  assert.equal(writes.at(-1).kind, "Refused");
  assert.match(writes.at(-1).summary, /names two workspaces/);
  assert.doesNotMatch(two.content[0].text, /^Saved|^Done/);
  // Two sessions seen in one turn: the etag half checks nothing rather than refuse what the gateway would take.
  // Two names are still refused: the gateway refuses those whichever session the call ran in.
  noteOwnWorkspace(gate, "@context-lc");
  assert.equal((await toolAnswer("write_note", { path: "index.md", content: "x", expected_etag: placed }, gate)).isError, undefined);
  const twoAgain = await toolAnswer("write_note", { path: "@band/notes/a.md", context: "@seyi", content: "x" }, gate);
  assert.equal(twoAgain.isError, true);
  assert.match(twoAgain.content[0].text, /names two workspaces/);
});
