// The Lab's live sandbox (src/labSandbox/; Dev2, 2026-11-16: "the sandbox should act like an actual chat ... pretend
// it's a Photon iMessage thing ... It actually does the research things and sends messages and subagent responses to
// the sandbox chat ... all the write tools should work but in a sandbox that is discarded"; contract
// lab-live-sandbox/contract.md; docs/decisions/texting-assistant/lab-sandbox.md).
//
// What these prove: the line holds a text each way and says so as steps; every step has an id and the parent that
// started it, recorded as it ran (the runner names it), and a Tex row's `cause` is that chain; a running step shows with
// no `ms`; a note written in a test turn is read back by the next one and never reaches the real workspace; an email is
// kept whole and never sent; a page is served to the test chat's owner only and is gone after Reset; a background job
// the turn starts runs in the test chat through the job node and its text arrives as a Tex row `from: "job"`. Fake ids,
// numbers and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-16): see the decision doc's Tests paragraph for the list, each
// with the test that failed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../src/labSandbox/object.js";
import { sandboxGate } from "../src/labSandbox/harness.js";
import { measuredLine, MIN_SAMPLES, PHOTON_DEFAULT, PHOTON_NUMBER, MAX_HOLD_MS } from "../src/labSandbox/line.js";
import { stepBook, TRANSPORT_STEPS, fitSteps } from "../src/labSandbox/steps.js";
import { toolAnswer } from "../src/labSandbox/policy.js";
import { afterRead } from "../src/labSandbox/sandboxTools.js";
import { handleLabSandboxPage } from "../src/labSandbox/pages.js";
import { handleLabSandbox } from "../src/labSandbox/route.js";
import { runChatTurn } from "../src/labSandbox/chatRun.js";
import { streamTurn, wantsProgress } from "../src/agent/progress.js";
import { eventEntry } from "../src/agent/ledger.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { createGraph } from "../../../packages/shared/src/texGraph.cjs";
import { durableSql } from "./texStoreFixture.mjs";

const LINE = { name: "photon", number: PHOTON_NUMBER, inMs: 7_000, outMs: 11, measured: { in: 0, out: 0 } };
const ONE = { kind: "one", owner: "person:ws_a", ledgerChat: "texts", people: [{ handle: "ana", name: "You" }], line: LINE, sandboxId: "0123456789abcdef", origin: "https://gateway.example.invalid" };
const ALICE = "tok_alice_example_000000000000";
const BOB = "tok_bob_example_00000000000000";

