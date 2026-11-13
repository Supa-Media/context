// What reaches a chat's ledger (Dev2, 2026-11-02: "I want everything logged,
// including tool calls and the responses"): a texted turn's thinking, every
// tool call with its result, its reply, the chat's events, and a text Tex
// sent outside a turn. Another workspace's contents never do.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { appendConversation, appendTold, rememberRoutineText } from "../src/agent/conversation.js";
import { withTexRouting } from "../src/store/texRouting.js";
import { gatewayTexStore } from "../src/texStore/wire.js";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const CHAT = "sendblue:line:+15555550100";
let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });
const ledgerOf = (world) => ledgerFor(world.env, { person: "ws_egress" });

test("a texted turn keeps its thinking, each tool call with its result, and its reply in the chat's ledger", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const text = event(now - 5_000, { text: "what's in my notes?" });
    world.model.install([
      { thinking: "I should look at their notes first.", toolCalls: [{ name: "search", args: { query: "notes" } }] },
      { text: "Here's what I found." },
    ]);
    const turn = await request(world.env, TOKEN_TEXTS, "/agent", { question: text.text, conversation: "texts", covers: [text.id], chat: CHAT, recent: [text], turn: "turn-ledger-0001" });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    const { manifest, entries } = await ledgerOf(world).read(ONE_TO_ONE_CHAT);
    assert.equal(manifest.schema, "tex-ledger");
    const kinds = entries.map((entry) => entry.kind);
    assert.ok(kinds.includes("thinking"), kinds.join());
    const tool = entries.find((entry) => entry.kind === "tool");
    assert.match(tool.name, /^search/);
    assert.deepEqual(tool.args, { query: "notes" });
    assert.equal(typeof tool.result, "string", "the result the model was shown is kept");
    assert.equal(tool.turn, "turn-ledger-0001");
    const reply = entries.find((entry) => entry.kind === "reply");
    assert.match(reply.text, /Here's what I found/);
    assert.equal(reply.clean, true, "the gateway says the turn stayed clean, which is what a later turn trusts it by");
    assert.ok(kinds.indexOf("thinking") < kinds.indexOf("tool") && kinds.indexOf("tool") < kinds.indexOf("reply"), "in the order it happened");
    assert.equal(entries.filter((entry) => entry.kind === "note").length, 0, "the turn's own exchange is not written a second time as a note");
  } finally {
    world.restore();
  }
});

test("a call that read another workspace keeps the call and never its contents", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const text = event(now - 5_000, { text: "check the team notes" });
    world.model.install([{ toolCalls: [{ name: "search", args: { query: "plans", context: "@someone-else" } }] }, { text: "Done." }]);
    const turn = await request(world.env, TOKEN_TEXTS, "/agent", { question: text.text, conversation: "texts", covers: [text.id], chat: CHAT, recent: [text], turn: "turn-ledger-0002" });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    const tool = (await ledgerOf(world).read(ONE_TO_ONE_CHAT)).entries.find((entry) => entry.kind === "tool");
    assert.equal(tool.withheld, "other_workspace");
    assert.equal(tool.result, undefined);
    assert.equal(tool.args.context, "@someone-else");
  } finally {
    world.restore();
  }
});

test("the chat's events reach the ledger once each, however often they are posted", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const inbound = event(now - 2_000, { text: "hello" });
    const sent = event(now - 1_000, { from: { kind: "tex" }, text: "Hi!", delivered: true, covers: [inbound.id] });
    for (let i = 0; i < 2; i += 1) {
      const posted = await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [inbound, sent] });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
    }
    const texts = (await ledgerOf(world).read(ONE_TO_ONE_CHAT, { kinds: ["text"] })).entries;
    assert.deepEqual(texts.map((entry) => [entry.from.kind, entry.text]), [["person", "hello"], ["tex", "Hi!"]]);
    assert.equal(texts[1].delivered, true);
  } finally {
    world.restore();
  }
});

test("a text Tex sends outside a turn (a check-in) is kept as a note; the Worker's fixed texts and routines are not doubled", async () => {
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const bucket = { get: async () => null, head: async () => null, list: async () => ({ objects: [], delimitedPrefixes: [] }), put: async () => { throw new Error("the bucket is never written"); } };
  const store = withTexRouting(bucket, { workspaceId: "ws1", texStore: gatewayTexStore(env) });
  await appendConversation(store, "texts", "(check-in)", "Want me to forward both receipts?");
  await appendTold(store, "texts", ["setup"]);
  await rememberRoutineText(store, { path: "tex/routines/a.md", settings: {} }, "Morning!", false);
  const notes = (await ledgerFor(env, { person: "ws1" }).read(ONE_TO_ONE_CHAT, { kinds: ["note"] })).entries;
  assert.deepEqual(notes.map((entry) => [entry.text, entry.about]), [["Want me to forward both receipts?", "(check-in)"]]);
});

test("every step of a texted turn leaves its time and outcome in the ledger, under the turn (Dev2, 2026-11-13)", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const text = event(now - 5_000, { text: "what's in my notes?" });
    world.model.install([{ toolCalls: [{ name: "search", args: { query: "notes" } }] }, { text: "Here's what I found." }]);
    const turn = await request(world.env, TOKEN_TEXTS, "/agent", { question: text.text, conversation: "texts", covers: [text.id], chat: CHAT, recent: [text], turn: "turn-ledger-0009" });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { entries } = await ledgerOf(world).read(ONE_TO_ONE_CHAT);
    const steps = entries.filter((entry) => entry.kind === "step");
    const timed = steps.filter((entry) => entry.step === "timing");
    console.log(JSON.stringify(steps.map((e) => [e.step, e.name ?? "", e.ok])));
    const model = timed.find((entry) => entry.name === "model");
    assert.ok(model, "the model step is timed in the ledger");
    assert.equal(model.turn, "turn-ledger-0009");
    assert.equal(model.ok, true);
    assert.ok(Number.isFinite(model.ms));
    assert.ok(timed.length >= 5, `the front door's steps are there too (${timed.length})`);
  } finally {
    world.restore();
  }
});
