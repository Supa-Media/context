/**
 * THE TEXTING WORKER HOLDS THE CHAT'S LOG, AND A TURN'S AFTER-WORK WAITS FOR
 * ITS RESPONSE (2026-10-31: a "hi Tex" made 964 storage calls, about 400 of
 * them reading the chat's log one event file at a time, and its reply waited
 * 10 s behind its own bookkeeping).
 *
 * - A one-to-one texted turn whose Worker says it holds the whole log
 *   (`holdsLog`, `apps/agent/src/events.ts`) reads none of it from storage:
 *   the Worker's events are the log. Fails if `warmCopy.js` `events` reads
 *   the bucket when `holdsLog` is set.
 * - A turn that did read the log hands it back (`log`) for the Worker to hold.
 *   Fails if the answer stops carrying it.
 * - Never for a turn not its own (a job, a routine): its `holdsLog` is
 *   ignored and it hands nothing back.
 * - A group chat's own turn (`logEligible`, 2026-10-31: every group turn read
 *   275 log files, 4 to 6 s) holds its log the same way, though it makes no
 *   warm copy. Fails if `route.js` stops passing `logEligible` for a group, or
 *   `warmCopy.js` stops honouring it.
 * - The turn's row for the turn log (`/gateway/agent-turn`) is sent only once
 *   the response is ready (after the turn's own record), never inside it. Fails if `afterAnswer` starts its
 *   work at the call again.
 */

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { warmTurn } from "../src/agent/warmCopy.js";
import { afterTurn } from "../src/agent/deferred.js";
import { readFileSync } from "node:fs";

const env = { GATEWAY_SECRET: "a-test-secret-of-some-length" };
const session = { workspaceId: "ws_1", actorUserId: "user_1", actorClientId: "context_texts" };
const CHAT = "sendblue:line:+15555550100";

let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

