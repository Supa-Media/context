/**
 * A long task over text says where it has got to (the owner, 2026-10-10: text
 * Tex and have it do real work). A streamed texting turn is offered
 * `text_progress`, which reaches the stream and never the MCP, may take more
 * rounds than a quick answer, and ends with the route's own JSON as its last
 * line.
 */

import { shown } from "./sixToolsShown.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { DIRECT_LINE } from "../src/agent/prompt.js";
import {
  LONG_MAX_ROUNDS,
  MAX_GATEWAY_TEXTS,
  MAX_PROGRESS_CHARS,
  DONE_NOTICE,
  PROGRESS_PROMPT,
  PROGRESS_TOOL,
  PROGRESS_TOOL_DEFINITION,
  claimsDone,
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

const offered = (ai, n = 0) => [...shown((ai.calls[n].input.tools ?? []).map((tool) => ({ name: tool.function?.name ?? tool.name, description: tool.function?.description ?? tool.description })))];

test("Tex is never told to text that it is on it, only real milestones", () => {
  // Dev, 2026-10-19, of "On it. This one takes a few steps, so I'll text you
  // when it's done.": "I don't want to see it ever again".
  for (const words of [PROGRESS_PROMPT, PROGRESS_TOOL_DEFINITION.description]) {
    assert.doesNotMatch(words, /first to say you're on it|first call send with action progress/);
    assert.match(words, /Never (to say|send a line saying) you're on it/);
  }
});

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
  assert.ok(offered(ai).includes("send.progress"));
  assert.deepEqual(said, ["On it, opening ChatGPT."]);
  assert.deepEqual(mcp, []);
  assert.equal(result.answer, "Done.");
  assert.match(ai.calls[0].input.messages[0].content, /send with action progress/);
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
  assert.ok(!offered(ai).includes("send.progress"));
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

/*
  An email is given two minutes to be checked and held (the owner,
  2026-10-22), but a quick turn's texting Worker gives the whole turn only
  two: the call is cut to end 30 s past the tool budget, so the answer still
  goes back instead of the turn dying with no text.
*/
test("a tool's own limit is cut so it ends 30 s past the turn's tool budget", async () => {
  const limits = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    limits.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  let now = 0;
  try {
    const ai = scripted([chat("", [["search_notes", { query: "q" }]]), chat("Done.")]);
    await turn(ai, {
      clock: () => now,
      toolBudgetMs: 70_000,
      toolTimeouts: { search_notes: 120_000 },
      callTool: async () => ({ content: [{ type: "text", text: "found" }] }),
      onModel: () => {
        now = 50_000; // the round before the call took 50 s
      },
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(limits.includes(50_000), `cut to 70 + 30 - 50 = 50 s, got ${limits.join(", ")}`);
  assert.ok(!limits.includes(120_000));
});

test("progress texts are bounded per line, never per turn: no repeats, as many as the task needs", async () => {
  // Dev2, 2026-11-01: as many lines as the model judges useful, no cap (`interleaved-updates.md`).
  const said = [];
  const channel = progressChannel(async (text) => said.push(text));
  assert.equal((await channel.call({ text: "" })).isError, true);
  await channel.call({ text: "Opening   ChatGPT\nnow." });
  assert.equal((await channel.call({ text: "Opening ChatGPT now." })).isError, undefined);
  await channel.call({ text: "x".repeat(MAX_PROGRESS_CHARS * 2) });
  for (let i = 0; i < 20; i += 1) assert.equal((await channel.call({ text: `Reading note ${i}.` })).isError, undefined);
  assert.equal(said[0], "Opening ChatGPT now.");
  assert.equal(said[1].length, MAX_PROGRESS_CHARS);
  assert.deepEqual(said.slice(2), Array.from({ length: 20 }, (_, i) => `Reading note ${i}.`), "every line, in order");
});

test("a progress line that says something is done is refused, and the model is told to say what it is doing", async () => {
  const said = [];
  const channel = progressChannel(async (text) => said.push(text));
  for (const text of ["Done.", "Sent the email to Bo.", "Booked it for 7pm.", "Your table is booked.", "Email sent!", "I've added it to your list.", "It\u2019s all set."]) {
    const answer = await channel.call({ text });
    assert.equal(answer.isError, true, text);
    assert.equal(answer.content[0].text, DONE_NOTICE);
  }
  assert.deepEqual(said, []);
  // What it is doing or found still goes, even with a done-word inside it.
  for (const text of ["Checking your Friday calendar.", "Found 3 tables at Nopa for 7pm.", "Bo booked the 7pm last week, checking if it moved.", "Looking for the email you sent Bo yesterday"]) {
    assert.equal(claimsDone(text), false, text);
    assert.equal((await channel.call({ text })).isError, undefined, text);
  }
  assert.equal(said.length, 4);
});

test("a streamed turn texts several lines in order, a done line is refused, and the reply drops what a line said", async () => {
  const said = [];
  const ai = scripted([
    chat("", [[PROGRESS_TOOL, { text: "Checking OpenTable for Friday." }]]),
    chat("", [[PROGRESS_TOOL, { text: "Booked the 7pm." }]]),
    chat("", [[PROGRESS_TOOL, { text: "Found 3 tables at Nopa." }], ["search_notes", { query: "nopa" }]]),
    chat("Found 3 tables at Nopa. The 7pm is the one by the window, want it?"),
  ]);
  const channel = progressChannel(async (text) => said.push(text));
  const result = await turn(ai, { progress: channel });
  assert.deepEqual(said, ["Checking OpenTable for Friday.", "Found 3 tables at Nopa."]);
  assert.match(JSON.stringify(ai.calls[2].input.messages), /never that something is done/, "the refusal reached the model");
  assert.equal(channel.unsaid(result.answer), "The 7pm is the one by the window, want it?");
  assert.equal(channel.unsaid("Found 3 tables at Nopa."), "Found 3 tables at Nopa.", "never emptied to nothing");
  assert.equal(channel.unsaid("Checking OpenTable for Friday.\n\nNopa has the 7pm."), "Nopa has the 7pm.");
});

test("an ask the turn already answers takes one round, with the direct line said, under a production setup too", async () => {
  for (const notes of [null, { prompt: "You are a production Tex." }]) {
    const ai = scripted([chat("Your dentist is Tuesday at 3.")]);
    const result = await turn(ai, { notes, progress: progressChannel(async () => {}) });
    assert.equal(result.answer, "Your dentist is Tuesday at 3.");
    assert.equal(ai.calls.length, 1, "one round");
    assert.ok(ai.calls[0].input.messages[0].content.includes(DIRECT_LINE), "the direct line is said");
    assert.ok(ai.calls[0].input.messages[0].content.includes(PROGRESS_PROMPT.trim()), "and the heads-up rule");
  }
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

test("the gateway can text a line of its own, beside the model's lines, with its own cap", async () => {
  const said = [];
  const channel = progressChannel(async (text) => said.push(text));
  assert.equal(await channel.say("Sign in here: https://live.example/abc"), true);
  await channel.call({ text: "Opening the site." });
  for (let i = 0; i < MAX_GATEWAY_TEXTS + 2; i += 1) await channel.say(`line ${i}`);
  assert.equal(await channel.say(""), false);
  assert.equal(said[0], "Sign in here: https://live.example/abc");
  assert.ok(said.includes("Opening the site."), "the model's own line still goes");
  assert.equal(said.length, MAX_GATEWAY_TEXTS + 1);
});
