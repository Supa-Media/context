/**
 * The small edits a Tex Lab draft is changed with (`packages/shared/src/texLabOps.cjs`; Dev2, 2026-11-15: the AI over
 * the MCP and a person in the Lab edit one draft together). The control plane refuses an edit made against an older
 * revision only when a revision since touched the same piece; these tests pin which pieces overlap.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   overlaps() answers only a === b          "a removed step overlaps its fields and wires" fails
 *   applyOps() edits the graph it was given  "applying never changes the graph passed in" fails
 *   diffGraphs() skips moves                 "diff then apply gets the same graph" fails
 * (and, 2026-11-15, with the Lab's other edits:)
 *   remove keeps other steps' out:<id> reads   "remove takes the reads of the step's output with it ..." fails
 *   remove without the text/send refusal       "remove takes the reads of the step's output with it ..." fails
 *   convo_tool replacing the whole tool list   "a chat tool is merged one at a time ..." fails
 *   diffGraphs() without the models part       "a draft's own model is an edit ..." fails
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

test("a change outside steps, wires, modules, models and the conversation diffs as one put", () => {
  const a = main();
  const b = { ...JSON.parse(JSON.stringify(a)), folded: { door: { nodes: [], edges: [] } } };
  const ops = diffGraphs(a, b);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "put");
  assert.deepEqual(keysOf(ops[0]), ["*"]);
});

test("remove takes the reads of the step's output with it, and never removes text or send (the Lab's delSel)", () => {
  const g = main();
  const reader = g.nodes.find((n) => n.ctx?.some((c) => c.startsWith("out:")));
  const target = reader.ctx.find((c) => c.startsWith("out:")).slice(4);
  // Every step that reads it: the Job's output is read by the Job advisor and by the Job check Promote turned off.
  const readers = g.nodes.filter((n) => n.ctx?.includes("out:" + target));
  assert.deepEqual([target, readers.map((n) => n.id)], ["job", ["jobcheck", "jobadv"]]);
  const r = applyOps(g, [{ op: "remove", node: target }]);
  for (const n of readers) {
    assert.ok(!r.graph.nodes.find((m) => m.id === n.id).ctx.includes("out:" + target));
    assert.ok(r.keys.includes(`n:${n.id}:ctx`), "each reader's reading order is a piece the removal touched");
  }
  assert.match(r.said[0], new RegExp(`${readers.map((n) => n.id).join(", ")}'s reads of its output$`));
  for (const kept of ["text", "send"]) assert.throws(() => applyOps(g, [{ op: "remove", node: kept }]), /start and a send/);
  // The Lab's delete diffs as one remove: the reads it dropped are not edits of their own.
  const b = JSON.parse(JSON.stringify(g));
  b.nodes = b.nodes.filter((n) => n.id !== target);
  b.edges = b.edges.filter((e) => e.from !== target && e.to !== target);
  b.nodes.forEach((n) => (n.ctx = n.ctx.filter((c) => c !== "out:" + target)));
  assert.deepEqual(diffGraphs(g, b), [{ op: "remove", node: target }]);
  // And the undo of it (the diff back) brings the step, its wires and the reads back.
  const back = applyOps(r.graph, diffGraphs(r.graph, g)).graph;
  for (const n of readers) assert.deepEqual(back.nodes.find((m) => m.id === n.id).ctx, n.ctx);
  assert.ok(back.nodes.some((n) => n.id === target));
});

test("a draft's own model is an edit; deleting it moves its steps to Haiku, as the Lab's model form does", () => {
  const g = main();
  const id = someNode(g).id;
  const mine = { name: "Mine", full: "Mine", id: "vendor/mine", c: "--accent", runs: "api", custom: true };
  let r = applyOps(g, [{ op: "model", key: "x-mine", value: mine }, { op: "set", node: id, field: "model", value: "x-mine" }]);
  assert.deepEqual(r.graph.models["x-mine"], mine);
  assert.deepEqual(r.keys, ["md:x-mine", `n:${id}:model`]);
  const a = r.graph;
  r = applyOps(a, [{ op: "model", key: "x-mine", value: null }]);
  assert.equal(r.graph.models["x-mine"], undefined);
  assert.equal(r.graph.nodes.find((n) => n.id === id).model, "haiku-5-5");
  assert.ok(r.keys.includes(`n:${id}:model`));
  assert.throws(() => applyOps(g, [{ op: "model", key: "x-none", value: null }]), /no model "x-none"/);
  assert.throws(() => applyOps(g, [{ op: "model", key: "x-mine", value: { full: "nameless" } }]), /needs a name/);
  // The Lab's whole save records it as model edits, not a put.
  assert.deepEqual(diffGraphs(a, r.graph), [{ op: "model", key: "x-mine", value: null }]);
  assert.deepEqual(diffGraphs(g, a).map((o) => o.op), ["model", "set"]);
  assert.ok(!overlaps("md:x-mine", "m:x-mine"));
});

test("a chat tool is merged one at a time, as the Lab's Conversation tab does", () => {
  const g = { ...main(), convo: { tools: { web: true } } };
  const r = applyOps(g, [{ op: "convo_tool", tool: "mail", on: true }]);
  assert.deepEqual(r.graph.convo.tools, { web: true, mail: true });
  assert.deepEqual(r.keys, ["c:tools:mail"]);
  assert.deepEqual(applyOps(r.graph, [{ op: "convo_tool", tool: "web", on: null }]).graph.convo.tools, { mail: true });
  assert.throws(() => applyOps(g, [{ op: "convo_tool", tool: "web", on: "yes" }]), /true, false, or null/);
  // Two people turning on different tools both land; the whole list overlaps each tool.
  assert.ok(!overlaps("c:tools:web", "c:tools:mail"));
  assert.ok(overlaps("c:tools", "c:tools:mail"));
  assert.ok(!overlaps("c:tools", "c:toolsx"));
  const b = JSON.parse(JSON.stringify(g));
  b.convo.tools.mail = false;
  b.convo.days = 2;
  assert.deepEqual(diffGraphs(g, b), [{ op: "convo_tool", tool: "mail", on: false }, { op: "convo", field: "days", value: 2 }]);
});

test("every line has its whole form too, for tex_dev's changes", () => {
  const g = main();
  const long = "a goal of many words ".repeat(20).trim();
  const r = applyOps(g, [{ op: "set", node: someNode(g).id, field: "goal", value: long }]);
  assert.ok(r.said[0].length < 160);
  assert.ok(r.full[0].endsWith(long));
});

test("a group edit names a draft's own group box, conflicts only with itself, and round-trips through the diff", () => {
  const g0 = main();
  const box = { label: "Reply", goal: "Check the draft before it goes.", icon: "judge", x: 400, y: 300 };
  const { graph: g1, keys, said } = applyOps(g0, [{ op: "group", id: "reply", value: box }, { op: "set", node: "answerCheck", field: "group", value: "reply" }]);
  assert.deepEqual(g1.groups, { reply: box });
  assert.deepEqual(keys, ["g:reply", "n:answerCheck:group"]);
  assert.match(said[0], /added group reply \(Reply\)/);
  assert.deepEqual(diffGraphs(g0, g1), [{ op: "group", id: "reply", value: box }, { op: "set", node: "answerCheck", field: "group", value: "reply" }], "its own edit, never a whole put");
  const { graph: g2 } = applyOps(g1, [{ op: "group", id: "reply", value: null }]);
  assert.equal(g2.groups, undefined, "the last group dropped leaves no empty map");
  assert.ok(overlaps("g:reply", "g:reply") && !overlaps("g:reply", "g:intake"));
  assert.throws(() => applyOps(g0, [{ op: "group", id: "reply", value: { goal: "no label" } }]), /a group needs a label/);
  assert.throws(() => applyOps(g0, [{ op: "group", id: "reply", value: { label: "X", colour: "red" } }]), /no field colour/);
  assert.throws(() => applyOps(g0, [{ op: "group", id: "bad id", value: { label: "X" } }]), /not a group id/);
});

test("groups nest: a group names the group it sits in, never itself, one inside it, or a step's id (Dev2, 2026-11-16)", () => {
  const g0 = main();
  const { graph: g1, said } = applyOps(g0, [
    { op: "group", id: "outer", value: { label: "Outer" } },
    { op: "group", id: "inner", value: { label: "Inner", parent: "outer" } },
  ]);
  assert.deepEqual(g1.groups.inner, { label: "Inner", parent: "outer" });
  assert.match(said[1], /added group inner \(Inner\)/);
  assert.throws(() => applyOps(g1, [{ op: "group", id: "outer", value: { label: "Outer", parent: "outer" } }]), /cannot sit inside itself/);
  assert.throws(() => applyOps(g1, [{ op: "group", id: "outer", value: { label: "Outer", parent: "inner" } }]), /inner sits inside outer/);
  assert.throws(() => applyOps(g1, [{ op: "group", id: "inner", value: { label: "Inner", parent: "bad id" } }]), /parent is not a group id/);
  assert.throws(() => applyOps(g0, [{ op: "group", id: "fd", value: { label: "Front" } }]), /a step's id/);
});
