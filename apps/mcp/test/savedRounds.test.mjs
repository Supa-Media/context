/**
 * A TURN CARRIES ON WHERE ITS LAST TRY STOPPED (Dev2, 2026-11-17; `src/agent/savedRounds.js`, `turnResume.js`,
 * `texStore/rounds.js`; plan and code reviewed by Fable the same day).
 *
 * A texted turn that died after its tools ran is tried again by the Worker. The try after reads the snapshot the
 * first one kept in the chat's own home and goes on from it: no read runs twice, the model is asked once more, not
 * from the start. A call whose effect is more than its words (held for a yes, a job, a picture) is never carried on.
 *
 * Sabotage: make `resumedRounds` (`turnResume.js`) put nothing back and "a crashed turn's next try runs no tool again"
 * fails on the tool count, since the model searches again; make `carriesOn` (`savedRounds.js`) answer true and "a call
 * held for their yes freezes" fails; drop `covers` from `textKey` and "another text, another key" fails; drop the
 * `untrusted` restore in `carriedRounds` and "the outside-read mark travels" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { checkedSnapshot, PICTURE_LEFT_OUT, ROUNDS_RESULT_CHARS, textKey, keptMessage } from "../src/agent/savedRounds.js";
import { carriedRounds } from "../src/agent/turnResume.js";
import { ledgerFor, ledgerObserver, STEP_NAMES } from "../src/agent/ledger.js";
import { texRounds, ROUNDS_FRESH_MS } from "../src/texStore/rounds.js";
import { TexObjectRefused } from "../src/texStore/objects.js";
import { durableSql, texStoreNamespace } from "./texStoreFixture.mjs";

const SEARCH = { name: "search_notes", description: "Search notes", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } };
const EMAIL = { name: "send_email", description: "Send an email", inputSchema: { type: "object", properties: { to: { type: "string" } } }, annotations: { readOnlyHint: false } };
const QUESTION = "When is the dentist?";
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
const calls = (...list) => ({ choices: [{ message: { content: "", tool_calls: list.map(([id, name, args]) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }], usage: USAGE });
const words = (text) => ({ choices: [{ message: { content: text } }], usage: USAGE });

/** A model that searches until it has read a search's result, then answers from it: what a real one does. */
function searchesUntilFound() {
  const asked = [];
  return { asked, async run(_model, input) { asked.push(input); return input.messages.some((m) => m.role === "tool") ? words("Tuesday at 3pm.") : calls([`call_${asked.length}`, "search_notes", { query: "dentist" }]); } };
}

function scripted(replies) {
  const asked = [];
  return { asked, async run(_model, input) { asked.push(input); return replies.shift(); } };
}

function turn(ai, extra = {}) {
  const ran = [];
  const done = runTurn({
    question: QUESTION,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH, EMAIL],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    texting: true,
    callTool: async (name, args) => {
      ran.push(name);
      if (name === "send_email") return { content: [{ type: "text", text: "Held for their yes." }], held: true };
      return { content: [{ type: "text", text: `Dentist: Tuesday 3pm (found by ${args.query})` }] };
    },
    ...extra,
  });
  return { ran, done };
}

const keeping = () => {
  const kept = [];
  return { kept, keepRounds: { keep: (snapshot) => kept.push(structuredClone(snapshot)), marks: () => ({}) } };
};

test("a crashed turn's next try runs no tool again and goes on from where it was", async () => {
  // Try 1: one search, then the draft's check crashes (the gateway died in its checks).
  const { kept, keepRounds } = keeping();
  const first = turn(searchesUntilFound(), { keepRounds, answerCheck: async () => { throw new Error("checks crashed"); } });
  await assert.rejects(first.done, /checks crashed/);
  assert.deepEqual(first.ran, ["search_notes"]);
  assert.equal(kept.length, 1, "one call, one snapshot");
  const resumeFrom = checkedSnapshot(kept.at(-1));
  assert.ok(resumeFrom);
  assert.equal(resumeFrom.round, 1);
  assert.ok(resumeFrom.messages.some((m) => m.role === "tool" && /Tuesday 3pm/.test(m.text)), "the snapshot holds the tool's result");

  // Try 2: the model is asked once, with the search's result already in front of it.
  const ai = searchesUntilFound();
  const told = [];
  const second = turn(ai, { resumeFrom, observe: (event) => told.push(event) });
  const result = await second.done;
  assert.equal(result.answer, "Tuesday at 3pm.");
  assert.deepEqual(second.ran, [], "nothing it already did is done again");
  assert.equal(ai.asked.length, 1, "one model round, not the whole turn");
  assert.ok(JSON.stringify(ai.asked[0].messages).includes("Tuesday 3pm (found by dentist)"), "the model reads what the first try's search returned");
  assert.deepEqual(result.steps, [{ tool: "search_notes", ok: true, resumed: true }], "its calls are the turn's own, marked resumed");
  const resumed = told.find((event) => event.kind === "model" && event.step === "resumed");
  assert.deepEqual(resumed?.input, { round: 1, calls: ["search_notes"] });
  assert.equal(told.filter((event) => event.kind === "tool").length, 0, "the first try's calls are never logged again as run");
});