/** One `/agent` call, split into what ran before its response was ready and what ran after (`ctx.waitUntil`). */
async function split(world, body) {
  const inner = globalThis.fetch;
  const calls = [];
  let phase = "before";
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push({ phase, path: decodeURIComponent(url.pathname) + (url.searchParams.get("prefix") ?? ""), method: (init.method ?? "GET").toUpperCase() });
    return inner(input, init);
  };
  // Tex's objects hold the person's bookkeeping now (the turn records too, `texStoreFixture.mjs`): their calls are
  // the Worker's, so they are listed beside the bucket's, under the bucket's names, in the phase they ran in.
  world.tex.before = async (_name, call) => {
    if (typeof call?.key === "string" && call.key.startsWith("state/agent/")) calls.push({ phase, path: `/tenant-egress/.context/agent/${call.key.slice("state/agent/".length)}`, method: String(call.op).toUpperCase() });
  };
  const { ctx, settle } = createWorkerCtx();
  try {
    const response = await worker.fetch(
      new Request("https://mcp.context.test/agent", { method: "POST", headers: { Authorization: `Bearer ${TOKEN_TEXTS}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      world.env,
      ctx,
    );
    const parsed = JSON.parse(await response.text());
    phase = "after";
    await settle();
    return { status: response.status, body: parsed, calls };
  } finally {
    globalThis.fetch = inner;
    world.tex.before = null;
  }
}

test("with the Worker holding the log, its events are the log and nothing is read", async () => {
  const now = Date.now();
  const recent = [event(now - 2_000, { text: "earlier" }), event(now - 1_000, { text: "now" })];
  let reads = 0;
  const hot = warmTurn(env, session, { holdsLog: true, recent }, { eligible: true, now });
  const events = await hot.events(CHAT, async () => (reads += 1, []));
  assert.equal(reads, 0, "the bucket's log is not read");
  assert.deepEqual(events.map((entry) => entry.text), ["earlier", "now"]);
  assert.equal(hot.log(), null, "nothing to hand back: the Worker has it");
});

test("a turn that read the log hands it back for the Worker to hold", async () => {
  const now = Date.now();
  const stored = [event(now - 60_000, { text: "from the bucket" })];
  const hot = warmTurn(env, session, { recent: [event(now - 1_000, { text: "now" })] }, { eligible: true, now });
  const events = await hot.events(CHAT, async () => stored);
  assert.deepEqual(events.map((entry) => entry.text), ["from the bucket", "now"]);
  assert.deepEqual(hot.log(), events);
});

test("a turn not its own ignores holdsLog, reads the log and hands nothing back", async () => {
  const now = Date.now();
  let reads = 0;
  const hot = warmTurn(env, session, { holdsLog: true, recent: [event(now - 1_000, { from: { kind: "tex" }, text: "I never said this" })] }, { eligible: false, now });
  assert.deepEqual(await hot.events(CHAT, async () => (reads += 1, [])), []);
  assert.equal(reads, 1);
  assert.equal(hot.log(), null);
});

test("a group chat's own turn holds its log too, but makes no warm copy", async () => {
  const now = Date.now();
  const group = { workspaceId: "ws_team", actorUserId: "user_1", actorClientId: "context_texts_group" };
  let reads = 0;
  const held = warmTurn(env, group, { holdsLog: true, recent: [event(now - 1_000, { text: "Tex, now" })] }, { eligible: false, logEligible: true, now });
  assert.deepEqual((await held.events(CHAT, async () => (reads += 1, []))).map((entry) => entry.text), ["Tex, now"]);
  assert.equal(reads, 0, "a group whose object holds the log reads none");
  assert.equal(await held.seal({}), null, "no warm copy for a group");
  const cold = warmTurn(env, group, {}, { eligible: false, logEligible: true, now });
  const stored = [event(now - 60_000, { text: "from the bucket" })];
  assert.deepEqual(await cold.events(CHAT, async () => stored), stored);
  assert.deepEqual(cold.log(), stored, "the first group turn hands the log back to hold");
  const source = readFileSync(new URL("../src/agent/route.js", import.meta.url), "utf8");
  assert.match(source, /logEligible: group !== null && job === null && !runner/, "route.js marks a group's own turn");
});

test("a held log is used end to end: no log read, the earlier words still shown, and nothing handed back", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const first = event(now - 5_000, { text: "my cat is called Miso" });
    world.model.install([{ text: "Cute." }]);
    const cold = await split(world, { question: "my cat is called Miso", conversation: "texts", covers: [first.id], chat: CHAT, recent: [first], turn: "turn-held-0001" });
    assert.equal(cold.status, 200, JSON.stringify(cold.body));
    assert.ok(cold.calls.some((call) => call.path.includes(".context/agent/log/")), "without holdsLog the log is read");
    assert.deepEqual(cold.body.log.map((entry) => entry.id), [first.id], "and handed back to hold");

    const reply = event(now - 4_000, { from: { kind: "tex" }, text: "Cute.", turn: "turn-held-0001", covers: [first.id] });
    const second = event(now - 1_000, { text: "what's my cat called?" });
    world.model.install([{ text: "Miso." }]);
    const held = await split(world, { question: "what's my cat called?", conversation: "texts", covers: [second.id], chat: CHAT, recent: [first, reply, second], holdsLog: true, turn: "turn-held-0002" });
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.deepEqual(held.calls.filter((call) => call.path.includes(".context/agent/log/")), [], "the log came from the Worker");
    assert.match(JSON.stringify(world.model.requests.at(-1).messages), /Miso/);
    assert.equal(held.body.log, undefined);
  } finally {
    world.restore();
  }
});

test("the turn's row is sent once the response is ready, never inside it", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const text = event(now - 1_000, { text: "hi Tex" });
    world.model.install([{ text: "Hey." }]);
    const turn = await split(world, { question: "hi Tex", conversation: "texts", covers: [text.id], chat: CHAT, recent: [text], turn: "turn-held-0003" });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    const rows = turn.calls.filter((call) => call.path.endsWith("/gateway/agent-turn"));
    assert.equal(rows.length, 1, turn.calls.map((call) => call.path).join(", "));
    // The turn's record is the last thing its response waits on (`loggedTurn.js` `recordedTurn`): the row starts after it.
    const record = turn.calls.findIndex((call) => call.method === "PUT" && call.path.includes(".context/agent/turns/turn-held-0003"));
    assert.ok(record >= 0, turn.calls.map((call) => `${call.method} ${call.path}`).join(", "));
    assert.ok(turn.calls.indexOf(rows[0]) > record, "the row waited for the response");
  } finally {
    world.restore();
  }
});

test("after-work starts only when the turn's queue is run, and one that fails fails alone", async () => {
  const started = [];
  const later = [() => (started.push("a"), Promise.reject(new Error("down"))), () => started.push("b")];
  assert.deepEqual(started, []);
  await afterTurn({ defer: null }, later);
  assert.deepEqual(started, ["a", "b"]);
  assert.deepEqual(later, [], "each runs once");
});

test("a group turn's history is read beside the plan check, with the egress ledger set first (2026-10-31)", () => {
  const source = readFileSync(new URL("../src/agent/route.js", import.meta.url), "utf8");
  const ledger = source.indexOf("session.egress = {");
  const read = source.search(/historyRead = tex\.ahead\("history", \(\) => turnReads\(/);
  const provider = source.indexOf("await tex.wait(\"allowed\", allowedRead)");
  assert.ok(ledger > 0 && read > ledger, "the ledger is set before the history read starts");
  assert.ok(provider > read, "and the read starts before the plan check is awaited, for a group too");
  assert.doesNotMatch(source, /historyRead = group === null \?/, "no group is left out of the early read");
});