/** A namespace of test chats' objects over in-memory SQLite, handed out by name. */
function objects() {
  const made = new Map();
  const object = (name) => {
    if (!made.has(name)) made.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return made.get(name);
  };
  return { made, idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

async function chatObject(about = ONE, name = `labsandbox:u_alice:${ONE.sandboxId}`, ns = objects()) {
  const stub = ns.get(ns.idFromName(name));
  const call = async (op, body = {}) => (await stub.fetch(new Request(`https://lab-sandbox.internal/${op}`, { method: "POST", body: JSON.stringify(body) }))).json();
  await call("init", { about, rows: [], history: [] });
  return { ns, stub, call };
}

const stepEntry = (step, provider, lagMs, extra = {}) =>
  step === "text"
    ? { kind: "step", step: "text", input: { provider: { name: provider, ...(lagMs === null ? {} : { lagMs }) } }, ...extra }
    : { kind: "step", step: "send", output: { name: provider, status: "delivered", ...(lagMs === null ? {} : { lagMs }) }, ...extra };

test("the line is Photon on the new number, its holds the p50 of the chat's own logged Photon deliveries", () => {
  const ins = [9000, 100, 500, 300, 700].map((ms) => stepEntry("text", "photon", ms));
  const outs = [4000, 1000, 3000, 2000, 26000, 5000].map((ms) => stepEntry("send", "photon", ms));
  const noise = [stepEntry("text", "sendblue", 99_000), stepEntry("send", "linq", 99_000), { kind: "step", step: "node", name: "fd" }];
  const line = measuredLine([...ins, ...outs, ...noise]);
  assert.equal(line.name, "photon");
  assert.equal(line.number, "+14157918922");
  assert.equal(line.inMs, 500, "the median of five, not their mean (a slow outlier would pull a mean)");
  assert.equal(line.outMs, 3500, "the median of six, between the middle two");
  assert.deepEqual(line.measured, { in: 5, out: 6 });
  // Too few samples one way: that way's default, and `measured` says none were used.
  const few = measuredLine(ins.slice(0, MIN_SAMPLES - 1));
  assert.deepEqual([few.inMs, few.outMs, few.measured.in], [PHOTON_DEFAULT.inMs, PHOTON_DEFAULT.outMs, 0]);
  assert.equal(measuredLine(Array.from({ length: 9 }, () => stepEntry("text", "photon", 10 * 60_000))).inMs, MAX_HOLD_MS, "never longer than the cap");
});

test("the runner names each run's id and the parent that started it, as it runs", async () => {
  const node = (id, extra = {}) => ({ id, ...extra });
  const config = {
    nodes: [node("a", { kind: "input" }), node("b"), node("c"), node("d")],
    edges: [
      { from: "a", to: "b", mode: "wait", when: ["*"] },
      { from: "b", to: "c", mode: "uses", when: ["*"] },
      { from: "b", to: "d", mode: "background", when: ["*"] },
    ],
  };
  const started = [];
  const logged = [];
  const graph = createGraph(config, { a: async () => ({}), b: async (_i, io) => (await io.use.c({}), {}), c: async () => ({}), d: async () => ({}) }, { log: (e) => logged.push(e), onStart: (e) => started.push(e) });
  await graph.run("a", {});
  const byNode = Object.fromEntries(logged.map((e) => [e.node, e]));
  assert.equal(byNode.a.parent, undefined, "the start has none");
  assert.equal(byNode.b.parent, byNode.a.id, "fed by a's wire");
  assert.equal(byNode.c.parent, byNode.b.id, "called by b");
  assert.equal(byNode.d.parent, byNode.b.id, "b's background wire");
  assert.deepEqual(started.map((e) => e.node), ["a", "b", "c", "d"], "each is told as it starts");
  assert.ok(started.every((e) => e.ms === undefined && typeof e.id === "string"), "a start has an id and no time yet");
});

test("a Tex text's cause is the chain from its line in to its line out, helpers in, the background out", () => {
  let t = 1_000;
  const book = stepBook({ rowId: "t1", arrivedAt: 1_000, config: TEX_CONFIG, now: () => (t += 5) });
  const lineIn = book.line("lineIn", { line: "photon" }, null, 1_000);
  book.end(lineIn, { out: {}, ms: 7 });
  book.worker({ node: "text", out: { outcome: "queued" }, ms: 0, ok: true });
  book.worker({ node: "triage", out: {}, ms: 0, ok: true });
  book.worker({ node: "lanes", out: {}, ms: 0, ok: true });
  const run = (node, id, parent, via) => {
    book.runStarted({ node, id, parent, via, at: t });
    return () => book.runEnded({ node, id, parent, via, ms: 3, ok: true, output: { node } });
  };
  run("readTheText", "r1", undefined, "wait")();
  const fd = run("fd", "r2", "r1", "wait");
  run("advisor", "r3", "r2", "fd:uses")();
  fd();
  run("checks", "r4", "r2", "wait")();
  run("send", "r5", "r4", "wait")();
  run("classifier", "r6", "r5", "background")();
  const out = book.line("lineOut", { chars: 3 }, book.deliverer());
  book.end(out, { out: { delivered: true }, ms: 11 });
  const nodes = (ids) => book.pick(ids).map((s) => s.node);
  assert.deepEqual(nodes(book.causeOf(out)), ["lineIn", "text", "triage", "lanes", "readTheText", "fd", "advisor", "checks", "send", "lineOut"]);
  const steps = book.view();
  assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, "ids are unique");
  assert.ok(steps.find((s) => s.node === "classifier").bg, "a background run is marked bg");
  assert.deepEqual(steps.filter((s) => s.kind === "line").map((s) => s.node), TRANSPORT_STEPS, "the line's steps are kind line");
  assert.equal(steps[0].at, 0, "the line in starts at the text's arrival");
  assert.equal(steps.find((s) => s.node === "fd").model, TEX_CONFIG.nodes.find((n) => n.id === "fd").model, "a model step says its model");
  assert.equal(fitSteps(steps.map((s) => ({ ...s, out: "x".repeat(50_000) })), 100_000).every((s) => s.out.length <= 4_001), true, "steps are cut to fit a row");
});

test("a running step shows in the test chat with no ms; it gets its time, output, calls and tokens as it ends", async () => {
  const { stub, call } = await chatObject();
  await call("claim", { msgId: "t1", staleMs: 60_000 });
  const gate = sandboxGate(stub, ONE, "t1", { arrivedAt: Date.now() });
  gate.onStart({ node: "fd", id: "r900001", at: Date.now() });
  await gate.flush();
  let running = (await call("state")).meta.running;
  assert.equal(running.steps.length, 1);
  assert.equal(running.steps[0].ms, undefined, "running: no ms yet");
  assert.equal(running.node, "fd");
  // The turn's tool entry, as its ledger writer appends it (the test chat's ledger may refuse this bare one: no matter).
  await gate.ledger(`x#${ONE.owner}`, "texts").append([{ kind: "tool", name: "read_note", args: { path: "projects/a.md" }, ms: 12, ok: true }]).catch(() => {});
  gate.usage({ model: "anthropic/claude-haiku-5-5", tokIn: 900, tokOut: 120 });
  gate.onNode({ node: "fd", id: "r900001", ms: 40, ok: true, output: { answer: "hi" } });
  await gate.flush();
  running = (await call("state")).meta.running;
  const [fd] = running.steps;
  assert.equal(fd.ms, 40);
  assert.deepEqual(fd.out, { answer: "hi" }, "the whole output");
  assert.deepEqual(fd.calls, [{ tool: "read_note", kind: "read", ms: 12, d: "read_note: projects/a.md" }]);
  assert.deepEqual([fd.tokIn, fd.tokOut], [900, 120]);
});

/** A gate over a fresh test chat, for one text. */
async function gateFor(rowId, chat) {
  const gate = sandboxGate(chat.stub, ONE, rowId, { arrivedAt: Date.now() });
  return gate;
}

test("a note written in a test turn is read back by the next, listed and found, and never reaches the real workspace", async () => {
  const chat = await chatObject();
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => (fetched.push(args), new Response("{}"));
  try {
    const first = await gateFor("t1", chat);
    const wrote = await toolAnswer("write_note", { path: "projects/trip.md", content: "# Trip\nLisbon in May." }, first);
    assert.match(wrote.content[0].text, /Saved projects\/trip\.md/);
    await first.flush();
    const next = await gateFor("t2", chat);
    const read = await toolAnswer("read_note", { path: "projects/trip.md" }, next);
    assert.equal(read.content[0].text, "# Trip\nLisbon in May.", "read back from the test chat");
    assert.equal(await toolAnswer("read_note", { path: "projects/other.md" }, next), null, "any other note is read for real");
    const listed = await afterRead("list_notes", { folder: "projects" }, { content: [{ type: "text", text: "projects/real.md" }] }, next);
    assert.match(listed.content.at(-1).text, /projects\/trip\.md/);
    const found = await afterRead("search_notes", { query: "lisbon" }, { content: [{ type: "text", text: "(nothing)" }] }, next);
    assert.match(found.content.at(-1).text, /projects\/trip\.md/);
    // `remember` on a real note: its line is kept here and shown below the real note when it is read.
    await toolAnswer("remember", { fact: "Ana is vegetarian.", kind: "stated", note: "people/ana.md" }, next);
    const real = await afterRead("read_note", { path: "people/ana.md" }, { content: [{ type: "text", text: "# Ana" }] }, next);
    assert.deepEqual(real.content.map((c) => c.text), ["# Ana", "Added to people/ana.md in this chat:\n- Ana is vegetarian."]);
    await next.flush();
    const writes = (await chat.call("state")).writes;
    assert.deepEqual(writes.map((w) => [w.kind, w.title, w.by]), [["note", "projects/trip.md", "t1"], ["note", "people/ana.md", "t2"]]);
    assert.ok(writes.every((w) => /^w\d+$/.test(w.id)), "every write has its id");
    assert.equal(writes[0].body, "# Trip\nLisbon in May.");
    assert.deepEqual(fetched, [], "nothing left the test chat");
  } finally {
    globalThis.fetch = original;
  }
});

test("an email is kept whole and never sent; a draft too", async () => {
  const chat = await chatObject();
  const fetched = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => (fetched.push(args), new Response("{}"));
  try {
    const gate = await gateFor("t1", chat);
    const sent = await toolAnswer("send_email", { to: ["jo@example.invalid"], cc: ["sam@example.invalid"], subject: "Dinner", body: "Seven at Ana's." }, gate);
    assert.match(sent.content[0].text, /Sent "Dinner" to jo@example\.invalid/);
    await toolAnswer("save_email_draft", { to: ["jo@example.invalid"], subject: "Later", body: "..." }, gate);
    await gate.flush();
    const [email, draft] = (await chat.call("state")).writes;
    assert.deepEqual({ kind: email.kind, to: email.to, cc: email.cc, subject: email.subject, body: email.body, sent: email.sent }, { kind: "email", to: ["jo@example.invalid"], cc: ["sam@example.invalid"], subject: "Dinner", body: "Seven at Ana's.", sent: false });
    assert.equal(draft.kind, "draft");
    assert.deepEqual(fetched, [], "no mail went anywhere");
  } finally {
    globalThis.fetch = original;
  }
});

/** The route and the page address over a fake control plane: Alice and Bob are both Tex developers. */
function pageWorld() {
  const ns = objects();
  const env = { LAB_SANDBOX: ns, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const user = body.accessToken === ALICE ? "u_alice" : body.accessToken === BOB ? "u_bob" : null;
    if (user === null) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: user, chats: [] });
    return answer({ status: "bad_request" });
  };
  const get = (url, token) => handleLabSandboxPage(new Request(url, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env, new URL(url).pathname);
  const route = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null);
    return { status: response.status, body: await response.json() };
  };
  return { ns, env, get, route, restore: () => (globalThis.fetch = original) };
}

