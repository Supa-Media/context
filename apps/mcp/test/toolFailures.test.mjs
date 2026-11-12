/**
 * EVERY FAILED TOOL CALL IS KEPT WITH ITS CAUSE (Dev2, 2026-11-10: "whenever there is a tool call
 * failure, I want it logged and visible for us to understand why").
 *
 * `runTurn` is the one loop every Tex model with tools runs, so each way a call can fail there is
 * driven through it with a scripted AI gateway, and what it kept is asserted: the tool, the cause
 * code, the reason with its values taken out, and a `tex_tool_failed` log line.
 *
 * ## Sabotage record
 *
 *   `failed(...)` dropped from the refusal branch in `turn.js`
 *     → "a tool that says no is kept as refused, with its reason shaped" fails
 *   the thrown error not kept (`thrown = error` removed)
 *     → "a tool that throws is kept as threw with its class, which the model never reads" fails
 *   `failureShape` without the path rule
 *     → "a reason keeps our words and loses every value" fails
 *   a held call counted as a failure
 *     → "a call held for the person's yes is not a failure" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { aiGatewayConfig, resetCreditState } from "../src/agent/aiGateway.js";
import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { runTurn } from "../src/agent/turn.js";
import { CAUSES, failureShape, reportToolFailures, toolFailure, wireFailures } from "../src/agent/toolFailures.js";

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";

const reply = (blocks, stop) => ({ id: "msg", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } });
function scripted(rounds) {
  const queue = [...rounds];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error("the script ran out");
    return new Response(JSON.stringify(reply(next.blocks, next.stop)), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const calls = (...made) => ({ blocks: made.map(([name, input], n) => ({ type: "tool_use", id: `t${n}`, name, input })), stop: "tool_use" });
const answer = { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" };
const tool = (name) => ({ name, description: `${name}.`, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });

async function turn(rounds, callTool) {
  resetCreditState();
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    const result = await runTurn({
      question: "what's on my list",
      credential: { provider: BUILTIN_PROVIDER, apiKey: null },
      tools: [tool("read_note"), tool("search_notes")],
      callTool,
      env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
      providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl: scripted(rounds), metadata: { client: "texts", workspace: "ws_test" } },
      builtinModelOverride: HAIKU,
    });
    const logged = lines.filter((line) => typeof line === "string" && line.includes('"tex_tool_failed"')).map((line) => JSON.parse(line));
    return { result, logged };
  } finally {
    console.log = log;
  }
}

test("a tool that says no is kept as refused, with its reason shaped", async () => {
  const { result, logged } = await turn([calls(["read_note", { path: "projects/secret-plan.md" }]), answer], async () => ({
    content: [{ type: "text", text: "No note at projects/secret-plan.md. Search for it first.\nMore detail here." }],
    isError: true,
  }));
  assert.deepEqual(result.timing.failures, [{ tool: "read_note", cause: "refused", why: "No note at <path>. Search for it first.", ms: result.timing.failures[0].ms, model: HAIKU, round: 0 }]);
  assert.equal(logged.length, 1, "logged as it happened");
  assert.deepEqual({ event: logged[0].event, client: logged[0].client, workspace: logged[0].workspace, tool: logged[0].tool, cause: logged[0].cause }, { event: "tex_tool_failed", client: "texts", workspace: "ws_test", tool: "read_note", cause: "refused" });
  assert.ok(!JSON.stringify(logged).includes("secret-plan"), "the path never reaches the log");
});

test("a tool that throws is kept as threw with its class, which the model never reads", async () => {
  class StorageUnavailable extends Error {
    constructor(message) { super(message); this.name = "StorageUnavailable"; }
  }
  let seen = null;
  const { result } = await turn([calls(["search_notes", { query: "x" }]), answer], async () => {
    throw new StorageUnavailable("bucket 4815 answered 503");
  });
  assert.deepEqual(result.timing.failures.map(({ tool, cause, why }) => ({ tool, cause, why })), [{ tool: "search_notes", cause: "threw", why: "StorageUnavailable: bucket <n> answered <n>" }]);
  seen = result.live?.messages?.find((message) => message.role === "tool")?.text ?? "";
  assert.ok(!seen.includes("StorageUnavailable"), "the model still reads only that the call failed");
});

test("a tool it was never given is kept as not_offered, under the name the model wrote", async () => {
  const { result } = await turn([calls(["delete_everything", {}]), answer], async () => ({ content: [{ type: "text", text: "ok" }] }));
  assert.deepEqual(result.timing.failures.map(({ tool, cause }) => ({ tool, cause })), [{ tool: "delete_everything", cause: "not_offered" }]);
});

test("a call held for the person's yes is not a failure, and a call that worked is not either", async () => {
  const { result, logged } = await turn([calls(["read_note", { path: "a.md" }], ["search_notes", { query: "y" }]), answer], async (name) =>
    name === "read_note" ? { content: [{ type: "text", text: "Not sent yet: waiting for their yes." }], isError: true, held: true } : { content: [{ type: "text", text: "found" }] },
  );
  assert.deepEqual(result.timing.failures, []);
  assert.equal(logged.length, 0);
});

test("a reason keeps our words and loses every value", () => {
  assert.equal(failureShape('There is no learned skill called "taxes 2026".'), "There is no learned skill called <q>.");
  assert.equal(failureShape("Could not reach https://example.com/a?b=1 for ada@example.com"), "Could not reach <url> for <email>");
  assert.equal(failureShape("@ada can't see 1-projects/foo/bar.md (3 of 12 tries)"), "<@> can't see <path> (<n> of <n> tries)");
  assert.equal(failureShape("Called +1 555 555 0100 at 10:30"), "Called <n> at <n>");
  assert.equal(failureShape("receipt.pdf is a pdf file: it can be attached, not read"), "<path> is a pdf file: it can be attached, not read");
  assert.equal(failureShape(""), "");
  assert.ok(failureShape("x".repeat(400)).length <= 160);
  assert.equal(failureShape("first line\nsecond line has the page text"), "first line");
});

test("a failure is always a known cause and a tool-shaped name, and a turn sends at most 20", () => {
  assert.equal(toolFailure({ tool: "Read Note!", cause: "weird" }).tool, "unknown_tool");
  assert.equal(toolFailure({ tool: "read_note", cause: "weird" }).cause, "refused");
  assert.ok(CAUSES.includes(toolFailure({ tool: "read_note", cause: "timed_out" }).cause));
  const many = Array.from({ length: 30 }, () => toolFailure({ tool: "read_note", cause: "refused", text: "no", model: HAIKU, round: 1, ms: 5 }));
  const wire = wireFailures(many);
  assert.equal(wire.length, 20);
  assert.deepEqual(wire[0], { tool: "read_note", cause: "refused", why: "no", model: HAIKU }, "the wire carries no times or rounds");
});

test("reporting sends the failures to the control plane, and nothing when there were none or it is down", async () => {
  const sent = [];
  const controlPlane = { recordToolFailures: async (...args) => sent.push(args) };
  const session = { accessToken: "token-not-real", workspaceId: "ws_test" };
  assert.equal(await reportToolFailures(controlPlane, session, "one", []), false);
  assert.equal(await reportToolFailures(controlPlane, session, "check_in", [toolFailure({ tool: "read_note", cause: "refused", text: "no" })]), true);
  assert.deepEqual(sent, [["token-not-real", "ws_test", { kind: "check_in", failures: [{ tool: "read_note", cause: "refused", why: "no" }] }]]);
  const down = { recordToolFailures: async () => { throw new Error("down"); } };
  assert.equal(await reportToolFailures(down, session, "one", [toolFailure({ tool: "read_note", cause: "refused", text: "no" })]), false);
});
