/**
 * TEX'S OWN COMPUTER (`../src/agent/texComputerSandbox.js`, node `computer`, `infra/tex-computer`; Dev2 picked
 * Cloudflare Sandbox, 2026-11-20).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `computerInput` taking the owner from the model's args instead of the turn's tag.
 *     → "the owner is the turn's tag, never one the model names" fails.
 *  2. `computerNode` passing a non-hex owner on to the service.
 *     → "the node asks the service for one operation of one tag, and refuses anything else" fails.
 *  3. `computerOut` passing every field the service answers through.
 *     → "through a draft that wires tools -> computer: one call is the node, logged and shaped" fails (the strict schema refuses it).
 *  4. The node registered on main's config instead of the shelf.
 *     → "on the shelf: not wired on main, so nothing is offered" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { COMPUTER_OPS, TEX_COMPUTER_TOOL, computerInput, computerWords, texComputerTool } from "../src/agent/texComputerSandbox.js";
import { computerNode, computerOut } from "../src/agent/graph/nodes/computer.js";
import { GATEWAY_NODES } from "../src/agent/graph/gatewayNodes.js";
import { gatewayGraph } from "../src/agent/graph/gatewayGraph.js";
import { TEX_CONFIG, withDraft } from "../src/agent/texConfig.js";
import { ASSISTANT_SEND_ACTIONS } from "../src/agent/sixTools.js";
import SHELF from "../../../packages/tex/src/texNodeShelf.json" with { type: "json" };

const TAG = "a".repeat(64);

/** A fake TEX_COMPUTER binding that records what it was asked and answers `answer`. */
function service(answer = { ok: true, exitCode: 0, stdout: "2\n", stderr: "", timedOut: false, started: true, ms: 12, woke: true }) {
  const asked = [];
  return {
    asked,
    fetch: async (url, init) => {
      asked.push({ url, body: JSON.parse(init.body) });
      return Response.json(answer, { status: 200 });
    },
  };
}

test("the owner is the turn's tag, never one the model names", () => {
  const { input } = computerInput({ op: "run", command: "ls", owner: "b".repeat(64) }, TAG);
  assert.equal(input.owner, TAG);
  assert.deepEqual(computerInput({ op: "run", command: "ls", timeout_seconds: 500 }, TAG).input, { op: "run", owner: TAG, command: "ls", timeoutMs: 110_000 });
  assert.match(computerInput({ op: "shell" }, TAG).refused, /op must be one of/);
  assert.match(computerInput({ op: "run", command: " " }, TAG).refused, /needs a command/);
  assert.match(computerInput({ op: "write", path: "a.txt" }, TAG).refused, /content/);
  assert.match(computerInput({ op: "read" }, TAG).refused, /needs a path/);
  assert.deepEqual(COMPUTER_OPS, ["run", "read", "write", "list", "stop"]);
});

test("the node asks the service for one operation of one tag, and refuses anything else", async () => {
  const fake = service();
  const out = await computerNode({ op: "run", owner: TAG, command: "wc -l a.csv" }, { ctx: { env: { TEX_COMPUTER: fake } } });
  assert.equal(fake.asked.length, 1);
  assert.equal(fake.asked[0].url, "https://tex-computer/computer/run");
  assert.deepEqual(fake.asked[0].body, { owner: TAG, command: "wc -l a.csv" });
  assert.equal(out.ok, true);
  assert.equal(out.stdout, "2\n");
  assert.equal(out.woke, true);
  for (const owner of ["alice", "", undefined, "A".repeat(64)]) {
    const refused = await computerNode({ op: "run", owner, command: "ls" }, { ctx: { env: { TEX_COMPUTER: fake } } });
    assert.equal(refused.ok, false);
  }
  assert.equal(fake.asked.length, 1, "a refused call never reaches the service");
  assert.deepEqual(await computerNode({ op: "run", owner: TAG, command: "ls" }, { ctx: { env: {} } }), { ok: false, error: "this deployment has no computer for Tex", ms: 0 });
});