test("a page is served to the test chat's owner only, never to whoever holds the link, and is gone after Reset", async () => {
  const w = pageWorld();
  try {
    const chat = await chatObject(ONE, `labsandbox:u_alice:${ONE.sandboxId}`, w.ns);
    const gate = await gateFor("t1", chat);
    await toolAnswer("write_note", { path: "projects/menu.page.md", content: "# Menu\n<script>alert(1)</script>" }, gate);
    await gate.flush();
    const page = (await chat.call("state")).writes.find((x) => x.kind === "page");
    assert.match(page.url, /^https:\/\/gateway\.example\.invalid\/tex-lab\/sandbox\/page\/0123456789abcdef\/[0-9a-f]{32}$/);
    assert.ok(page.expires > Date.now());
    const mine = await w.get(page.url, ALICE);
    assert.equal(mine.status, 200);
    assert.equal(await mine.text(), "# Menu\n<script>alert(1)</script>");
    assert.match(mine.headers.get("content-type"), /^text\/markdown/);
    assert.match(mine.headers.get("content-security-policy"), /sandbox/);
    const html = await (await w.get(`${page.url}?as=html`, ALICE)).text();
    assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;"), "escaped, never run");
    // A later turn's edit shows at the same address.
    const later = await gateFor("t2", chat);
    await toolAnswer("write_note", { path: "projects/menu.page.md", content: "# Menu v2" }, later);
    assert.equal(await (await w.get(page.url, ALICE)).text(), "# Menu v2");
    // Anyone else, even another Tex developer holding the link, reaches an empty object: the address never existed.
    assert.equal((await w.get(page.url, BOB)).status, 404);
    assert.equal((await w.get(page.url, null)).status, 401);
    assert.equal((await w.get(page.url, "tok_stranger_000000000000000")).status, 403);
    assert.equal((await w.route(BOB, { op: "page", sandboxId: ONE.sandboxId, id: page.url.split("/").at(-1) })).status, 404);
    assert.equal((await w.route(ALICE, { op: "page", sandboxId: ONE.sandboxId, id: page.url.split("/").at(-1) })).body.text, "# Menu v2");
    // Reset: the page, the note, every write gone.
    assert.equal((await w.route(ALICE, { op: "reset", sandboxId: ONE.sandboxId })).status, 200);
    assert.equal((await w.get(page.url, ALICE)).status, 404);
    const after = await chat.stub.fetch(new Request("https://lab-sandbox.internal/note.get", { method: "POST", body: JSON.stringify({ path: "projects/menu.page.md" }) }));
    assert.equal(after.status, 410, "the test chat is gone: its notes with it");
    assert.deepEqual((await chat.call("state")).writes, []);
  } finally {
    w.restore();
  }
});

