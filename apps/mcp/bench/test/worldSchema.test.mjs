/**
 * The simulated world's model is pinned by structure, not by a seed (Haiku 5.5 has none): each call sends thinking off
 * and its shape as a JSON schema, with no temperature (`simWorld.mjs`). The Claude Code CLI gets the same schema, and
 * `--effort low`, only for those calls (`socketAnswerer.mjs`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WORLD_SCHEMAS, WORLD_SYSTEM_OPENING, createSimWorld, simMemo, worldSchema } from "../simWorld.mjs";
import { answerFrom, cliArgs } from "../socketAnswerer.mjs";

const reply = (text) => new Response(JSON.stringify({ content: [{ type: "text", text }], usage: {} }), { status: 200 });

test("a simulated search sends no temperature, thinking off, and the search's JSON schema", async () => {
  const bodies = [];
  const world = createSimWorld({ send: async (body) => (bodies.push(body), reply('{"results":[]}')), memo: simMemo() });
  await world.search("x");
  assert.equal(bodies.length, 1);
  const body = JSON.parse(bodies[0]);
  assert.equal("temperature" in body, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.output_config.format.type, "json_schema");
  assert.deepEqual(body.output_config.format.schema, worldSchema("web search"));
});

test("every world schema is a closed object at its top level", () => {
  for (const [kind, schema] of Object.entries(WORLD_SCHEMAS)) {
    assert.equal(schema.type, "object", kind);
    assert.equal(schema.additionalProperties, false, kind);
  }
  assert.equal(worldSchema("no such call"), null);
});

test("the CLI gets the schema and low effort for a world call only", () => {
  const world = {
    model: "claude-haiku-5-5",
    system: `${WORLD_SYSTEM_OPENING}: the websites, search engine, Google Calendar and Gmail it calls.`,
    output_config: { format: { type: "json_schema", schema: worldSchema("gmail read") } },
    messages: [],
  };
  const args = cliArgs(world, "/tmp/system.txt");
  const at = args.indexOf("--json-schema");
  assert.notEqual(at, -1);
  assert.deepEqual(JSON.parse(args[at + 1]), worldSchema("gmail read"));
  const effort = args.indexOf("--effort");
  assert.notEqual(effort, -1);
  assert.equal(args[effort + 1], "low");

  const tex = { model: "claude-haiku-5-5", system: "You are Tex", output_config: { format: { type: "json_schema", schema: { type: "object" } } }, messages: [] };
  const texArgs = cliArgs(tex, "/tmp/system.txt");
  assert.equal(texArgs.includes("--json-schema"), false);
  assert.equal(texArgs.includes("--effort"), false);
});

test("a world call's structured output is kept as its JSON text", () => {
  const stdout = JSON.stringify({ type: "result", result: "", structured_output: { a: 1 } });
  const answer = answerFrom({ model: "claude-haiku-5-5", system: "x", messages: [] }, stdout);
  assert.equal(answer.text, '{"a":1}');
});
