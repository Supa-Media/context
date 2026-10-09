/**
 * A slow tool costs the turn one step, never the answer (the owner,
 * 2026-10-08: "the assistant is literally useless right now"). On production
 * a search in a large workspace ran past the texting Worker's two minutes, so
 * the person got "Something went wrong" instead of an answer. And every turn
 * is told which model is answering and not to guess.
 *
 * Driven through `runTurn` with a scripted Workers AI binding, so what the
 * model was sent is what is asserted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { systemPrompt } from "../src/agent/prompt.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";
const SEARCH = {
  name: "search_notes",
  description: "Search notes",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const next = replies.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      return next;
    },
  };
}

function chat(text, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: toolCalls.map((name, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify({ query: "anything" }) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function turn(ai, overrides = {}) {
  return runTurn({
    question: "What did I decide about texts?",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    ...overrides,
  });
}

/** What the model was sent as the result of its tool call, on round `n`. */
function toolResultSentOn(ai, n) {
  const messages = ai.calls[n].input.messages;
  return messages.filter((message) => message.role === "tool").at(-1)?.content;
}

test("a tool that never returns is stopped and the model still answers", async () => {
  const ai = scripted([chat("", ["search_notes"]), chat("I couldn't check your notes just now.")]);
  const result = await turn(ai, {
    callTool: () => new Promise(() => {}),
    toolTimeoutMs: 20,
  });
  assert.equal(result.answer, "I couldn't check your notes just now.");
  assert.match(toolResultSentOn(ai, 1), /took too long/);
  assert.deepEqual(result.steps, [{ tool: "search_notes", ok: false }]);
});

test("a tool that answers in time is untouched by the timer", async () => {
  const ai = scripted([chat("", ["search_notes"]), chat("You decided texts stay short.")]);
  const result = await turn(ai, {
    callTool: async () => ({ content: [{ type: "text", text: "texts stay short" }] }),
    toolTimeoutMs: 1_000,
  });
  assert.equal(result.answer, "You decided texts stay short.");
  assert.equal(toolResultSentOn(ai, 1), "texts stay short");
});

test("past the turn's tool budget, a tool call is refused and the next round answers", async () => {
  let now = 0;
  let ran = 0;
  const ai = scripted([chat("", ["search_notes"]), chat("", ["search_notes"]), chat("Here is what I found.")]);
  const result = await turn(ai, {
    clock: () => now,
    toolBudgetMs: 1_000,
    callTool: async () => {
      ran += 1;
      now += 5_000;
      return { content: [{ type: "text", text: "a slow result" }] };
    },
  });
  assert.equal(ran, 1, "the second call never ran");
  assert.match(toolResultSentOn(ai, 2), /Out of time/);
  assert.equal(result.answer, "Here is what I found.");
});

test("a failed tool tells the model not to guess", async () => {
  const ai = scripted([chat("", ["search_notes"]), chat("I couldn't check.")]);
  await turn(ai, {
    callTool: async () => {
      throw new Error("search budget exhausted");
    },
  });
  const sent = toolResultSentOn(ai, 1);
  assert.match(sent, /failed/);
  assert.doesNotMatch(sent, /budget/, "the reason never reaches the model");
});

test("every turn is told which model answers it, and the ground rules, even with a production prompt", async () => {
  const ai = scripted([chat("Claude Haiku 5.5.")]);
  await turn(ai, {
    callTool: async () => ({ content: [] }),
    notes: { prompt: "You are Context." },
  });
  const system = ai.calls[0].input.messages.find((message) => message.role === "system").content;
  assert.match(system, new RegExp(`AI model ${MODEL.replace(/[/.]/g, "\\$&")}`));
  assert.match(system, /Never fill a gap with a guess/);
  assert.match(system, /scope_info with workspaces set to true/);

  const app = systemPrompt(null, { model: "claude-sonnet-5-5" });
  assert.match(app, /AI model claude-sonnet-5-5/);
  assert.match(app, /Never fill a gap with a guess/);
  assert.doesNotMatch(systemPrompt(null), /AI model/, "no model, no line");
});

test("a turn with earlier turns is told their lookups happened", async () => {
  const history = [
    { role: "user", text: "what time's the dentist again" },
    { role: "assistant", text: "Tuesday, October 13 at 3 pm." },
  ];
  const ai = scripted([chat("Anytime.")]);
  await turn(ai, { question: "thanks!", history, notes: { prompt: "You are Context." } });
  const system = ai.calls[0].input.messages.find((message) => message.role === "system").content;
  assert.match(system, /you did use them/, "the words-only history is explained");
  assert.match(system, /Never take back or doubt an earlier answer/);

  const first = scripted([chat("Tuesday.")]);
  await turn(first, { notes: { prompt: "You are Context." } });
  const opening = first.calls[0].input.messages.find((message) => message.role === "system").content;
  assert.doesNotMatch(opening, /you did use them/, "a first text has no earlier turns to explain");
  assert.doesNotMatch(systemPrompt(null, { texting: true }), /you did use them/);
});