test("Drop takes a text's notes, pages and writes with it; the texts before keep theirs", async () => {
  const chat = await chatObject();
  for (const id of ["t1", "t2"]) await chat.call("row.add", { row: { id, who: "ana", text: id, at: Date.now(), prod: false } });
  const one = await gateFor("t1", chat);
  await toolAnswer("write_note", { path: "a.md", content: "one" }, one);
  const two = await gateFor("t2", chat);
  await toolAnswer("write_note", { path: "b.page.md", content: "two" }, two);
  await one.flush();
  await two.flush();
  await chat.call("cut.from", { id: "t2" });
  assert.equal((await chat.call("note.get", { path: "b.page.md" })).found, null);
  assert.equal((await chat.call("note.get", { path: "a.md" })).found.body, "one");
  assert.deepEqual((await chat.call("state")).writes.map((w) => w.by), ["t1"]);
});

test("one tenant's test chat never reads another's notes", async () => {
  const ns = objects();
  const alice = await chatObject(ONE, "labsandbox:u_alice:0123456789abcdef", ns);
  const bob = await chatObject(ONE, "labsandbox:u_bob:0123456789abcdef", ns);
  await toolAnswer("write_note", { path: "secret.md", content: "alice only" }, await gateFor("t1", alice));
  assert.equal(await toolAnswer("read_note", { path: "secret.md" }, await gateFor("t1", bob)), null, "Bob's test chat has no such note: it reads the real one");
});

