/**
 * A note save that ran long is followed through, never told as failed unseen
 * (2026-10-24: "the write timed out", "your notes stopped saving", three
 * conversations running, for saves that were slow, not refused).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { SAVE_NOT_CONFIRMED, isPlainNoteWrite, settleNoteWrite } from "../src/agent/noteWriteRetry.js";

const ARGS = { path: "projects/personal-finances/overview.md", content: "# Finances\n\nMarcus: $50 every two weeks.\n", expected_etag: "c2.doc.r1" };
const SAVED = { content: [{ type: "text", text: "saved projects/personal-finances/overview.md" }] };
const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const noteHolding = (text) => ({ content: [{ type: "text", text: `etag: c2.doc.r2\npath: ${ARGS.path}\n---\n${text}` }] });

test("only a plain whole-content save is followed through", () => {
  assert.equal(isPlainNoteWrite("write_note", ARGS), true);
  for (const extra of [{ comment: {} }, { mail: {} }, { site: {} }, { upload: {} }]) assert.equal(isPlainNoteWrite("write_note", { ...ARGS, ...extra }), false);
  assert.equal(isPlainNoteWrite("write_note", { path: ARGS.path }), false);
  assert.equal(isPlainNoteWrite("remember", ARGS), false);
});

test("a save that answers late, inside the turn, is the answer: no read, no retry", async () => {
  let runs = 0;
  let reads = 0;
  const result = await settleNoteWrite({ run: () => (runs += 1, after(30, SAVED)), callTool: async () => (reads += 1, noteHolding("")), args: ARGS, ms: 20, remaining: () => 60_000 });
  assert.deepEqual(result, SAVED);
  assert.equal(runs, 1);
  assert.equal(reads, 0);
});

test("a save that never answers but landed reads back as saved, without a second write", async () => {
  let runs = 0;
  const result = await settleNoteWrite({ run: () => (runs += 1, never()), callTool: async () => noteHolding(ARGS.content), args: ARGS, ms: 5, remaining: () => 8_010 });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^Saved projects\/personal-finances\/overview\.md/);
  assert.equal(runs, 1);
});

test("a save that never landed is retried once, and the retry's answer stands", async () => {
  const runs = [];
  const result = await settleNoteWrite({
    run: () => (runs.push(1), runs.length === 1 ? never() : Promise.resolve(SAVED)),
    callTool: async (name, args) => (assert.equal(name, "read_note"), assert.deepEqual(args, { path: ARGS.path }), noteHolding("# Finances\n\nMarcus: $500 every two weeks.\n")),
    args: ARGS,
    ms: 5,
    remaining: () => 30_000,
  });
  assert.deepEqual(result, SAVED);
  assert.equal(runs.length, 2);
});

test("a retry that lost to the first attempt still counts as saved when the note holds the content", async () => {
  let reads = 0;
  const conflict = { content: [{ type: "text", text: "conflict: note changed since you read it" }], isError: true };
  const result = await settleNoteWrite({
    run: (() => { let n = 0; return () => (n += 1, n === 1 ? never() : Promise.resolve(conflict)); })(),
    callTool: async () => (reads += 1, reads === 1 ? noteHolding("old") : noteHolding(ARGS.content)),
    args: ARGS,
    ms: 5,
    remaining: () => 30_000,
  });
  assert.match(result.content[0].text, /^Saved /);
});

test("a real refusal is never dressed up as saved", async () => {
  const refused = { content: [{ type: "text", text: "conflict: note changed since you read it" }], isError: true };
  const result = await settleNoteWrite({
    run: (() => { let n = 0; return () => (n += 1, n === 1 ? never() : Promise.resolve(refused)); })(),
    callTool: async () => noteHolding("somebody else's text"),
    args: ARGS,
    ms: 5,
    remaining: () => 30_000,
  });
  assert.deepEqual(result, refused);
});

test("with no time left to confirm, the model is told it's still saving, never that it failed", async () => {
  const result = await settleNoteWrite({ run: never, callTool: async () => noteHolding("old"), args: ARGS, ms: 5, remaining: () => 8_010 });
  assert.equal(result.content[0].text, SAVE_NOT_CONFIRMED);
  assert.doesNotMatch(SAVE_NOT_CONFIRMED, /took too long|Don't retry/);
  assert.match(SAVE_NOT_CONFIRMED, /Don't tell them it failed/);
});

test("in a turn, a slow save the model sees is the save's own answer, not 'took too long'", async () => {
  const WRITE = { name: "write_note", description: "Write a note", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } };
  const replies = [
    { choices: [{ message: { content: "", tool_calls: [{ id: "call_0", type: "function", function: { name: "write_note", arguments: JSON.stringify(ARGS) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [{ message: { content: "Saved the corrected numbers." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const calls = [];
  const ai = { async run(model, input) { calls.push(input); return replies.shift(); } };
  const result = await runTurn({
    question: "fix the finance note",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [WRITE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/zai-org/glm-4.7-flash" },
    providerOptions: { ai },
    texting: true,
    toolTimeoutMs: 30,
    callTool: (name) => (name === "write_note" ? after(45, SAVED) : Promise.resolve(noteHolding(""))),
  });
  const sent = calls[1].messages.filter((message) => message.role === "tool").at(-1)?.content;
  assert.match(sent, /saved projects\/personal-finances/);
  assert.doesNotMatch(sent, /took too long/);
  assert.deepEqual(result.steps, [{ tool: "write_note", ok: true }]);
});
