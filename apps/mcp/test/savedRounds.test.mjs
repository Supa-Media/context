/**
 * A TURN CARRIES ON WHERE ITS LAST TRY STOPPED (Dev2, 2026-11-17; `src/agent/savedRounds.js`, `turnResume.js`).
 *
 * A texted turn that died after its tools ran is tried again by the Worker. The try after hands back the rounds the
 * first one sealed, and goes on from them: no tool runs twice, the model is asked once more, not from the start.
 *
 * Sabotage: make `resumedRounds` (`turnResume.js`) put nothing back and "a crashed turn's next try runs no tool again"
 * fails on the tool count, since the model searches again; drop the question from `aad` in `savedRounds.js` and "never opens on another text" fails;
 * call `onRound` before the tool results are pushed and "the copy holds the tool's result" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { ROUNDS_FRESH_MS, ROUNDS_MAX_CHARS, PICTURE_LEFT_OUT, openRounds, sealRounds } from "../src/agent/savedRounds.js";
import { carriedRounds } from "../src/agent/turnResume.js";
import { ledgerObserver, STEP_NAMES } from "../src/agent/ledger.js";

const ENV = { GATEWAY_SECRET: "test-secret-that-is-long-enough" };
const ME = { workspaceId: "w1", actorUserId: "u1", actorClientId: "texts" };
const SEARCH = { name: "search_notes", description: "Search notes", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } };
const QUESTION = "When is the dentist?";
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
const toolCall = (id, query) => ({ choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name: "search_notes", arguments: JSON.stringify({ query }) } }] } }], usage: USAGE });
const words = (text) => ({ choices: [{ message: { content: text } }], usage: USAGE });

function scripted(replies) {
  const calls = [];
  return { calls, async run(_model, input) { calls.push(input); return replies.shift(); } };
}

/** A model that searches until it has read a search's result, then answers from it: what a real one does. */
function searchesUntilFound() {
  const calls = [];
  return { calls, async run(_model, input) { calls.push(input); return input.messages.some((m) => m.role === "tool") ? words("Tuesday at 3pm.") : toolCall(`call_${calls.length}`, "dentist"); } };
}

function turn(ai, extra = {}) {
  const searched = [];
  const done = runTurn({
    question: QUESTION,
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    texting: true,
    callTool: async (_name, args) => (searched.push(args.query), { content: [{ type: "text", text: `Dentist: Tuesday 3pm (found by ${args.query})` }] }),
    ...extra,
  });
  return { searched, done };
}

test("a crashed turn's next try runs no tool again and goes on from the last round", async () => {
  // Try 1: one search, then the draft's check crashes (the gateway died in its checks).
  const kept = [];
  const first = turn(searchesUntilFound(), {
    onRound: (messages, round) => kept.push({ messages, round }),
    answerCheck: async () => { throw new Error("checks crashed"); },
  });
  await assert.rejects(first.done, /checks crashed/);
  assert.deepEqual(first.searched, ["dentist"]);
  assert.equal(kept.length, 1, "one round of tools, one copy");
  assert.equal(kept[0].round, 1);
  assert.ok(kept[0].messages.some((m) => m.role === "tool" && /Tuesday 3pm/.test(m.text)), "the copy holds the tool's result");

  // Sealed, through the Worker, and back.
  const sealed = await sealRounds(ENV, ME, QUESTION, kept[0].messages, kept[0].round);
  const resumeFrom = await openRounds(ENV, ME, QUESTION, sealed);
  assert.ok(resumeFrom);

  // Try 2: the model is asked once, with the search's result already in front of it.
  const ai = searchesUntilFound();
  const told = [];
  const second = turn(ai, { resumeFrom, observe: (event) => told.push(event) });
  const result = await second.done;
  assert.equal(result.answer, "Tuesday at 3pm.");
  assert.deepEqual(second.searched, [], "nothing it already did is done again");
  assert.equal(ai.calls.length, 1, "one model round, not the whole turn");
  assert.ok(JSON.stringify(ai.calls[0].messages).includes("Tuesday 3pm (found by dentist)"), "the model reads what the first try's search returned");
  assert.deepEqual(result.steps, [{ tool: "search_notes", ok: true, resumed: true }], "its calls are the turn's own, marked resumed");
  const resumed = told.find((event) => event.kind === "model" && event.step === "resumed");
  assert.ok(resumed, "the ledger is told it went on from an earlier try");
  assert.deepEqual(resumed.input, { round: 1, calls: ["search_notes"] });
  assert.equal(told.filter((event) => event.kind === "tool").length, 0, "the first try's calls are never logged again as run");
});

