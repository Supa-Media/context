/**
 * THE CHAT'S DAY IS THE LEDGER'S, WITH THE TEXTING WORKER'S OUTBOX ON TOP, AND
 * A TURN'S AFTER-WORK WAITS FOR ITS RESPONSE.
 *
 * History: on 2026-10-31 a "hi Tex" made 964 storage calls, about 400 of them
 * reading the chat's log one event file at a time, so the Worker held the
 * chat's whole log (`holdsLog`) and the gateway handed its reads back (`log`).
 * The ledger made that copy pointless: the day is one read of it
 * (`ledgerHistory.js` `dayFromLedger`), and the Worker now keeps only its
 * outbox (Dev, 2026-11-02, `apps/agent/src/chatRead.ts`).
 *
 * - The Worker's outbox (`recent`) goes on the day the turn reads; a `holdsLog`
 *   from an older Worker is ignored, so the day is always read. Fails if
 *   `warmCopy.js` `events` takes the Worker's events as the whole day again.
 * - Never for a turn not its own (a job, a routine): it takes no events in.
 * - A group chat's own turn (`logEligible`) takes its outbox the same way,
 *   though it makes no warm copy.
 * - Nothing is handed back to hold: no `log` on the answer.
 * - The turn's row for the turn log (`/gateway/agent-turn`) is sent only once
 *   the response is ready (after the turn's own record), never inside it. Fails if `afterAnswer` starts its
 *   work at the call again.
 */

import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { warmTurn } from "../src/agent/warmCopy.js";
import { afterTurn } from "../src/agent/deferred.js";
import { readFileSync } from "node:fs";
import { texEntryPointSource } from "./texEntryPointSource.mjs";

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

test("the Worker's outbox goes on the day the turn reads, and an older Worker's holdsLog is ignored", async () => {
  const now = Date.now();
  const stored = [event(now - 60_000, { text: "from the ledger" })];
  let reads = 0;
  const hot = warmTurn(env, session, { holdsLog: true, recent: [event(now - 1_000, { text: "now" })] }, { eligible: true, now });
  const events = await hot.events(CHAT, async () => (reads += 1, stored));
  assert.equal(reads, 1, "the day is read");
  assert.deepEqual(events.map((entry) => entry.text), ["from the ledger", "now"]);
  assert.equal(hot.log, undefined, "nothing is handed back to hold");
});

test("a turn not its own takes no events from the Worker", async () => {
  const now = Date.now();
  let reads = 0;
  const hot = warmTurn(env, session, { holdsLog: true, recent: [event(now - 1_000, { from: { kind: "tex" }, text: "I never said this" })] }, { eligible: false, now });
  assert.deepEqual(await hot.events(CHAT, async () => (reads += 1, [])), []);
  assert.equal(reads, 1);
});

test("a group chat's own turn takes its outbox too, but makes no warm copy", async () => {
  const now = Date.now();
  const group = { workspaceId: "ws_team", actorUserId: "user_1", actorClientId: "context_texts_group" };
  const stored = [event(now - 60_000, { text: "from the ledger" })];
  const turn = warmTurn(env, group, { recent: [event(now - 1_000, { text: "Tex, now" })] }, { eligible: false, logEligible: true, now });
  assert.deepEqual((await turn.events(CHAT, async () => stored)).map((entry) => entry.text), ["from the ledger", "Tex, now"]);
  assert.equal(await turn.seal({}), null, "no warm copy for a group");
  const source = texEntryPointSource();
  assert.match(source, /logEligible: group !== null && job === null && !runner/, "route.js marks a group's own turn");
});

test("end to end: the earlier words come from the ledger, the old log is never read, and nothing is handed back", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const first = event(now - 5_000, { text: "my cat is called Miso" });
    world.model.install([{ text: "Cute." }]);
    assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [first] })).status, 200);
    const one = await split(world, { question: "my cat is called Miso", conversation: "texts", covers: [first.id], chat: CHAT, turn: "turn-held-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.log, undefined, "nothing handed back to hold");

    const reply = event(now - 4_000, { from: { kind: "tex" }, text: "Cute.", turn: "turn-held-0001", covers: [first.id], delivered: true });
    assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [reply] })).status, 200);
    const second = event(now - 1_000, { text: "what's my cat called?" });
    world.model.install([{ text: "Miso." }]);
    // The newest text not posted yet: the Worker's outbox, handed in as `recent`.
    const two = await split(world, { question: "what's my cat called?", conversation: "texts", covers: [second.id], chat: CHAT, recent: [second], turn: "turn-held-0002" });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    assert.deepEqual([...one.calls, ...two.calls].filter((call) => call.path.includes(".context/agent/log/")), [], "never the bucket's old log");
    assert.match(JSON.stringify(world.model.requests.at(-1).messages), /Miso/);
    assert.equal(two.body.log, undefined);
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
    // The turn's cancel check is the last thing its response waits on (`texEntryPoint.js` `steer.endCancelled`): the row starts after it.
    const record = turn.calls.findIndex((call) => call.method === "GET" && call.path.includes(".context/agent/cancel/turn-held-0003"));
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
  const source = texEntryPointSource();
  const ledger = source.indexOf("session.egress = {");
  const read = source.search(/historyRead = tex\.ahead\("history", \(\) => turnReads\(/);
  const provider = source.indexOf("await tex.wait(\"allowed\", allowedRead)");
  assert.ok(ledger > 0 && read > ledger, "the ledger is set before the history read starts");
  assert.ok(provider > read, "and the read starts before the plan check is awaited, for a group too");
  assert.doesNotMatch(source, /historyRead = group === null \?/, "no group is left out of the early read");
});