test("a call held for their yes freezes the snapshot before it, so the next try asks again", async () => {
  // Round 1: a search (kept). Round 2: an email held for their yes (not kept), then a search (not kept: after the freeze).
  const { kept, keepRounds } = keeping();
  const first = turn(scripted([calls(["c1", "search_notes", { query: "a" }]), calls(["c2", "send_email", { to: "x@example.com" }]), calls(["c3", "search_notes", { query: "b" }]), words("Sent for your yes.")]), { keepRounds });
  await first.done;
  assert.deepEqual(first.ran, ["search_notes", "send_email", "search_notes"]);
  assert.equal(kept.length, 1, "only the round before the held call");
  assert.ok(!JSON.stringify(kept).includes("send_email"));
});

test("part of a round is kept as the calls that returned, without the round's thinking", async () => {
  // One round, two calls: a search, then an email held for their yes. The snapshot keeps the search alone.
  const { kept, keepRounds } = keeping();
  const reply = calls(["c1", "search_notes", { query: "a" }], ["c2", "send_email", { to: "x@example.com" }]);
  const first = turn(scripted([reply, words("Done.")]), { keepRounds });
  await first.done;
  assert.equal(kept.length, 1);
  const asked = kept[0].messages.find((m) => m.role === "assistant");
  assert.deepEqual(asked.toolCalls.map((c) => c.id), ["c1"]);
  assert.equal(asked.content, undefined);
  assert.deepEqual(kept[0].messages.filter((m) => m.role === "tool").map((m) => m.id), ["c1"]);
  assert.ok(checkedSnapshot(kept[0]), "every call it keeps has its result");
});

test("a try that comes back on its last round still gets one round to answer", async () => {
  const ai = scripted([words("Done.")]);
  const { done } = turn(ai, { maxRounds: 2, resumeFrom: { round: 7, messages: [{ role: "assistant", text: "", toolCalls: [{ id: "c", name: "search_notes", args: { query: "x" } }] }, { role: "tool", id: "c", name: "search_notes", text: "nothing" }] } });
  assert.equal((await done).answer, "Done.");
});

test("the resumed step reaches the chat's ledger as a step of its own", () => {
  assert.ok(STEP_NAMES.has("resumed"));
  const written = [];
  ledgerObserver({ write: (entry) => written.push(entry) }, null, { turn: "t2" })({ kind: "model", step: "resumed", ok: true, input: { round: 1, calls: ["search_notes"] }, output: { from: 1 }, reason: "went on" });
  assert.equal(written[0]?.step, "resumed");
  assert.equal(written[0]?.turn, "t2");
});

test("a snapshot that would hand the model a call with no result, or the wrong shape, is never used", () => {
  assert.equal(checkedSnapshot(null), null);
  assert.equal(checkedSnapshot({ v: 2, round: 1, messages: [{ role: "user", text: "x" }] }), null);
  assert.equal(checkedSnapshot({ v: 1, round: 0, messages: [{ role: "user", text: "x" }] }), null);
  assert.equal(checkedSnapshot({ v: 1, round: 1, messages: [{ role: "system", text: "x" }] }), null);
  assert.equal(checkedSnapshot({ v: 1, round: 1, messages: [{ role: "assistant", text: "", toolCalls: [{ id: "c", name: "s", args: {} }] }] }), null);
});

test("pictures stay out of a snapshot and a long result is cut", () => {
  const picture = keptMessage({ role: "tool", id: "p", name: "browse", text: "page", images: [{ data: "AAAA" }] });
  assert.equal(picture.images, undefined);
  assert.ok(picture.text.endsWith(PICTURE_LEFT_OUT));
  assert.ok(keptMessage({ role: "tool", id: "q", name: "s", text: "y".repeat(50_000) }).text.length < ROUNDS_RESULT_CHARS + 100);
});

