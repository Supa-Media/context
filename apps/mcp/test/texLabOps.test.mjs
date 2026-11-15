/**
 * The small edits a Tex Lab draft is changed with (`packages/shared/src/texLabOps.cjs`; Dev2, 2026-11-15: the AI over
 * the MCP and a person in the Lab edit one draft together). The control plane refuses an edit made against an older
 * revision only when a revision since touched the same piece; these tests pin which pieces overlap.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   overlaps() answers only a === b          "a removed step overlaps its fields and wires" fails
 *   applyOps() edits the graph it was given  "applying never changes the graph passed in" fails
 *   diffGraphs() skips moves                 "diff then apply gets the same graph" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyOps, conflicts, diffGraphs, keysOf, OpError, overlaps } from "../../../packages/shared/src/texLabOps.cjs";

const config = JSON.parse(readFileSync(new URL("../../../packages/shared/src/texConfig.json", import.meta.url), "utf8"));
const main = () => JSON.parse(JSON.stringify({ nodes: config.nodes, edges: config.edges }));
const someNode = (g) => g.nodes.find((n) => n.id === "fd") ?? g.nodes[0];

test("a set changes one field and says what it was", () => {
  const g = main();
  const id = someNode(g).id;
  const { graph, keys, said } = applyOps(g, [{ op: "set", node: id, field: "effort", value: "medium" }]);
  assert.equal(graph.nodes.find((n) => n.id === id).effort, "medium");
  assert.deepEqual(keys, [`n:${id}:effort`]);
  assert.match(said[0], new RegExp(`^set ${id} effort .* → medium$`));
});

test("applying never changes the graph passed in", () => {
  const g = main();
  const before = JSON.stringify(g);
  applyOps(g, [{ op: "set", node: someNode(g).id, field: "on", value: false }, { op: "remove", node: g.nodes[1].id }]);
  assert.equal(JSON.stringify(g), before);
});

test("a bad edit anywhere refuses the whole batch, naming it", () => {
  const g = main();
  assert.throws(() => applyOps(g, [{ op: "set", node: someNode(g).id, field: "on", value: false }, { op: "set", node: "nope", field: "on", value: true }]), (e) => e instanceof OpError && /edit 2 \(set\): there is no step "nope"/.test(e.message));
  assert.throws(() => applyOps(g, [{ op: "set", node: someNode(g).id, field: "id", value: "x" }]), /not a field/);
  assert.throws(() => applyOps(g, [{ op: "wire", from: someNode(g).id, to: "nowhere", mode: "wait" }]), /not there/);
  assert.throws(() => applyOps(g, [{ op: "wire", from: g.nodes[0].id, to: g.nodes[1].id, mode: "sideways" }]), /mode must be/);
  assert.throws(() => applyOps(g, [{ op: "add", node: { id: g.nodes[0].id } }]), /already a step/);
  assert.throws(() => applyOps(g, [{ op: "teleport" }]), /not an edit/);
  assert.throws(() => applyOps(g, []), /no edits/);
});

test("add, wire, unwire and remove", () => {
  const g = main();
  const from = someNode(g).id;
  let r = applyOps(g, [{ op: "add", node: { id: "probe", label: "Probe" } }, { op: "wire", from, to: "probe", mode: "background", when: ["answered"] }]);
  assert.ok(r.graph.nodes.find((n) => n.id === "probe" && n.model === "code" && n.on === true));
  assert.ok(r.graph.edges.find((e) => e.from === from && e.to === "probe" && e.mode === "background" && e.when[0] === "answered"));
  r = applyOps(r.graph, [{ op: "wire", from, to: "probe", mode: "background", when: ["look"] }]);
  assert.equal(r.graph.edges.filter((e) => e.from === from && e.to === "probe").length, 1, "a wire is one per from, to and mode");
  assert.match(r.said[0], /^rewired/);
  const un = applyOps(r.graph, [{ op: "unwire", from, to: "probe" }]);
  assert.ok(!un.graph.edges.some((e) => e.to === "probe"));
  const gone = applyOps(r.graph, [{ op: "remove", node: "probe" }]);
  assert.ok(!gone.graph.nodes.some((n) => n.id === "probe") && !gone.graph.edges.some((e) => e.to === "probe"));
  assert.match(gone.said[0], /and its 1 wire$/);
});

test("a removed step overlaps its fields and wires; different fields do not overlap", () => {
  assert.ok(overlaps("n:fd", "n:fd:effort"));
  assert.ok(overlaps("n:fd:effort", "n:fd"));
  assert.ok(overlaps("n:fd", "e:fd>reviewer>wait"));
  assert.ok(overlaps("e:fd>reviewer>*", "e:fd>reviewer>wait"));
  assert.ok(overlaps("*", "n:x:y"));
  assert.ok(!overlaps("n:fd:effort", "n:fd:model"));
  assert.ok(!overlaps("n:fd:effort", "n:fdx:effort"));
  assert.ok(!overlaps("n:fd", "n:fdx"));
  assert.ok(!overlaps("e:fd>reviewer>wait", "e:fd>reviewer>background"));
  assert.deepEqual(conflicts(["n:fd:effort", "n:a:on"], ["n:fd"]), ["n:fd:effort"]);
  assert.deepEqual(keysOf({ op: "move", node: "fd", x: 1, y: 2 }), ["n:fd:x", "n:fd:y"]);
});

test("diff then apply gets the same graph", () => {
  const a = main();
  const b = JSON.parse(JSON.stringify(a));
  const n = someNode(b);
  n.effort = "low";
  n.x += 40;
  b.nodes.splice(b.nodes.length - 1, 1);
  b.nodes.push({ ...JSON.parse(JSON.stringify(b.nodes[0])), id: "fresh" });
  b.edges = b.edges.filter((e) => e.from !== b.nodes[2].id);
  b.edges.push({ from: b.nodes[0].id, to: "fresh", mode: "wait", when: ["*"] });
  const dropped = a.nodes[a.nodes.length - 1].id;
  b.edges = b.edges.filter((e) => e.from !== dropped && e.to !== dropped);
  const ops = diffGraphs(a, b);
  assert.ok(ops.length > 0 && !ops.some((o) => o.op === "put"));
  const { graph } = applyOps(a, ops);
  const sort = (g) => ({ nodes: [...g.nodes].sort((x, y) => x.id.localeCompare(y.id)), edges: [...g.edges].map((e) => `${e.from}>${e.to}>${e.mode}>${e.when}`).sort() });
  assert.deepEqual(sort(graph), sort(b));
  assert.deepEqual(diffGraphs(a, a), []);
});

test("a module's words and a conversation setting are edits of their own", () => {
  const a = main();
  const b = { ...JSON.parse(JSON.stringify(a)), modules: { "p-rules": { text: "x" } }, convo: { days: 3 } };
  const ops = diffGraphs(a, b);
  assert.deepEqual(ops, [{ op: "module", key: "p-rules", value: { text: "x" } }, { op: "convo", field: "days", value: 3 }]);
  const { graph, keys, said } = applyOps(a, ops);
  assert.deepEqual([graph.modules, graph.convo, keys], [{ "p-rules": { text: "x" } }, { days: 3 }, ["m:p-rules", "c:days"]]);
  assert.match(said[0], /edited module p-rules \(its words\)/);
  assert.equal(applyOps(graph, [{ op: "module", key: "p-rules", value: null }]).graph.modules["p-rules"], undefined);
});

test("a change outside steps, wires, modules and the conversation diffs as one put", () => {
  const a = main();
  const b = { ...JSON.parse(JSON.stringify(a)), models: { "custom-1": { name: "Mine" } } };
  const ops = diffGraphs(a, b);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "put");
  assert.deepEqual(keysOf(ops[0]), ["*"]);
});
