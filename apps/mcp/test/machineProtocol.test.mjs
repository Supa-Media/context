/**
 * The machine protocol (packages/shared/src/machineProtocol.*): the schema,
 * the types generated from it, the examples both sides test against, and the
 * validator every runner frame passes through before the workspace object
 * reads it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { generate } from "../../../packages/shared/scripts/machineProtocolTypes.mjs";

const require = createRequire(import.meta.url);
const protocol = require("../../../packages/shared/src/machineProtocol.cjs");
const examples = require("../../../packages/shared/src/machineProtocol.examples.json");
const SRC = new URL("../../../packages/shared/src/", import.meta.url);

test("the generated TypeScript types match the schema", () => {
  assert.equal(readFileSync(new URL("machineProtocol.generated.ts", SRC), "utf8"), generate(), "run node packages/shared/scripts/machineProtocolTypes.mjs");
});

test("every example is valid, and every message has one", () => {
  const seen = new Set();
  for (const message of examples.server) {
    assert.equal(protocol.invalid("ServerMessage", message), null, message.type);
    seen.add(message.type);
  }
  for (const message of examples.runner) {
    assert.equal(protocol.invalid("RunnerMessage", message), null, message.type);
    seen.add(message.type);
  }
  for (const union of ["ServerMessage", "RunnerMessage"]) {
    for (const option of protocol.schema.$defs[union].oneOf) {
      const name = option.$ref.replace("#/$defs/", "");
      assert.ok(seen.has(protocol.schema.$defs[name].properties.type.const), `no example of ${name}`);
    }
  }
  for (const [name, value] of Object.entries(examples.pairing)) assert.equal(protocol.invalid(name, value), null, name);
});

test("server and runner messages are disjoint: a runner cannot send what only the server may", () => {
  for (const message of examples.server) assert.notEqual(protocol.invalid("RunnerMessage", message), null, message.type);
  for (const message of examples.runner) assert.notEqual(protocol.invalid("ServerMessage", message), null, message.type);
});

test("a runner frame is parsed only when it is valid", () => {
  const step = examples.runner.find((m) => m.type === "step");
  assert.deepEqual(protocol.parseRunnerFrame(JSON.stringify(step)), { ok: true, message: step });
  const bad = (value) => protocol.parseRunnerFrame(typeof value === "string" ? value : JSON.stringify(value));
  assert.equal(bad("not json").ok, false);
  assert.equal(protocol.parseRunnerFrame(42).ok, false);
  assert.match(bad({ ...step, extra: 1 }).error, /extra: not allowed/);
  assert.match(bad({ ...step, seq: 0 }).error, /seq: below 1/);
  assert.match(bad({ ...step, seq: 1.5 }).error, /seq: must be integer/);
  assert.match(bad({ ...step, runId: "../x" }).error, /runId: bad format/);
  assert.match(bad({ ...step, target: "x".repeat(301) }).error, /target: too long/);
  assert.match(bad({ type: "step", runId: "r" }).error, /required/);
  assert.match(bad({ type: "run_command", command: "rm -rf /" }).error, /unknown message/);
  assert.match(bad({ ...step, type: "assign" }).error, /unknown message|required|not allowed/);
  assert.equal(bad("x".repeat(protocol.MAX_FRAME_BYTES + 1)).error, "frame too large");
  // __proto__ in a frame is an own key after JSON.parse, and is refused like any other.
  assert.match(bad(`{"type":"accept","runId":"r","__proto__":{"x":1}}`).error, /not allowed/);
});

test("the protocol has no message that runs a command", () => {
  // Design, "Security": the workspace object can only assign, deliver, interrupt and cancel.
  const types = protocol.schema.$defs.ServerMessage.oneOf.map((o) => protocol.schema.$defs[o.$ref.replace("#/$defs/", "")].properties.type.const);
  assert.deepEqual(types.sort(), ["assign", "cancel", "challenge", "goodbye", "interrupt", "message", "rules", "welcome"]);
  for (const key of Object.keys(protocol.schema.$defs.Assign.properties)) assert.doesNotMatch(key, /command|shell|exec|argv|env/i);
});

test("a run grant must be https and a machine job lasts at most 24 hours", () => {
  const assign = structuredClone(examples.server.find((m) => m.type === "assign"));
  assign.grant.mcpUrl = "http://mcp.example.test/mcp";
  assert.match(protocol.invalid("ServerMessage", assign), /mcpUrl: bad format/);
  const welcome = structuredClone(examples.server.find((m) => m.type === "welcome"));
  welcome.rules.limits.longestRunMs = protocol.MAX_LONGEST_RUN_MS + 1;
  assert.match(protocol.invalid("ServerMessage", welcome), /longestRunMs: above/);
  assert.equal(protocol.DEFAULT_LIMITS.longestRunMs, 4 * 60 * 60 * 1000);
});

test("signing texts are bound to purpose and machine", () => {
  assert.equal(protocol.helloSigningText("mch_a", "n"), "context-machine-hello:v1:mch_a:n");
  assert.notEqual(protocol.helloSigningText("mch_a", "n"), protocol.helloSigningText("mch_b", "n"));
  assert.notEqual(protocol.pairSigningText("x"), protocol.helloSigningText("x", ""));
});

test("slot counts follow the design's examples", () => {
  assert.deepEqual(protocol.slotCounts(4096, 2), { recommended: 1, most: 1 });
  assert.deepEqual(protocol.slotCounts(8192, 4), { recommended: 2, most: 4 });
  assert.deepEqual(protocol.slotCounts(16384, 8), { recommended: 4, most: 8 });
  assert.deepEqual(protocol.slotCounts(1024, 1), { recommended: 1, most: 1 });
  assert.deepEqual(protocol.slotCounts(262144, 128), { recommended: 8, most: 8 });
});

test("the validator refuses a schema keyword it does not check", () => {
  const def = protocol.schema.$defs.Accept;
  def.properties.runId = { ...def.properties.runId, format: "uuid" };
  try {
    assert.throws(() => protocol.invalid("Accept", { type: "accept", runId: "r" }), /keyword format/);
  } finally {
    def.properties.runId = { $ref: "#/$defs/Id" };
  }
});