test("the resumed step reaches the chat's ledger as a step of its own", () => {
  assert.ok(STEP_NAMES.has("resumed"));
  const written = [];
  ledgerObserver({ write: (entry) => written.push(entry) }, null, { turn: "t2" })({ kind: "model", step: "resumed", ok: true, input: { round: 1, calls: ["search_notes"] }, output: { from: 1 }, reason: "went on" });
  assert.equal(written[0]?.step, "resumed");
  assert.equal(written[0]?.turn, "t2");
});

test("a try that comes back on its last round still gets one round to answer", async () => {
  const ai = scripted([words("Done.")]);
  const { done } = turn(ai, { maxRounds: 2, resumeFrom: { round: 7, messages: [{ role: "assistant", text: "", toolCalls: [{ id: "c", name: "search_notes", args: { query: "x" } }] }, { role: "tool", id: "c", name: "search_notes", text: "nothing" }] } });
  assert.equal((await done).answer, "Done.");
});

test("a sealed copy never opens on another text, another person, after it's stale, or tampered", async () => {
  const messages = [{ role: "assistant", text: "", toolCalls: [{ id: "c", name: "search_notes", args: { query: "x" } }] }, { role: "tool", id: "c", name: "search_notes", text: "secret result" }];
  const now = 1_800_000_000_000;
  const sealed = await sealRounds(ENV, ME, QUESTION, messages, 1, now);
  assert.match(sealed, /^tr1\./);
  assert.ok(!sealed.includes("secret result"), "the Worker keeps bytes it can't read");
  assert.ok(await openRounds(ENV, ME, QUESTION, sealed, now));
  assert.equal(await openRounds(ENV, ME, "Something else?", sealed, now), null, "another text");
  assert.equal(await openRounds(ENV, { ...ME, actorUserId: "u2" }, QUESTION, sealed, now), null, "another person");
  assert.equal(await openRounds(ENV, { ...ME, workspaceId: "w2" }, QUESTION, sealed, now), null, "another workspace");
  assert.equal(await openRounds({ GATEWAY_SECRET: "another-secret-entirely-long" }, ME, QUESTION, sealed, now), null, "another key");
  assert.equal(await openRounds(ENV, ME, QUESTION, sealed, now + ROUNDS_FRESH_MS + 1), null, "stale");
  const flipped = `${sealed.slice(0, -6)}${sealed.at(-6) === "A" ? "B" : "A"}${sealed.slice(-5)}`;
  assert.equal(await openRounds(ENV, ME, QUESTION, flipped, now), null, "tampered");
  assert.equal(await openRounds(ENV, ME, QUESTION, "tr1.bm90IHNlYWxlZA==", now), null, "not sealed");
  assert.equal(await sealRounds({}, ME, QUESTION, messages, 1, now), null, "no key, no copy");
});

test("pictures stay out of the copy, a long result is cut, and a copy too big is not made", async () => {
  const now = 1_800_000_000_000;
  const messages = [
    { role: "assistant", text: "", toolCalls: [{ id: "p", name: "browse", args: {} }] },
    { role: "tool", id: "p", name: "browse", text: "page", images: [{ data: "AAAA", mediaType: "image/png" }] },
    { role: "tool", id: "q", name: "search_notes", text: "y".repeat(50_000) },
  ];
  const opened = await openRounds(ENV, ME, QUESTION, await sealRounds(ENV, ME, QUESTION, messages, 1, now), now);
  assert.equal(opened.messages[1].images, undefined);
  assert.ok(opened.messages[1].text.endsWith(PICTURE_LEFT_OUT));
  assert.ok(opened.messages[2].text.length < 13_000);
  // Random words gzip badly: enough of them won't fit.
  const noise = Array.from({ length: 60 }, (_, i) => ({ role: "tool", id: `n${i}`, name: "search_notes", text: Array.from({ length: 12_000 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join("") }));
  assert.equal(await sealRounds(ENV, ME, QUESTION, noise, 1, now), null);
  assert.ok(ROUNDS_MAX_CHARS <= 400_000);
});

test("carriedRounds opens body.rounds and sends each round's copy down the stream, in order", async () => {
  const lines = [];
  const step = async (text, how) => void lines.push({ text, how });
  const empty = await carriedRounds({ env: ENV, session: ME, question: QUESTION, body: {}, step });
  assert.equal(empty.from, null);
  empty.save([{ role: "user", text: "one" }], 1);
  empty.save([{ role: "user", text: "one" }, { role: "user", text: "two" }], 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.text === "" && /^tr1\./.test(line.how.rounds)));
  const carried = await carriedRounds({ env: ENV, session: ME, question: QUESTION, body: { rounds: lines[1].how.rounds }, step });
  assert.equal(carried.from.round, 2, "the newest copy, kept last");
});
