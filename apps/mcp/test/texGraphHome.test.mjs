/**
 * Every node of Tex's config has code on the graph runner or is named in `notYet`, never both and never neither, and no
 * code runs as a node the config does not have (Dev2, 2026-11-14: "There should not be any code or any node that's
 * running that isn't shown in the config"). Every node runs in the gateway (Dev2, 2026-11-14), so `GATEWAY_NODES` is
 * the one table; `packages/shared/src/texGraphNotYet.json` is the migration's ratchet and only ever shrinks.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-14):
 *   a node removed from notYet with no code in GATEWAY_NODES   "every node is on the runner or in notYet" fails
 *   a node put in GATEWAY_NODES and left in notYet             "every node is on the runner or in notYet" fails
 *   NOT_YET_MOST raised past the list's length                 "notYet only shrinks" fails
 *   a node file importing "./other.js"                          "no gateway node imports another node's code" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import NOT_YET from "../../../packages/shared/src/texGraphNotYet.json" with { type: "json" };
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { GATEWAY_NODES } from "../src/agent/graph/gatewayNodes.js";
import { gatewayGraph } from "../src/agent/graph/gatewayGraph.js";

const { coverageProblems } = graphLib;

/** The ratchet: lower it when a node leaves notYet; a pull request that raises it is adding shadow code back. */
const NOT_YET_MOST = 21;

test("every node is on the runner or in notYet, never both, and nothing on either is missing from the config", () => {
  assert.deepEqual(coverageProblems(TEX_CONFIG, { runner: Object.keys(GATEWAY_NODES), notYet: NOT_YET.notYet }), []);
  for (const [id, impl] of Object.entries(GATEWAY_NODES)) assert.equal(typeof impl, "function", `GATEWAY_NODES "${id}" is not a function`);
});

test("notYet only shrinks", () => {
  assert.ok(NOT_YET.notYet.length <= NOT_YET_MOST, `notYet has ${NOT_YET.notYet.length} nodes, more than ${NOT_YET_MOST}: a node goes onto the runner, never back off it`);
});

test("no gateway node imports another node's code: they meet only through the config's wires", () => {
  const dir = new URL("../src/agent/graph/nodes/", import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".js")) : [];
  for (const file of files) {
    const src = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(src, /from\s+["']\.\/[^"']+["']|import\(\s*["']\.\/[^"']+["']\s*\)/, `${file} imports a sibling node: call it through io.use, and give it a uses wire`);
  }
});

test("the gateway's graph writes every node run to the chat's ledger as a node step", async () => {
  const written = [];
  const config = { nodes: [{ id: "a", kind: "input", on: true }, { id: "b", on: true }], edges: [{ from: "a", to: "b", mode: "wait", when: ["*"] }] };
  const g = gatewayGraph({ writer: { write: (e) => written.push(e) }, turn: "t1", config, nodes: { a: async () => ({ x: 1 }), b: async (x) => ({ y: x.x }) } });
  await g.run("a", {});
  await g.runNode("b", { x: 2 }, {}, "sendTheReply");
  assert.deepEqual(written.map((e) => [e.kind, e.step, e.name, e.via, e.turn, e.ok]), [
    ["step", "node", "a", "wait", "t1", true],
    ["step", "node", "b", "wait", "t1", true],
    ["step", "node", "b", "sendTheReply", "t1", true],
  ]);
  assert.deepEqual(written[2].output, { y: 2 });
});
