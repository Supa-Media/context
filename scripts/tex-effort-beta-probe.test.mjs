import assert from "node:assert/strict";
import test from "node:test";
import { probeBody, summaryLine } from "./tex-effort-beta-probe.mjs";

test("the body ends with the effort-only system message and caches its prefix", () => {
  const body = probeBody();
  assert.deepEqual(body.messages.at(-1), { role: "system", content: [], output_config: { effort: "low" } });
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
});

test("a summary prints usage and never the reply text", () => {
  const line = summaryLine("v", 200, { content: [{ type: "text", text: "SECRET REPLY" }], usage: { input_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 2 } });
  assert.equal(line, "v: status 200, effort accepted yes, input 5, cache_read 4000, cache_creation 0, output 2");
});

test("a 400 naming output_config reads as refused, with the message bounded", () => {
  const line = summaryLine("v", 400, { error: { type: "invalid_request_error", message: "messages.1.output_config: Extra inputs are not permitted" } });
  assert.match(line, /effort accepted no/);
  assert.match(line, /error type invalid_request_error/);
});
