/**
 * An older tool's name, refused through a whole turn (Dev2, 2026-11-23: "we should only be using the send tool shape").
 * The model is shown only the six (orient, search, fetch, write, manage, send); a name it was not shown (send_email,
 * read_note, browse) used to run as itself. `runTurn` now refuses it in band, cause `older_name`, naming the six call
 * written out from the call's own arguments, with that action's manual, and dispatches nothing (`sixTools.js`
 * `olderName`, wired in `turn.js` runOne). The same work called through the six it was shown still runs.
 *
 * Sabotage (not yet applied; src/ and packages/ were out of this change's reach): `runOne` not calling `six.olderName`
 *   should fail "a raw older name ... is refused", since `resolve` passes an older name on as itself
 *   (`agentSixTools.test.mjs`) and send_email, read_note and browse would then be dispatched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { runTurn } from "../../../packages/tex/gateway/agent/turn.js";
import { aiGatewayConfig, resetCreditState } from "../../../packages/tex/gateway/agent/aiGateway.js";
import { toolDefinitions } from "../src/tools/registry.js";

const mcp = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
const held = (...names) =>
  names.map((name) => mcp.get(name) ?? { name, description: `${name} words.`, inputSchema: { type: "object", properties: {} } });

const ENV = {
  AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  AI_GATEWAY_ID: "context-gw",
  AI_GATEWAY_TOKEN: `gw-token-${"a".repeat(20)}`,
};
const HAIKU = "anthropic/claude-haiku-5-5";
const reply = (blocks, stop = "end_turn") => ({ id: "m", type: "message", role: "assistant", content: blocks, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });

/** One turn whose scripted model makes `calls` in its first round, then answers; what ran and what it was told. */
async function turnWith(calls, { fixedTools = "one" } = {}) {
  resetCreditState();
  const queue = [reply(calls, "tool_use"), reply([{ type: "text", text: "Done." }])];
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(queue.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const dispatched = [];
  const turn = await runTurn({
    question: "email Sam the plan, read my plan note and open the shop",
    tools: held("orient", "read_note", "send_email", "browse"),
    callTool: async (name, args) => {
      dispatched.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
    env: { ...ENV, AGENT_BUILTIN_MODEL: HAIKU },
    providerOptions: { gateway: aiGatewayConfig(ENV), fetchImpl },
    builtinModelOverride: HAIKU,
    // A texted 1:1 turn is shown the fixed list (`sixToolsFixed.js`), whose failures carry the action's manual.
    fixedTools,
  });
  const results = new Map(
    (bodies[1]?.messages ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === "tool_result")
      .map((block) => [block.tool_use_id, { error: block.is_error === true, text: typeof block.content === "string" ? block.content : JSON.stringify(block.content) }]),
  );
  return { turn, bodies, dispatched, results };
}

const EMAIL = { to: "sam@example.com", subject: "The plan", body: "Here it is." };

test("a raw older name the model was not shown is refused as older_name, naming its six call and the action's manual", async () => {
  const { bodies, dispatched, results, turn } = await turnWith([
    use("e", "send_email", EMAIL),
    use("r", "read_note", { path: "1-projects/plan.md" }),
    use("b", "browse", { steps: [{ do: "goto", url: "https://shop.example.com/" }] }),
  ]);
  const shownNames = bodies[0].tools.map((tool) => tool.name);
  for (const name of ["send_email", "read_note", "browse"]) assert.ok(!shownNames.includes(name), `${name} is not shown`);
  assert.deepEqual(dispatched, [], "nothing an older name named is dispatched");

  const email = results.get("e");
  assert.equal(email.error, true);
  assert.match(email.text, /send_email is not one of your tools; you have orient, search, fetch, write, manage, send\./);
  // The six call written out from the model's own flat arguments.
  assert.ok(email.text.includes(`Call it as send ${JSON.stringify({ action: "email", args: EMAIL })}.`), email.text);
  assert.match(email.text, /manual for email/i, "the email action's manual comes with the refusal");

  const browse = results.get("b");
  assert.equal(browse.error, true);
  assert.ok(browse.text.includes(`Call it as send ${JSON.stringify({ action: "browse", args: { steps: [{ do: "goto", url: "https://shop.example.com/" }] } })}.`), browse.text);
  assert.match(browse.text, /manual for browse/i);

  const read = results.get("r");
  assert.equal(read.error, true);
  assert.match(read.text, /^read_note is not one of your tools; you have orient, search, fetch, write, manage, send\./);
  assert.match(read.text, /fetch/);

  // Each is logged as a failure caused by its older name (`toolFailures.js`), the name the model called.
  assert.deepEqual(
    turn.timing.failures.map((failure) => [failure.tool, failure.cause]).sort(),
    [["browse", "older_name"], ["read_note", "older_name"], ["send_email", "older_name"]],
  );
  const refused = turn.timing.trace.filter((entry) => entry.kind === "tool");
  assert.ok(refused.every((entry) => entry.ok !== true), "no refused call is traced as a success");
});

test("the same work called through the six the model was shown still runs", async () => {
  const { dispatched, results } = await turnWith([
    use("e", "send", { action: "email", args: EMAIL }),
    use("r", "fetch", { id: "1-projects/plan.md" }),
  ]);
  assert.deepEqual(dispatched.map((call) => call.name).sort(), ["read_note", "send_email"]);
  // The carrier gets the model's words (the gateway's own translation makes `to` a list).
  assert.deepEqual(dispatched.find((call) => call.name === "send_email").args, { ...EMAIL, to: [EMAIL.to] });
  assert.deepEqual(dispatched.find((call) => call.name === "read_note").args, { path: "1-projects/plan.md" });
  assert.equal(results.get("e").error, false);
  assert.equal(results.get("r").error, false);
});