test("another text, another key: the question, the chat events it answers, and a group's chat lines", async () => {
  const one = await textKey({ question: "hi", covers: ["e1"] });
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(await textKey({ question: "hi", covers: ["e1"] }), one);
  assert.notEqual(await textKey({ question: "hi", covers: ["e1", "e2"] }), one, "a newer text merged in");
  assert.notEqual(await textKey({ question: "hello", covers: ["e1"] }), one);
  assert.notEqual(await textKey({ question: "hi", covers: ["e1"], groupChat: [{ from: "A", text: "x" }] }), one, "a group that moved on");
  assert.equal(await textKey({ question: "hi", covers: [] }), null, "a text no event names is not carried on");
});

test("the chat's home keeps the newest snapshot per text, fresh for half an hour, wiped with the ledger", async () => {
  let now = 1_000_000;
  const rounds = texRounds(durableSql(), { now: () => now });
  const key = "a".repeat(64);
  rounds.put("texts", key, { v: 1, n: 1 });
  rounds.put("texts", key, { v: 1, n: 2 });
  assert.deepEqual(rounds.get("texts", key), { v: 1, n: 2 });
  assert.equal(rounds.get("other", key), null, "another chat's");
  assert.throws(() => rounds.get("texts", "not-a-key"), TexObjectRefused);
  now += ROUNDS_FRESH_MS + 1;
  assert.equal(rounds.get("texts", key), null, "stale");
  rounds.put("texts", "b".repeat(64), { v: 1 });
  rounds.forget("texts", "b".repeat(64));
  assert.equal(rounds.get("texts", "b".repeat(64)), null);
  assert.throws(() => rounds.put("texts", key, { v: 1, big: "x".repeat(2_000_000) }), TexObjectRefused);

  // Through the object, as the gateway reaches it: one person's never reaches another's, and wipe takes them.
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  await ledgerFor(env, { person: "ws1" }).keepRounds("texts", key, { v: 1, mine: true });
  assert.deepEqual(await ledgerFor(env, { person: "ws1" }).roundsOf("texts", key), { v: 1, mine: true });
  assert.equal(await ledgerFor(env, { person: "ws2" }).roundsOf("texts", key), null, "another person's home has none of it");
  await tex.object("person:ws1").fetch(new Request("https://tex-store.internal/wipe", { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "wipe" })), "x-tex-owner": "person:ws1" } }));
  assert.equal(await ledgerFor(env, { person: "ws1" }).roundsOf("texts", key), null);
});

test("carriedRounds reads the text's snapshot from the chat's home, keeps new ones there, and carries the outside-read mark", async () => {
  const store = new Map();
  const home = { roundsOf: async (chat, key) => store.get(`${chat}/${key}`) ?? null, keepRounds: async (chat, key, data) => void store.set(`${chat}/${key}`, data) };
  const session = { workspaceKind: "personal", workspaceId: "ws1" };
  const asked = [];
  const wrapped = { texLedger: (chat) => (asked.push(chat), home) };
  const body = { covers: ["e1"] };
  const again = { ...body, again: true };
  const logs = [];
  const log = (line) => logs.push(line);

  const first = await carriedRounds({ store: wrapped, session, body, question: QUESTION, egress: { untrusted: true, outside: true }, log });
  assert.equal(first.from, null);
  assert.deepEqual(asked, [null], "the person's own home");
  first.keep({ v: 1, round: 1, ...first.marks(), messages: [{ role: "assistant", text: "", toolCalls: [{ id: "c", name: "search_notes", args: {} }] }, { role: "tool", id: "c", name: "search_notes", text: "read from the web" }] });
  await first.flush();

  const egress = { untrusted: false, outside: false };
  assert.equal((await carriedRounds({ store: wrapped, session, body, question: QUESTION, egress, log })).from, null, "a first try reads nothing: no store call before its model");
  assert.deepEqual(egress, { untrusted: false, outside: false });
  const second = await carriedRounds({ store: wrapped, session, body: again, question: QUESTION, egress, log });
  assert.equal(second.from.round, 1);
  assert.deepEqual(egress, { untrusted: true, outside: true }, "the outside-read mark travels");
  assert.deepEqual(logs, [{ event: "turn_resumed", round: 1, calls: 1, group: false }], "counts only, never words");

  assert.equal((await carriedRounds({ store: wrapped, session, body: { ...body, provisional: true }, question: QUESTION, egress, log })).keep, null, "a provisional run keeps nothing");
  assert.equal(await carriedRounds({ store: wrapped, session, body: {}, question: QUESTION, egress, log }), null, "no events, no carry");
  assert.equal(await carriedRounds({ store: { texLedger: () => ({ append() {} }) }, session, body, question: QUESTION, egress, log }), null, "a home with no rounds (a Lab test chat)");
});