/**
 * `/agent` and the texting routes as a gateway answers them, recorded: a text's turn starts a job (`jobs`), the job's
 * own turn answers its result, and the chat's report turn texts it.
 */
function jobGateway(call, rowId) {
  const asked = [];
  const agentRoute = async (request, path) => {
    const body = await request.json().catch(() => ({}));
    asked.push({ path, body });
    if (path === "/agent") {
      const answer = body.job
        ? { answer: "Three caterers: Ana's Kitchen, Blue Fig, Olive.", turn: body.turn ?? "j" }
        : body.event === "job_report"
          ? { answer: "Found three caterers: Ana's Kitchen, Blue Fig and Olive.", turn: body.turn ?? "r" }
          : { answer: "On it: looking for caterers now.", turn: body.turn ?? "t", jobs: [{ id: "job0caterers1", title: "Find caterers", brief: "Three caterers near Ana with a price per person.", doneWhen: "three caterers with prices" }] };
      const reply = () => Response.json(answer);
      return wantsProgress(request) ? streamTurn(async () => reply()) : reply();
    }
    if (path === "/agent/events") {
      await call("ledger.append", { entries: (body.events ?? []).map(eventEntry), by: rowId });
      return Response.json({ written: [...new Set((body.events ?? []).map((e) => e.id))] });
    }
    return Response.json({ events: [] });
  };
  const textsRoute = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/texts/old-line") return Response.json({ to: "pass" });
    return Response.json({ error: "unknown_route" }, { status: 404 });
  };
  return { asked, agentRoute, textsRoute };
}

