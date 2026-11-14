/**
 * The config's wires run Tex, not code (Dev2, 2026-11-14: "it's not fine for the connections between node to be code.
 * They should be predefined"). `packages/shared/src/texGraph.cjs` is the one interpreter of `texConfig.json`'s wires.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-14):
 *   fires() always true                       "a wire's when picks the branch from the node's output" fails
 *   the Proxy in runNode removed               "a node can call only what its uses wires reach" fails
 *   orderFrom() without the visit of feeders   "a node fed by two runs once, after both" fails
 *   keep() never called                        "every node run is logged by the runner" fails
 *   checkShape() calls removed                 "a node's schemas are its contract" fails
 *   the wire's rounds ignored in io.back       "a loop wire's rounds limit" fails
 *   fire() without its wire lookup             "fire runs one node over a config wire" fails
 *   sendBack() runs only the target            "work sent back passes the wait path" fails
 *   stopAt ignored in run()                    "stopAt runs a node" fails
 *   carried() returns the output as it is      "a wire hands on the output without its when" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import graphLib from "../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

const { createGraph, problemsOf, coverageProblems, GraphError } = graphLib;

const node = (id, extra = {}) => ({ id, on: true, rounds: 1, ...extra });
const wire = (from, to, mode = "wait", when = ["*"]) => ({ from, to, mode, when });

test("Tex's own config is a sound graph: every wire joins two nodes, every mode is known, and a turn always ends", () => {
  assert.deepEqual(problemsOf(TEX_CONFIG), []);
});

test("a graph with a wait cycle, an unknown mode or a dangling wire is refused", () => {
  assert.match(problemsOf({ nodes: [node("a"), node("b")], edges: [wire("a", "b"), wire("b", "a")] }).join(), /cycle/);
  assert.match(problemsOf({ nodes: [node("a"), node("b")], edges: [wire("a", "b", "sometimes")] }).join(), /mode/);
  assert.match(problemsOf({ nodes: [node("a")], edges: [wire("a", "ghost")] }).join(), /not there/);
  assert.throws(() => createGraph({ nodes: [node("a")], edges: [wire("a", "ghost")] }, {}), GraphError);
});

test("a wire's when picks the branch from the node's output", async () => {
  const config = {
    nodes: [node("text", { kind: "input" }), node("triage"), node("decide"), node("lanes")],
    edges: [wire("text", "triage"), wire("triage", "decide", "wait", ["judge"]), wire("triage", "lanes", "wait", ["tex"]), wire("decide", "lanes")],
  };
  const impls = { text: async (x) => x, triage: async (x) => ({ to: x.many ? "judge" : "tex" }), decide: async () => ({ act: "answer" }), lanes: async () => ({ queued: true }) };
  const g = createGraph(config, impls);
  assert.deepEqual((await g.run("text", { many: false })).ran, ["text", "triage", "lanes"]);
  assert.deepEqual((await g.run("text", { many: true })).ran, ["text", "triage", "decide", "lanes"]);
});

test("a node fed by two runs once, after both, on their outputs merged", async () => {
  const config = { nodes: [node("a", { kind: "input" }), node("b"), node("c"), node("d")], edges: [wire("a", "c"), wire("a", "b"), wire("b", "c"), wire("c", "d")] };
  const seen = [];
  const g = createGraph(config, {
    a: async () => ({ fromA: 1 }),
    b: async () => ({ fromB: 2 }),
    c: async (x) => (seen.push(x), { both: x }),
    d: async (x) => x,
  });
  const { ran } = await g.run("a", {});
  assert.deepEqual(ran, ["a", "b", "c", "d"]);
  assert.deepEqual(seen, [{ fromA: 1, fromB: 2 }]);
});

test("a node can call only what its uses wires reach, and send work back only on a loop wire, as often as its rounds", async () => {
  const config = {
    nodes: [node("fd", { kind: "input", rounds: 2 }), node("tools"), node("advisor"), node("reviewer")],
    edges: [wire("fd", "tools", "uses", ["action"]), wire("fd", "reviewer"), wire("reviewer", "fd", "loop")],
  };
  let backs = 0;
  const g = createGraph(config, {
    fd: async (x, io) => (x?.again ? { said: "fixed" } : { said: await io.use.tools({ q: 1 }) }),
    tools: async (x) => `result ${x.q}`,
    advisor: async () => "never",
    reviewer: async (x, io) => {
      backs += 1;
      if (backs === 1) await io.back.fd({ again: true });
      return { verdict: "ok" };
    },
  });
  const r = await g.run("fd", {});
  assert.equal(r.outputs.fd.said, "result 1");
  assert.deepEqual(r.ran, ["fd", "reviewer"]);
  const sneaky = createGraph(config, { fd: async (_x, io) => io.use.advisor({}), tools: async () => 1, advisor: async () => 2, reviewer: async () => ({}) });
  await assert.rejects(sneaky.run("fd", {}), /no uses wire to "advisor"/);
  const greedy = createGraph(config, { fd: async () => ({}), tools: async () => 1, advisor: async () => 2, reviewer: async (_x, io) => (await io.back.fd({}), await io.back.fd({}), await io.back.fd({})) });
  await assert.rejects(greedy.run("fd", {}), /more than 2 times/);
});

test("a background wire runs its target in the background, a node that is off never runs, and a node with no code here is handed off", async () => {
  const config = {
    nodes: [node("a", { kind: "input" }), node("off", { on: false }), node("send"), node("classifier"), node("door")],
    edges: [wire("a", "off"), wire("a", "send"), wire("send", "classifier", "background"), wire("send", "door")],
  };
  const later = [];
  const handed = [];
  const g = createGraph(
    config,
    { a: async () => ({}), off: async () => assert.fail("an off node ran"), send: async () => ({ sent: 1 }), classifier: async () => ({ thread: "t" }) },
    { background: (p) => later.push(p), handOff: async (id, input) => (handed.push(id), { from: "elsewhere", input }) },
  );
  const { ran } = await g.run("a", {});
  assert.deepEqual(ran, ["a", "send", "door"]);
  assert.equal(later.length, 1);
  assert.deepEqual(handed, ["door"]);
  await Promise.all(later);
});

test("every node run is logged by the runner, as its config shapes it, functions and secrets of the context never", async () => {
  const config = {
    nodes: [node("a", { kind: "input" }), node("b")],
    edges: [wire("a", "b")],
  };
  const logs = [];
  const g = createGraph(config, { a: async () => ({ to: "tex", why: "one text", extra: () => 1 }), b: async () => { throw new TypeError("boom"); } }, { log: (e) => logs.push(e), now: () => 5 });
  await assert.rejects(g.run("a", { texts: ["1-1"] }, { token: "never", store: { secret: "s" } }), TypeError);
  assert.deepEqual(logs.map((l) => [l.node, l.ok]), [["a", true], ["b", false]]);
  assert.deepEqual(logs[0].input, { texts: ["1-1"] });
  assert.deepEqual(logs[0].output, { to: "tex", why: "one text" });
  assert.equal(logs[1].error, "TypeError");
  assert.doesNotMatch(JSON.stringify(logs), /never|secret/);
});

test("the code must match the config: every node has code in exactly one process, and no code for a node that isn't there", () => {
  const config = { nodes: [node("a"), node("b")], edges: [] };
  assert.deepEqual(coverageProblems(config, { gateway: ["a"], worker: ["b"] }), []);
  assert.match(coverageProblems(config, { gateway: ["a"] }).join(), /"b" has no code/);
  assert.match(coverageProblems(config, { gateway: ["a", "b"], worker: ["b"] }).join(), /both/);
  assert.match(coverageProblems(config, { gateway: ["a", "b", "ghost"] }).join(), /ghost/);
});

test("a node's schemas are its contract: a missing, mistyped or unnamed field fails the node, optional ones may be absent", async () => {
  const config = {
    nodes: [
      node("a", {
        kind: "input",
        inSchema: [{ name: "texts", type: "ids" }, { name: "note", type: "text", optional: true }],
        outSchema: [{ name: "to", type: "choice", options: "tex, judge, running" }, { name: "score", type: "score", options: "0-1" }, { name: "why", type: "text" }],
      }),
    ],
    edges: [],
  };
  const run = (input, output) => createGraph(config, { a: async () => output }).run("a", input);
  const good = { to: "tex", score: 0.5, why: "one text", when: ["tex"] };
  assert.deepEqual((await run({ texts: ["1"] }, good)).ran, ["a"]);
  await assert.rejects(run({}, good), /"a" input has no "texts"/);
  await assert.rejects(run({ texts: [1] }, good), /"texts" is not a list of ids/);
  await assert.rejects(run({ texts: ["1"], extra: 1 }, good), /input has "extra"/);
  await assert.rejects(run({ texts: ["1"] }, { ...good, to: "nobody" }), /"to" is "nobody", not one of tex, judge, running/);
  await assert.rejects(run({ texts: ["1"] }, { ...good, score: 2 }), /outside 0-1/);
  await assert.rejects(run({ texts: ["1"] }, { to: "tex", score: 0 }), /output has no "why"/);
  await assert.rejects(run({ texts: ["1"] }, { ...good, leak: "x" }), /output has "leak"/);
  await assert.rejects(run({ texts: ["1"] }, "just text"), /output is not an object/);
});

test("a wire hands on the output without its when, so a tagged output feeds a node whose input schema names its fields", async () => {
  const config = {
    nodes: [node("a", { kind: "input", outSchema: [{ name: "x", type: "text" }] }), node("b", { inSchema: [{ name: "x", type: "text" }] })],
    edges: [wire("a", "b", "wait", ["next"])],
  };
  let seen = null;
  const { ran } = await createGraph(config, { a: async () => ({ x: "hi", when: ["next"] }), b: async (input) => ((seen = input), {}) }).run("a", {});
  assert.deepEqual(ran, ["a", "b"]);
  assert.deepEqual(seen, { x: "hi" });
});

test("a loop wire's rounds limit how often work goes back, before the target's own", async () => {
  const config = {
    nodes: [node("fd", { kind: "input", rounds: 5 }), node("reviewer")],
    edges: [wire("fd", "reviewer"), { ...wire("reviewer", "fd", "loop"), rounds: 2 }],
  };
  let n = 0;
  const g = createGraph(config, { fd: async () => ({}), reviewer: async (_x, io) => { while (n < 3) { n += 1; await io.back.fd({}); } return {}; } });
  await assert.rejects(g.run("fd", {}), /more than 2 times/);
  assert.equal(n, 3);
});

test("fire runs one node over a config wire, for code not on the runner yet, and refuses a wire the config lacks", async () => {
  const logs = [];
  const config = { nodes: [node("send", { kind: "input" }), node("classifier"), node("other")], edges: [wire("send", "classifier", "background")] };
  const g = createGraph(config, { send: async () => ({}), classifier: async (x) => ({ thread: x.t }), other: async () => ({}) }, { log: (e) => logs.push(e) });
  assert.deepEqual(await g.fire("send", "classifier", { t: "a" }), { thread: "a" });
  assert.equal(logs[0].via, "send:background");
  await assert.rejects(g.fire("send", "other", {}), /no wire from "send" to "other"/);
});

test("stopAt runs a node but fires none of its wires, so a caller can hand the rest of the turn to code not yet moved", async () => {
  const config = { nodes: [node("a", { kind: "input" }), node("b"), node("c")], edges: [wire("a", "b"), wire("b", "c")] };
  const g = createGraph(config, { a: async () => ({}), b: async () => ({ at: "b" }), c: async () => assert.fail("c ran past stopAt") });
  const r = await g.run("a", {}, {}, { stopAt: ["b"] });
  assert.deepEqual(r.ran, ["a", "b"]);
  assert.deepEqual(r.outputs.b, { at: "b" });
});

test("work sent back passes the wait path from its target to the sender again, each step logged as via the loop", async () => {
  const config = {
    nodes: [node("fd", { kind: "input", rounds: 2 }), node("checks"), node("reviewer"), node("send")],
    edges: [wire("fd", "checks"), wire("checks", "reviewer"), wire("reviewer", "send"), wire("reviewer", "fd", "loop"), wire("checks", "fd", "loop")],
  };
  const logs = [];
  let reviews = 0;
  const g = createGraph(config, {
    fd: async (x) => ({ draft: x?.fix ? "v2" : "v1" }),
    checks: async (x) => ({ draft: x.draft, checked: true }),
    reviewer: async (x, io) => {
      reviews += 1;
      if (x.draft === "v1") return { draft: (await io.back.fd({ fix: true })).draft, back: await Promise.resolve(true) };
      return { draft: x.draft };
    },
    send: async (x) => ({ sent: x.draft }),
  }, { log: (e) => logs.push(e) });
  const r = await g.run("fd", {});
  assert.equal(r.outputs.send.sent, "v2");
  assert.deepEqual(logs.filter((l) => l.via === "reviewer:loop").map((l) => l.node), ["fd", "checks"]);
  const direct = createGraph(config, { fd: async () => ({ d: 1 }), checks: async (_x, io) => ({ again: await io.back.fd({}) }), reviewer: async () => ({}), send: async () => ({}) });
  assert.deepEqual((await direct.run("fd", {})).outputs.checks, { again: { d: 1 } });
});