test("the node's output carries only its schema's fields", () => {
  const out = computerOut({ ok: true, text: "hi", bytes: 2, secret: "x", woke: false }, 5);
  assert.deepEqual(out, { ok: true, ms: 5, text: "hi", bytes: 2, woke: false });
  assert.deepEqual(computerOut(null, 3), { ok: false, ms: 3, error: "the computer did not answer" });
});

test("the model reads a failed command as its exit code and stderr, and a refusal as an error", () => {
  const failed = computerWords({ ok: false, exitCode: 1, stdout: "", stderr: "No such file", timedOut: false, ms: 3 });
  assert.equal(failed.isError, false);
  assert.match(failed.text, /Exit code 1\.\nstderr:\nNo such file/);
  const refused = computerWords({ ok: false, error: "path must be inside the work folder", ms: 1 });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /refused: path must be inside the work folder/);
  assert.match(computerWords({ ok: true, woke: true, entries: [{ name: "data", type: "folder" }], folder: "." }).text, /asleep and just started[\s\S]*\.: data\//);
  assert.equal(computerWords(null).isError, true);
});

test("on the shelf: not wired on main, so nothing is offered", () => {
  assert.ok(SHELF.nodes.computer, "texNodeShelf.json lists it");
  assert.equal(GATEWAY_NODES.computer, computerNode);
  assert.equal(TEX_CONFIG.nodes.some((node) => node.id === "computer"), false);
  assert.equal(gatewayGraph().wired("tools", "computer"), false);
  assert.equal(ASSISTANT_SEND_ACTIONS.tex_computer.tool, TEX_COMPUTER_TOOL);
});

/** The step as the Lab draft draws it. */
export const COMPUTER_STEP = {
  id: "computer",
  label: "Tex's computer",
  model: "code",
  on: true,
  group: "tools-subagents",
  timeoutS: 150,
  inSchema: [
    { name: "op", type: "choice", options: "run, read, write, list, stop" },
    { name: "owner", type: "text" },
    { name: "command", type: "text", optional: true },
    { name: "path", type: "text", optional: true },
    { name: "content", type: "text", optional: true },
    { name: "timeoutMs", type: "number", optional: true },
  ],
  outSchema: [
    { name: "ok", type: "yesno" },
    { name: "ms", type: "number" },
    ...["error", "stdout", "stderr", "text", "folder"].map((name) => ({ name, type: "text", optional: true })),
    ...["exitCode", "bytes", "more"].map((name) => ({ name, type: "number", optional: true })),
    ...["timedOut", "started", "binary", "stopped", "woke"].map((name) => ({ name, type: "yesno", optional: true })),
    { name: "entries", type: "list", optional: true },
  ],
};

test("through a draft that wires tools -> computer: one call is the node, logged and shaped", async () => {
  const draft = { nodes: [...TEX_CONFIG.nodes, COMPUTER_STEP], edges: [...TEX_CONFIG.edges, { from: "tools", to: "computer", mode: "uses", when: ["computer"] }] };
  const config = withDraft(TEX_CONFIG, draft);
  const runs = [];
  const graph = gatewayGraph({ config, log: (run) => runs.push(run) });
  assert.equal(graph.wired("tools", "computer"), true);
  const fake = service({ ok: true, exitCode: 0, stdout: "done\n", stderr: "", timedOut: false, started: true, ms: 40, woke: false, extra: "dropped" });
  const tool = texComputerTool({ gate: (input) => graph.fire("tools", "computer", input, { env: { TEX_COMPUTER: fake } }), owner: TAG });
  const answer = await tool.call({ op: "run", command: "echo done" });
  assert.notEqual(answer.isError, true);
  assert.match(answer.content[0].text, /Exit code 0\.\nstdout:\ndone/);
  assert.equal(fake.asked[0].body.owner, TAG);
  const run = runs.find((r) => r.node === "computer");
  assert.ok(run, "the call is logged as the computer node's run");
  assert.equal(run.ok, true);
});
