/**
 * A move that ran long is still a move (2026-10-24: an archive cut off at
 * 20 s with "Don't retry it" landed anyway, and a dry run of ten moves in a
 * shared workspace was cut off before Tex moved anything).
 *
 * ## Sabotage record
 *
 *   `turn.js` building its limits without `MOVE_TIMEOUTS`
 *     → "a move gets its own, longer limit" fails
 *   the timeout text for a move back to `TOOL_TIMED_OUT`
 *     → "a move past even its own limit is told to look before redoing it" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { MOVE_TIMED_OUT, MOVE_TIMEOUTS, isMove } from "../src/agent/slowMoves.js";

const MOVE = { name: "move_note", description: "Move a note", inputSchema: { type: "object", properties: { source: { type: "string" }, destination: { type: "string" } } } };
const ARGS = { source: "projects/backlog/google-approval/casa.md", destination: "projects/google-oauth/casa/casa.md" };
const MOVED = { content: [{ type: "text", text: `moved note: ${ARGS.source} → ${ARGS.destination}` }] };
const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

async function turnWith(callTool, options = {}) {
  const replies = [
    { choices: [{ message: { content: "", tool_calls: [{ id: "call_0", type: "function", function: { name: "move_note", arguments: JSON.stringify(ARGS) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { choices: [{ message: { content: "Moved it." } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const calls = [];
  const ai = { async run(model, input) { calls.push(input); return replies.shift(); } };
  const result = await runTurn({
    question: "merge the google notes into one project folder",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [MOVE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/zai-org/glm-4.7-flash" },
    providerOptions: { ai },
    texting: true,
    toolTimeoutMs: 30,
    callTool,
    ...options,
  });
  return { result, sent: calls[1].messages.filter((message) => message.role === "tool").at(-1)?.content };
}

test("every rearranging tool has a limit longer than a read's", () => {
  for (const name of ["move_note", "move_notes", "move_folder", "archive_note"]) {
    assert.equal(isMove(name), true);
    assert.ok(MOVE_TIMEOUTS[name] > 20_000);
  }
  assert.equal(isMove("read_note"), false);
});

test("a move gets its own, longer limit", async () => {
  const { result, sent } = await turnWith(() => after(60, MOVED));
  assert.match(sent, /moved note:/);
  assert.deepEqual(result.steps, [{ tool: "move_note", ok: true }]);
});

test("a move past even its own limit is told to look before redoing it, never 'Don't retry'", async () => {
  const { result, sent } = await turnWith(never, { toolTimeouts: { move_note: 20 } });
  assert.equal(sent, MOVE_TIMED_OUT);
  assert.doesNotMatch(sent, /Don't retry it/);
  assert.match(MOVE_TIMED_OUT, /Don't say it failed/);
  assert.deepEqual(result.steps, [{ tool: "move_note", ok: false }]);
});
