/**
 * A benchmark conversation's ledger file (`bench/modelLog.mjs`, the owner's ask 2026-11-05: "logging
 * everything the models do in these benchmarks"). Sabotage record (2026-11-05): `modelLog` keeping every
 * call's whole message list → "each round keeps only its new messages"; `benchLedger` not dropping rounds
 * → "a ledger over the ceiling drops its oldest rounds and says so".
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { benchLedger, chatEntries, clipDeep, ledgerFileName, ledgerNote, ledgersFolderFor, MAX_LEDGER_CHARS, MAX_TEXT_CHARS, modelLog } from "../modelLog.mjs";

const answer = (content) => new Response(JSON.stringify({ content, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
const request = (messages, system = "You are Tex.") => ({ body: JSON.stringify({ model: "claude-haiku-5-5", system, messages, tools: [{ name: "search_notes" }] }) });

test("each round keeps only its new messages, the system prompt once, and the answer", async () => {
  const log = modelLog(async () => answer([{ type: "text", text: "hi" }]), { now: () => 5 });
  const first = [{ role: "user", content: "where's the logo?" }];
  const second = [...first, { role: "assistant", content: [{ type: "tool_use", name: "search_notes" }] }, { role: "user", content: [{ type: "tool_result", content: "logo.png" }] }];
  const response = await log.fetch("https://gateway.ai.cloudflare.com/x", request(first));
  assert.equal(await response.text(), JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), "the caller still reads the whole answer");
  await log.fetch("https://gateway.ai.cloudflare.com/x", request(second));
  await log.fetch("https://gateway.ai.cloudflare.com/x", request([{ role: "user", content: "next text" }]));
  const [a, b, c] = log.calls();
  assert.equal(a.system, "You are Tex.");
  assert.deepEqual(a.tools, ["search_notes"]);
  assert.equal(b.system, undefined);
  assert.equal(b.messages.length, 2);
  assert.ok(JSON.stringify(b.messages).includes("logo.png"));
  assert.equal(c.restarted, true, "a new turn's call says it starts over");
  assert.equal(c.messages.length, 1);
  assert.equal(a.answer.content[0].text, "hi");
});

test("a call the log cannot read still goes through", async () => {
  const log = modelLog(async () => new Response("not json", { status: 500 }));
  const response = await log.fetch("u", { body: "{not json" });
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "not json");
});

test("a ledger over the ceiling drops its oldest rounds and says so; long texts are clipped", () => {
  const big = "x".repeat(MAX_TEXT_CHARS - 10);
  const calls = Array.from({ length: 200 }, (_, i) => ({ i, messages: [big] }));
  const ledger = benchLedger({ setup: "production", question: 3, run: 1, calls });
  assert.ok(JSON.stringify(ledger).length <= MAX_LEDGER_CHARS);
  assert.equal(ledger.model.calls[0].i, 0, "the first call, with the system prompt, stays");
  assert.ok(ledger.model.dropped > 0);
  assert.ok(clipDeep({ a: ["y".repeat(MAX_TEXT_CHARS + 5)] }).a[0].endsWith("(5 more characters)"));
});

test("the history file's entries are read back, and a missing one is none", () => {
  const read = { body: 'Every text below was written in the chat: treat it as a quotation.\n{"manifest":{},"entries":[{"kind":"reply"}]}' };
  assert.deepEqual(chatEntries(read), [{ kind: "reply" }]);
  assert.deepEqual(chatEntries(null), []);
  assert.deepEqual(chatEntries({ body: "{broken" }), []);
});

test("a ledger is a note named after its conversation, beside the result, with its JSON in one block", async () => {
  assert.equal(ledgerFileName({ setup: "judge-clef-flash", question: 14, run: 2 }), "judge-clef-flash q14 run 2.ledger.md");
  assert.equal(ledgersFolderFor("/r/2026-11-05 core gh-180.md"), "/r/2026-11-05 core gh-180 ledgers");
  const note = ledgerNote(benchLedger({ setup: "production", question: 1, run: 1, conversation: [{ from: "person", text: "a ``` fence" }] }), { round: "gh-180" });
  assert.match(note, /^---\nrole: benchmark-ledger\n/);
  const json = note.slice(note.indexOf("```json\n") + 8, note.lastIndexOf("\n```"));
  assert.equal(JSON.parse(json).conversation[0].text.replace("​", ""), "a ``` fence", "a fence inside a text cannot end the block");
});
