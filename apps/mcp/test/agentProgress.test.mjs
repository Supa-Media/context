/**
 * A long task over text says where it has got to (the owner, 2026-10-10: text
 * Tex and have it do real work). A streamed texting turn is offered
 * `text_progress`, which reaches the stream and never the MCP, may take more
 * rounds than a quick answer, and ends with the route's own JSON as its last
 * line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import {
  LONG_MAX_ROUNDS,
  MAX_PROGRESS_CHARS,
  MAX_PROGRESS_TEXTS,
  PROGRESS_TOOL,
  progressChannel,
  streamTurn,
  wantsProgress,
} from "../src/agent/progress.js";

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
          tool_calls: toolCalls.map(([name, args], i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function turn(ai, overrides = {}) {
  return runTurn({
    question: "Connect Context to my ChatGPT",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    callTool: async () => ({ content: [{ type: "text", text: "found" }] }),
    ...overrides,
  });
}

const offered = (ai, n = 0) => (ai.calls[n].input.tools ?? []).map((tool) => tool.function?.name ?? tool.name);

test("a streamed turn offers text_progress, sends it to the person and never to the MCP", async () => {
  const said = [];
  const mcp = [];
  const ai = scripted([chat("", [[PROGRESS_TOOL, { text: "On it, opening ChatGPT." }]]), chat("Done.")]);
  const result = await turn(ai, {
    progress: progressChannel(async (text) => said.push(text)),
    callTool: async (name) => {
      mcp.push(name);
      return { content: [{ type: "text", text: "x" }] };
    },
  });
  assert.ok(offered(ai).includes(PROGRESS_TOOL));
  assert.deepEqual(said, ["On it, opening ChatGPT."]);
  assert.deepEqual(mcp, []);
  assert.equal(result.answer, "Done.");
  assert.match(ai.calls[0].input.messages[0].content, /text_progress/);
});

test("a turn with no stream is not offered text_progress, and a call to it reaches nothing", async () => {
  const mcp = [];
  const ai = scripted([chat("", [[PROGRESS_TOOL, { text: "hi" }]]), chat("Done.")]);
  await turn(ai, {
    callTool: async (name) => {
      mcp.push(name);
      return { content: [{ type: "text", text: "x" }] };
    },
  });
  assert.ok(!offered(ai).includes(PROGRESS_TOOL));
  assert.deepEqual(mcp, []);
});

test("a streamed turn may go past the quick turn's eight rounds, and a setup still tightens it", async () => {
  const many = (n) => [...Array.from({ length: n }, () => chat("", [["search_notes", { query: "q" }]])), chat("Done.")];
  const quick = scripted(many(12));
  const short = await turn(quick, { maxRounds: 30 });
  assert.equal(short.exhausted, true, "a quick turn stops at eight");
  assert.equal(quick.calls.length, 8);

  const long = scripted(many(12));
  const done = await turn(long, { maxRounds: 30, roundCap: LONG_MAX_ROUNDS, progress: progressChannel(async () => {}) });
  assert.equal(done.answer, "Done.");
  assert.equal(long.calls.length, 13);

  const unset = scripted(many(12));
  const noSetup = await turn(unset, { roundCap: LONG_MAX_ROUNDS, progress: progressChannel(async () => {}) });
  assert.equal(noSetup.answer, "Done.", "with no setup, a streamed turn has the long cap");

  const tight = scripted(many(12));
  const held = await turn(tight, { maxRounds: 4, roundCap: LONG_MAX_ROUNDS, progress: progressChannel(async () => {}) });
  assert.equal(held.exhausted, true);
  assert.equal(tight.calls.length, 4);
});

test("a slow-by-nature tool may name its own time limit", async () => {
  const ai = scripted([chat("", [["search_notes", { query: "q" }]]), chat("Done.")]);
  const result = await turn(ai, {
    toolTimeoutMs: 5,
    toolTimeouts: { search_notes: 200 },
    callTool: () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: "text", text: "late but fine" }] }), 30)),
  });
  assert.equal(result.steps[0].ok, true);
});

test("progress texts are bounded: one line, no repeats, a cap per turn", async () => {
  const said = [];
  const channel = progressChannel(async (text) => said.push(text));
  assert.equal((await channel.call({ text: "" })).isError, true);
  await channel.call({ text: "Opening   ChatGPT\nnow." });
  assert.equal((await channel.call({ text: "Opening ChatGPT now." })).isError, undefined);
  await channel.call({ text: "x".repeat(MAX_PROGRESS_CHARS * 2) });
  for (let i = 0; i < MAX_PROGRESS_TEXTS + 3; i += 1) await channel.call({ text: `step ${i}` });
  assert.equal(said[0], "Opening ChatGPT now.");
  assert.equal(said[1].length, MAX_PROGRESS_CHARS);
  assert.equal(said.length, MAX_PROGRESS_TEXTS);
});

async function lines(response) {
  const text = await response.text();
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

test("the stream carries progress as it happens and the route's own answer last", async () => {
  const response = streamTurn(async (progress) => {
    await progress("Opening ChatGPT now.");
    return Response.json({ answer: "Done.", steps: [] }, { status: 200 });
  });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  assert.deepEqual(await lines(response), [{ progress: "Opening ChatGPT now." }, { status: 200, body: { answer: "Done.", steps: [] } }]);
});

test("a refusal travels in the last line with its status, and a throw is an opaque 500", async () => {
  const refused = streamTurn(async () => Response.json({ error: "daily_limit" }, { status: 429 }));
  assert.deepEqual(await lines(refused), [{ status: 429, body: { error: "daily_limit" } }]);
  const thrown = streamTurn(async () => {
    throw new Error("secret plumbing detail");
  });
  const out = await lines(thrown);
  assert.deepEqual(out, [{ status: 500, body: { error: "server_error" } }]);
});

test("a heartbeat keeps a quiet stream alive", async () => {
  const response = streamTurn(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return Response.json({ answer: "Done." });
    },
    { heartbeatMs: 10 },
  );
  const out = await lines(response);
  assert.ok(out.some((line) => typeof line.tick === "number"));
  assert.deepEqual(out.at(-1), { status: 200, body: { answer: "Done." } });
});

test("only an ndjson Accept asks for a stream", () => {
  assert.equal(wantsProgress(new Request("https://x/agent", { headers: { accept: "application/x-ndjson" } })), true);
  assert.equal(wantsProgress(new Request("https://x/agent", { headers: { accept: "application/json" } })), false);
  assert.equal(wantsProgress(new Request("https://x/agent")), false);
});
