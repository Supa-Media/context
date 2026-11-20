/**
 * The runner's pieces for jobs as config (Dev2, 2026-11-17, step 4): a run kept in a durable store resumes where it
 * stopped, a node that fails goes on down a wire that catches "failed", and a generator wire starts a new run through
 * the host, capped by its rounds.
 *
 * Sabotage record (2026-11-17, applied, run, failing, reverted):
 *   (i)   `progress.get` ignored in run: "a resumed run does not run again..." fails (b ran twice).
 *   (ii)  the failed catch removed: "a failure goes on down a failed wire" fails with the thrown error.
 *   (iii) the generation cap removed: "a generator wire's rounds cap the chain" fails (third start answered started).
 *   (iv)  the generator entry keeping its source's id: "resumed, failed and started entries..." fails (two entries share one).
 *   (v)   a failed entry's id not carried to its catcher: the same test fails (end's parent names no entry).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/tex/src/texGraph.cjs";

const { createGraph } = graphLib;
const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });

test("a resumed run does not run again what its store already holds, and keeps each new output", async () => {
  const config = { nodes: [node("a", { kind: "input" }), node("b"), node("c")], edges: [wire("a", "b"), wire("b", "c")] };
  const runs = [];
  const logs = [];
  const store = new Map([["a", { x: 1 }], ["b", { y: 2 }]]);
  const progress = { get: (id) => store.get(id), put: (id, out) => void store.set(id, out) };
  const g = createGraph(config, {
    a: async () => (runs.push("a"), { x: 1 }),
    b: async () => (runs.push("b"), { y: 2 }),
    c: async (input) => (runs.push("c"), { seen: input.y }),
  }, { log: (e) => logs.push(e) });
  const { outputs, ran } = await g.run("a", {}, {}, { progress });
  assert.deepEqual(runs, ["c"], "only the node the crash cut off runs");
  assert.deepEqual(outputs.c, { seen: 2 }, "fed by the kept output");
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.deepEqual(store.get("c"), { seen: 2 }, "and its own output is kept");
  assert.deepEqual(logs.filter((e) => e.resumed).map((e) => e.node), ["a", "b"], "the resumed nodes are logged as resumed");
});

test("a failure goes on down a failed wire, and still throws with none", async () => {
  const config = { nodes: [node("part", { kind: "input" }), node("end")], edges: [wire("part", "end", "wait", ["failed", "done"])] };
  let seen = null;
  const impls = { part: async () => { throw new Error("stream died"); }, end: async (input) => ((seen = input), { cause: input.failed ? "crashed" : "done" }) };
  const { outputs } = await createGraph(config, impls).run("part", {});
  assert.deepEqual(seen, { failed: { name: "Error", message: "stream died" } });
  assert.equal(outputs.end.cause, "crashed");
  const bare = { nodes: config.nodes, edges: [wire("part", "end", "wait", ["done"])] };
  await assert.rejects(createGraph(bare, impls).run("part", {}), /stream died/);
});

test("a generator wire starts a new run through the host, and its rounds cap the chain", async () => {
  const config = { nodes: [node("part", { kind: "input" }), node("end")], edges: [wire("part", "end"), { ...wire("end", "part", "generator", ["carry"]), rounds: 3 }] };
  const started = [];
  const g = createGraph(config, {
    part: async () => ({}),
    end: async (_x, io) => ({ next: await io.start.part({ when: ["carry"], n: 1 }) }),
  }, { start: async (to, input, meta) => (started.push([to, input, meta.generation]), { id: "run-2" }) });
  assert.deepEqual((await g.run("part", {}, { generation: 0 })).outputs.end.next, { started: true, id: "run-2" });
  assert.deepEqual(started, [["part", { n: 1 }, 1]], "the new run gets its input without routing tags, one generation on");
  assert.deepEqual((await g.run("part", {}, { generation: 1 })).outputs.end.next.started, true);
  assert.deepEqual((await g.run("part", {}, { generation: 2 })).outputs.end.next, { started: false, why: "spent" }, "the third run is the last");
  assert.equal(started.length, 2);
});

test("a node can start only what its generator wires reach", async () => {
  const config = { nodes: [node("a", { kind: "input" }), node("b", { kind: "input" })], edges: [] };
  const g = createGraph(config, { a: async (_x, io) => io.start.b({}), b: async () => ({}) }, { start: async () => ({}) });
  await assert.rejects(g.run("a", {}), /no generator wire to "b"/);
});

test("resumed, failed and started entries each get their own run id, and every parent names a kept entry", async () => {
  const config = {
    nodes: [node("a", { kind: "input" }), node("part"), node("end")],
    edges: [wire("a", "part"), wire("part", "end", "wait", ["failed"]), { ...wire("end", "a", "generator"), rounds: 5 }],
  };
  const logs = [];
  const store = new Map([["a", { x: 1 }]]);
  const progress = { get: (id) => store.get(id), put: (id, out) => void store.set(id, out) };
  const g = createGraph(config, {
    a: async () => ({ x: 1 }),
    part: async () => { throw new Error("stream died"); },
    end: async (_x, io) => ({ next: await io.start.a({}) }),
  }, { log: (e) => logs.push(e), start: async () => ({}) });
  await g.run("a", {}, {}, { progress });
  const ids = logs.map((e) => e.id);
  assert.ok(ids.every((id) => typeof id === "string" && id.length), "every entry has an id");
  assert.equal(new Set(ids).size, ids.length, "no two entries share one");
  for (const e of logs) if (e.parent) assert.ok(ids.includes(e.parent), `${e.node}'s parent ${e.parent} is a kept entry`);
  const failed = logs.find((e) => e.node === "part");
  assert.equal(logs.find((e) => e.node === "end" && !e.started).parent, failed.id, "the failed wire's target names the run that failed");
});