test("a job the turn starts runs in the test chat through the job node, and its text arrives as a Tex row from the job", async () => {
  const chat = await chatObject();
  const row = { id: "t1", who: "ana", text: "find us a caterer for Saturday", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  await chat.call("row.add", { row });
  const gw = jobGateway(chat.call, row.id);
  const held = [];
  await runChatTurn({ env: {}, stub: chat.stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: ONE.origin, agentRoute: gw.agentRoute, textsRoute: gw.textsRoute, sleep: async (ms) => void held.push(ms) });
  const state = await chat.call("state");
  const reply = state.rows.find((r) => r.id === "t1r");
  assert.equal(reply.text, "On it: looking for caterers now.");
  assert.equal(reply.from, "fd");
  assert.deepEqual(reply.line, { name: "photon", inMs: 7_000, outMs: 11 });
  assert.ok(gw.asked.some((a) => a.path === "/agent" && a.body.job), "the job's own turn was asked, as a job");
  const jobRows = state.rows.filter((r) => r.from === "job");
  assert.ok(jobRows.length >= 1, `a job text arrived (${state.rows.map((r) => `${r.id}:${r.from ?? ""}:${r.text}`).join(" | ")})`);
  assert.equal(jobRows[0].reply, "t1");
  assert.match(jobRows[0].text, /caterers/i);
  // Its cause runs from the text's line in, through the job's pass, to the line that delivered it.
  const steps = state.rows.find((r) => r.id === "t1r").steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const chain = jobRows[0].cause.map((id) => byId.get(id)?.node);
  assert.equal(chain[0], "lineIn");
  assert.equal(chain.at(-1), "lineOut");
  assert.ok(chain.includes("job"), `the job's pass is on its cause (${chain.join(" → ")})`);
  const pass = steps.find((s) => s.node === "job");
  assert.ok(pass.bg, "a job's pass is a background step");
  assert.ok(steps.every((s) => typeof s.id === "string" && Number.isFinite(s.at)), "every step has an id and a start");
  // The line held the text in once and each text out once.
  assert.ok(held[0] > 6_000 && held[0] <= 7_000, `held in for the line, less what the route spent (${held[0]})`);
  assert.ok(held.filter((ms) => ms === 11).length >= 2, `held out per text (${held.join(",")})`);
  assert.equal(state.meta.running, undefined, "nothing left running");
});

test("get names the line every new text uses, and a write's id, kind and title", async () => {
  const w = pageWorld();
  try {
    const chat = await chatObject(ONE, `labsandbox:u_alice:${ONE.sandboxId}`, w.ns);
    const gate = await gateFor("t1", chat);
    await toolAnswer("send_email", { to: ["jo@example.invalid"], subject: "Hi", body: "Hello." }, gate);
    await gate.flush();
    const got = await w.route(ALICE, { op: "get", sandboxId: ONE.sandboxId });
    assert.equal(got.status, 200);
    assert.deepEqual([got.body.line.name, got.body.line.inMs, got.body.line.outMs, got.body.line.number], ["photon", 7_000, 11, "+14157918922"]);
    const [write] = got.body.writes;
    assert.deepEqual([write.id, write.kind, write.title, write.summary, write.by], ["w1", "email", "Hi", "Hi", "t1"], "the old Lab's kind and summary still there");
  } finally {
    w.restore();
  }
});

test("a job on one of the person's computers is never run: its refusal is a step, and the chat hears it failed", async () => {
  const chat = await chatObject();
  const row = { id: "t1", who: "ana", text: "run the build on my laptop", at: Date.now(), prod: false, eid: "0000000000001-000001" };
  await chat.call("row.add", { row });
  const gw = jobGateway(chat.call, row.id);
  const agentRoute = async (request, path) => {
    if (path !== "/agent") return gw.agentRoute(request, path);
    const body = await request.clone().json().catch(() => ({}));
    if (body.job || body.event === "job_report") return gw.agentRoute(request, path);
    const machine = { workspaceId: "ws_a", machineId: "m_1", name: "laptop", tool: "claude", folder: "/home/ana/app" };
    return Response.json({ answer: "On it, on your laptop.", turn: "t", jobs: [{ id: "job0laptop01", title: "Run the build", brief: "Build the app.", doneWhen: "it builds", machine }] });
  };
  await runChatTurn({ env: {}, stub: chat.stub, about: ONE, row, payload: { defaultWorkspaceId: "ws_a" }, token: "caller-token", config: null, origin: ONE.origin, agentRoute, textsRoute: gw.textsRoute, sleep: async () => {} });
  const state = await chat.call("state");
  assert.ok(!gw.asked.some((a) => a.path === "/agent" && a.body.job), "the job's turn was never asked");
  const steps = state.rows.find((r) => r.id === "t1r").steps;
  const refused = steps.find((s) => s.node === "job" && s.ok === false);
  assert.ok(refused, `a refused job step (${steps.map((s) => s.node).join(", ")})`);
  assert.match(JSON.stringify(refused.out), /computer/);
  assert.ok(state.writes.some((x) => x.kind === "refused" && /computer/.test(x.title)), state.writes.map((x) => x.title).join(" | "));
});

// Review fixes (2026-11-16, an adversarial review of the live sandbox): a send raced with a send, a turn outliving Reset,
// an object made for an address nobody opened, a row counted by a pattern its own steps could defeat, and the runner
// shaping a node's input for a hook nobody set.

/** Test chats' objects that say which were armed, and which ever made their tables. */
function tracked() {
  const made = new Map();
  const alarms = new Map();
  const object = (name) => {
    if (!made.has(name)) made.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async (at) => void alarms.set(name, at), deleteAlarm: async () => void alarms.delete(name), deleteAll: async () => {} } }));
    return made.get(name);
  };
  return { made, alarms, idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
}

