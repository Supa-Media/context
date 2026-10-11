/**
 * THE FALLBACK MODEL (decided by the owner, 2026-10-09): a setup may name a
 * second model, and a turn whose model failed after the gateway's retry goes on
 * from the same messages on that one, once. The trace says so, with the
 * status, so the turn log and a benchmark can count how often it happened.
 *
 * Driven through `runTurn` with a scripted Workers AI binding whose main
 * model fails, and the fallback answers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { ProviderError } from "../src/agent/providers.js";
import { agentTools, runTurn } from "../src/agent/turn.js";

const MAIN = "@cf/acme/main-model";
const FALLBACK = "@cf/acme/spare-model";
const SEARCH = {
  name: "search_notes",
  description: "Search notes",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

/** A binding where `failing` models throw and the others answer with `text`. */
function binding({ failing = [], text = "From the spare model." } = {}) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, system: input.messages?.[0]?.content ?? "" });
      if (failing.includes(model)) throw new Error("upstream said no");
      return {
        choices: [{ message: { content: text, tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
  };
}

function turn(ai, overrides = {}) {
  return runTurn({
    question: "What did I decide about texts?",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    ...overrides,
  });
}

test("a main model that fails hands the turn to the fallback, which answers, and the trace says so", async () => {
  const ai = binding({ failing: [MAIN] });
  const result = await turn(ai, { fallback: FALLBACK });
  assert.equal(result.answer, "From the spare model.");
  assert.equal(
    result.model,
    FALLBACK,
    "the model that answered, for the meter",
  );
  assert.deepEqual(
    ai.calls.map((call) => call.model),
    [MAIN, FALLBACK],
  );
  const fell = result.timing.trace.find((entry) => entry.kind === "fallback");
  assert.ok(fell, JSON.stringify(result.timing.trace));
  assert.equal(fell.from, MAIN);
  assert.equal(fell.model, FALLBACK);
  assert.equal(fell.status, null, "a binding that threw has no status");
  assert.ok(
    ai.calls[1].system.includes(FALLBACK),
    "the fallback is told it is the one answering",
  );
});

test("without a fallback the failure is the caller's, with the trace so far", async () => {
  const ai = binding({ failing: [MAIN] });
  const failure = await turn(ai).then(
    () => null,
    (error) => error,
  );
  assert.ok(failure instanceof ProviderError);
  assert.equal(failure.model, MAIN);
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(
    failure.timing.trace.map((entry) => [entry.kind, entry.ok]),
    [["model", false]],
  );
});

test("a fallback that fails too is the end: no second fallback, and the error names it", async () => {
  const ai = binding({ failing: [MAIN, FALLBACK] });
  const failure = await turn(ai, { fallback: FALLBACK }).then(
    () => null,
    (error) => error,
  );
  assert.ok(failure instanceof ProviderError);
  assert.equal(failure.model, FALLBACK);
  assert.deepEqual(
    ai.calls.map((call) => call.model),
    [MAIN, FALLBACK],
  );
});

test("a fallback is never used while the main model answers", async () => {
  const ai = binding({ text: "From the main model." });
  const result = await turn(ai, { fallback: FALLBACK });
  assert.equal(result.answer, "From the main model.");
  assert.equal(result.model, MAIN);
  assert.ok(!result.timing.trace.some((entry) => entry.kind === "fallback"));
});

test("ChatGPT's search and fetch are never offered to the agent, which has search_notes and read_note", () => {
  const readOnly = (name) => ({ name, annotations: { readOnlyHint: true } });
  const offered = agentTools([
    readOnly("search"),
    readOnly("fetch"),
    readOnly("search_notes"),
    readOnly("read_note"),
  ]);
  assert.deepEqual(
    offered.map((tool) => tool.name),
    ["search_notes", "read_note"],
  );
});
