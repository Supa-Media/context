/**
 * WHAT IS LEFT OF TEX'S DAILY TRANSCRIPT (`src/agent/transcript.js`).
 *
 * The daily transcripts are no longer written (owner, 2026-11-02: the chat's
 * ledger is its one record); `agentTranscriptRoute.test.mjs` pins that a turn
 * writes none. What remains is the rendering of a turn's steps every reader
 * shares, where the old notes are, and the model being asked for its thinking
 * in words, which the ledger keeps.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-15).
 *
 *  3. `argsLine` without the `SECRET_KEY` test, or without `CONTENT_KEY`.
 *     → "an argument that looks like a secret is hidden, a note's text is only its length…" fails.
 *  4. `runTurn` without the thinking `tell`.
 *     → "runTurn tells the observer its thinking, its words between tools and each call" fails.
 *  5. `gatewayBody` sending `thinking` to every model.
 *     → "the thinking is asked for in words only from a model that thinks by default" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { argsLine, transcriptPath } from "../src/agent/transcript.js";
import { aiGatewayConfig, gatewayBody } from "../src/agent/aiGateway.js";
import { AI_GATEWAY_ENV } from "./agentModelFixture.mjs";
import { runTurn } from "../src/agent/turn.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";

// 2026-10-15 03:30 UTC: still the 14th in New York.
const NOW = Date.UTC(2026, 9, 15, 3, 30);

test("the day is the person's own, in their zone", () => {
  assert.equal(transcriptPath(NOW, "America/New_York"), "tex/transcripts/2026-10-14.md");
  assert.equal(transcriptPath(NOW, "Europe/London"), "tex/transcripts/2026-10-15.md");
  assert.equal(transcriptPath(NOW, "not/a-zone"), "tex/transcripts/2026-10-14.md");
  assert.equal(transcriptPath(NOW, "UTC", 2), "tex/transcripts/2026-10-15-2.md");
});

test("an argument that looks like a secret is hidden, a note's text is only its length, and long ones are cut", () => {
  const line = argsLine({ path: "a.md", password: "hunter2", nested: { api_key: "k", token: "t" }, content: "SHARED-WORDS ".repeat(80), query: "q".repeat(1000) });
  assert.doesNotMatch(line, /hunter2/);
  assert.match(line, /"password":"\[hidden\]"/);
  assert.match(line, /"api_key":"\[hidden\]"/);
  assert.doesNotMatch(line, /SHARED-WORDS/);
  assert.match(line, /"content":"\[1040 characters\]"/);
  assert.ok(line.length <= 801);
});

test("runTurn tells the observer its thinking, its words between tools and each call", async () => {
  const events = [];
  const replies = [
    {
      content: [
        { type: "thinking", thinking: "Need the todo list.", signature: "s" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "read_note", input: { path: "todo.md" } },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "Rent." }], stop_reason: "end_turn" },
  ];
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const turn = await runTurn({
    question: "what's due?",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [{ name: "read_note", description: "Read.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
    callTool: async () => ({ content: [{ type: "text", text: "- rent" }] }),
    env: { ...AI_GATEWAY_ENV, AGENT_BUILTIN_MODEL: "anthropic/claude-haiku-5-5" },
    providerOptions: { gateway: aiGatewayConfig(AI_GATEWAY_ENV), fetchImpl },
    builtinModelOverride: "anthropic/claude-haiku-5-5",
    texting: true,
    observe: (event) => events.push(event),
  });
  assert.equal(turn.answer, "Rent.");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["thinking", "say", "tool"],
  );
  assert.equal(events[0].text, "Need the todo list.");
  assert.deepEqual(events[2].args, { path: "todo.md" });
  assert.equal(events[2].ok, true);
  assert.deepEqual(bodies[0].thinking, { type: "adaptive", display: "summarized" });
  // Asked "what is my Tex transcript folder called?", Tex once said it was not in their workspace (2026-10-16).
  const system = bodies[0].system.map((block) => block.text).join("");
  // The daily transcripts are no longer written (2026-11-02): the chat's one record is its ledger, shown as its history file.
  assert.match(system, /tex\/history\.ledger\.json in their personal workspace is this chat's whole history/);
  assert.match(system, /they can open it in the app/);
  assert.doesNotMatch(system, /not their notes/);
});

test("the thinking is asked for in words only from a model that thinks by default", () => {
  const base = { system: "", messages: [{ role: "user", text: "hi" }], tools: [] };
  assert.deepEqual(gatewayBody({ ...base, model: "anthropic/claude-haiku-5-5", display: "summarized" }).thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(gatewayBody({ ...base, model: "anthropic/claude-opus-5", display: "summarized" }).thinking, { type: "adaptive", display: "summarized" });
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-opus-4-8", display: "summarized" }).thinking, undefined);
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-haiku-4-5", display: "summarized" }).thinking, undefined);
  assert.equal(gatewayBody({ ...base, model: "anthropic/claude-haiku-5-5" }).thinking, undefined);
});