/** The route over a fake control plane that lets Alice open and text, with the turn the caller gives. */
function raceWorld(runTurn) {
  const ns = tracked();
  const env = { LAB_SANDBOX: ns, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
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
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${ALICE}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil: () => {} }, { runTurn, origin: "https://gateway.example.invalid" });
    return { status: response.status, body: await response.json() };
  };
  return { ns, env, call, restore: () => (globalThis.fetch = original) };
}

test("two texts sent at once to one test chat start one turn; the other is told one is running", async () => {
  let started = 0;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const runTurn = async () => {
    started += 1;
    await held;
  };
  runTurn.logsText = () => true;
  const w = raceWorld(runTurn);
  try {
    const opened = await w.call({ op: "open", source: "chat" });
    assert.equal(opened.status, 200);
    const [a, b] = await Promise.all([w.call({ op: "send", sandboxId: opened.body.sandboxId, text: "one" }), w.call({ op: "send", sandboxId: opened.body.sandboxId, text: "two" })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], "one turn claims the chat; the other is refused");
    assert.equal(started, 1, "one turn runs");
    const rows = (await w.call({ op: "get", sandboxId: opened.body.sandboxId })).body.rows.filter((row) => !row.prod);
    assert.equal(rows.length, 1, "the refused text left no row behind");
    release();
  } finally {
    w.restore();
  }
});

test("a test chat's running mark is claimed in the object: refused while fresh, taken over once stale, freed only by its own text", async () => {
  const chat = await chatObject();
  assert.equal((await chat.call("claim", { msgId: "t1", staleMs: 60_000 })).ok, true);
  assert.equal((await chat.call("claim", { msgId: "t2", staleMs: 60_000 })).ok, false, "a fresh mark holds");
  assert.equal((await chat.call("release", { msgId: "t2" })).ok, false, "another text never frees it");
  assert.equal((await chat.call("state")).meta.running.msgId, "t1");
  assert.equal((await chat.call("claim", { msgId: "t3", staleMs: 0 })).ok, true, "a mark older than the window is a turn that died");
  assert.equal((await chat.call("release", { msgId: "t3" })).ok, true);
  assert.equal((await chat.call("state")).meta.running, undefined);
});

test("a job that waits longer than the stale window keeps its text's running mark fresh", async () => {
  const { beatingSleep } = await import("../src/labSandbox/jobs.js");
  const { RUNNING_STALE_MS } = await import("../src/labSandbox/harness.js");
  let clock = 0;
  const beats = [];
  const sleep = beatingSleep(async (ms) => void (clock += ms), () => beats.push(clock));
  await sleep(15 * 60_000);
  assert.equal(clock, 15 * 60_000, "it slept the whole wait");
  const gaps = beats.map((at, i) => at - (beats[i - 1] ?? 0));
  assert.ok(beats.length > 0 && Math.max(...gaps, clock - beats.at(-1)) < RUNNING_STALE_MS, `a beat at least every stale window (${beats.join(",")})`);
});

test("Reset stops a running turn: its later writes are refused, nothing is kept, the alarm stays off, and its jobs do not run", async () => {
  const ns = tracked();
  const name = `labsandbox:u_alice:${ONE.sandboxId}`;
  const chat = await chatObject(ONE, name, ns);
  const gate = sandboxGate(chat.stub, ONE, "t1");
  await chat.call("reset", {});
  assert.equal(ns.alarms.has(name), false);
  await toolAnswer("write_note", { path: "secret/plan.page.md", content: "private words" }, gate).catch(() => null);
  gate.show();
  await gate.flush();
  assert.equal(gate.cancelled, true, "the gate knows its test chat is gone");
  const after = await chat.call("state");
  assert.deepEqual([after.meta, after.writes, after.rows], [{}, [], []], "nothing landed in the wiped object");
  const note = await chat.stub.fetch(new Request("https://lab-sandbox.internal/note.get", { method: "POST", body: JSON.stringify({ path: "secret/plan.page.md" }) }));
  assert.equal(note.status, 410, "a test chat that is gone answers nothing but init");
  assert.equal(ns.alarms.has(name), false, "and nothing armed it again");
  const { runJobs } = await import("../src/labSandbox/jobs.js");
  const book = stepBook({ rowId: "t1", arrivedAt: Date.now(), config: TEX_CONFIG });
  const registry = { jobs: new Map([["job:x", { name: "job:x", storage: { get: async () => ({}) }, inbox: { fetch: async () => assert.fail("a job of a reset test chat ran") } }]]) };
  const ran = await runJobs({ registry, gate, book, sleep: async () => {} });
  assert.deepEqual(ran.map((r) => r.outcome), ["reset"]);
});

test("asking for a test chat nobody opened makes nothing: no tables, no alarm", async () => {
  const w = raceWorld(async () => {});
  try {
    const id = "fedcba9876543210";
    const name = `labsandbox:u_alice:${id}`;
    const url = `https://gateway.example.invalid/tex-lab/sandbox/page/${id}/${"a".repeat(32)}`;
    const page = await handleLabSandboxPage(new Request(url, { headers: { authorization: `Bearer ${ALICE}` } }), w.env, new URL(url).pathname);
    assert.equal(page.status, 404);
    assert.equal((await w.call({ op: "get", sandboxId: id })).status, 404);
    assert.equal((await w.call({ op: "send", sandboxId: id, text: "hi" })).status, 404);
    assert.equal(w.ns.alarms.has(name), false, "never armed for a day");
    assert.equal(w.ns.made.get(name)?.tables ?? null, null, "its tables were never made");
  } finally {
    w.restore();
  }
});

test("a test row is counted toward the cap by its own column, whatever its steps hold", async () => {
  const { MAX_ROWS, sandboxTables } = await import("../src/labSandbox/object.js");
  const chat = await chatObject({ ...ONE });
  const tricky = (i) => ({ id: `t${i}r`, reply: `t${i}`, who: "Tex", text: "", prod: false, steps: [{ node: "tools", in: { args: { prod: true } } }] });
  for (let i = 0; i < MAX_ROWS; i += 1) await chat.call("row.add", { row: tricky(i) });
  const over = await chat.stub.fetch(new Request("https://lab-sandbox.internal/row.add", { method: "POST", body: JSON.stringify({ row: tricky(MAX_ROWS) }) }));
  assert.equal(over.status, 422, "the row past the cap is refused");
  assert.equal((await chat.call("state")).rows.length, MAX_ROWS);
  // A test chat made before the column: its rows get it from what they say, once.
  const sql = durableSql();
  sql.exec("CREATE TABLE sb_rows (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
  sql.exec("INSERT INTO sb_rows (seq, id, data) VALUES (1, 'p1', ?)", JSON.stringify({ id: "p1", prod: true }));
  sql.exec("INSERT INTO sb_rows (seq, id, data) VALUES (2, 't1', ?)", JSON.stringify({ id: "t1", prod: false, steps: [{ in: { prod: true } }] }));
  const tables = sandboxTables(sql);
  assert.throws(() => tables.seed({ rows: [{ id: "p2", prod: true }] }), /seeded after a test text/, "the old test row counts as one");
  assert.deepEqual(tables.rows().map((row) => row.id), ["p1", "t1"]);
});

test("the runner shapes a node's input once when nobody watches runs start", async () => {
  let reads = 0;
  const input = {};
  Object.defineProperty(input, "big", { enumerable: true, get: () => ((reads += 1), "x") });
  const graph = createGraph({ nodes: [{ id: "a", kind: "input" }], edges: [] }, { a: async () => ({}) }, { log: () => {} });
  await graph.runNode("a", input, {}, "wait");
  assert.equal(reads, 1, "shaped for the log only");
});
