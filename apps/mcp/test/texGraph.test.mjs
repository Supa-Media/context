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

const { createGraph, problemsOf, coverageProblems, GraphError, provisionalWiring, provisionalHeld, orderFrom } = graphLib;

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

test("a release hands work back without spending a round, and left() says how many sends remain", async () => {
  const config = {
    nodes: [node("fd", { kind: "input" }), node("check")],
    edges: [wire("fd", "check"), { ...wire("check", "fd", "loop"), rounds: 2 }],
  };
  const seen = [];
  const g = createGraph(config, {
    fd: async () => ({}),
    check: async (_x, io) => {
      const back = io.back.fd;
      seen.push(back.left());
      await back({});
      await back({}, { release: true });
      await back({}, { release: true });
      seen.push(back.left());
      await back({});
      seen.push(back.left());
      await back({}, { release: true }); // a spent budget can still let the work go
      return {};
    },
  });
  await g.run("fd", {});
  assert.deepEqual(seen, [2, 1, 0]);
});

test("every loop wire in live Tex's config names its own rounds, the send-back budget the Lab shows and edits", () => {
  const loops = TEX_CONFIG.edges.filter((e) => e.mode === "loop");
  assert.ok(loops.length > 0);
  for (const e of loops) assert.ok(Number.isInteger(e.rounds) && e.rounds > 0, `${e.from} -> ${e.to} has no rounds`);
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

// Sabotage record (run 2026-11-14, reverted): withLend() ignoring `lend` -> "lend reaches the callee's io.ctx" fails;
// `{ ...ctx, ...lend }` replaced by the caller's ctx mutated in place -> "lend does not leak" fails.
test("a lend given to uses or job reaches the callee's io.ctx for that one call only, never the caller's ctx, and is never logged", async () => {
  const config = {
    nodes: [node("caller", { kind: "input" }), node("callee"), node("bg")],
    edges: [wire("caller", "callee", "uses"), wire("caller", "bg", "job")],
  };
  const logs = [];
  const seen = [];
  const g = createGraph(
    config,
    {
      caller: async (input, io) => {
        const first = await io.use.callee({ q: 1 }, { lent: "yes" });
        const second = await io.use.callee({ q: 2 });
        const run = await io.job.bg({ q: 3 }, { lent: "job" });
        seen.push(["caller", io.ctx.lent ?? null]);
        return { first, second, job: run.output };
      },
      callee: async (input, io) => {
        seen.push([input.q, io.ctx.lent ?? null]);
        return { lent: io.ctx.lent ?? null };
      },
      bg: async (input, io) => (seen.push([input.q, io.ctx.lent ?? null]), { lent: io.ctx.lent ?? null }),
    },
    { log: (e) => logs.push(e) },
  );
  const { outputs } = await g.run("caller", { start: true }, { base: "kept" });
  assert.deepEqual(seen, [[1, "yes"], [2, null], [3, "job"], ["caller", null]]);
  assert.deepEqual(outputs.caller, { first: { lent: "yes" }, second: { lent: null }, job: { lent: "job" } });
  // The lend is not in any logged input: only the wires' own inputs are.
  assert.deepEqual(logs.map((l) => l.input), [{ q: 1 }, { q: 2 }, { q: 3 }, { start: true }]);
});

// Dev2, 2026-11-15: "3 nodes are actually logging as 0s which is obviously wrong ... not sure how this is slipping by".
// A node's logged time is its own: what it waited on the nodes it called (Answer checks sending a draft back to the
// front door, the front door calling a tool) is the callee's, logged by the callee, and never counted twice.
// Sabotage: `waited()` not wrapping io.back makes "own" equal "ms" and this fails on checks.
test("a node logs its whole run and its own time, less its waits on the nodes it called", async () => {
  let clock = 0;
  const config = {
    nodes: [node("fd"), node("tools"), node("checks"), node("send")],
    edges: [wire("fd", "tools", "uses"), wire("fd", "checks"), wire("checks", "send"), { ...wire("checks", "fd", "loop"), rounds: 2 }],
  };
  const runs = [];
  let backs = 0;
  const g = createGraph(
    config,
    {
      fd: async (_x, io) => {
        clock += 1000; // the model
        await Promise.all([io.use.tools({}), io.use.tools({})]); // two tools in flight together: 250 ms waited, once
        clock += 200;
        return {};
      },
      tools: async () => {
        const until = clock + 250;
        await null;
        clock = Math.max(clock, until);
        return {};
      },
      checks: async (_x, io) => {
        clock += 3; // its own code
        if (backs++ === 0) await io.back.fd({});
        return {};
      },
      send: async () => ((clock += 40), {}),
    },
    { log: (r) => runs.push(r), now: () => clock },
  );
  await g.run("fd", {});
  const of = (id) => runs.filter((r) => r.node === id).map((r) => [r.ms, r.own]);
  assert.deepEqual(of("tools"), [[250, 250], [250, 250], [250, 250], [250, 250]]);
  assert.deepEqual(of("fd"), [[1450, 1200], [1450, 1200]]);
  assert.deepEqual(of("checks"), [[1453, 3]]);
  assert.deepEqual(of("send"), [[40, 40]]);
});

// A provisional run (Dev2, 2026-11-17): the `provisional` wire is an intake signal, read through provisionalWiring, never
// fired by the runner. Sabotage: counting "provisional" in the cycle check, or firing it in run(), fails the first test;
// provisionalWiring ignoring `on`, or dropping `allow`, fails the second; the allow check removed fails the third.
const provisionalDraft = () => ({
  nodes: [node("text"), node("triage"), node("decide"), node("lanes"), node("door"), node("send")],
  edges: [
    wire("text", "triage"), wire("triage", "decide"), wire("decide", "lanes"), wire("door", "send"),
    wire("triage", "door", "provisional", ["stop:running"]),
    { ...wire("decide", "door", "provisional", ["stop:quiet", "restart:wait"]), allow: "read" },
    { ...wire("lanes", "door", "provisional"), allow: "revertible" },
  ],
});

test("a provisional wire is never fired by the runner and is no part of the cycle check", async () => {
  const config = provisionalDraft();
  assert.deepEqual(problemsOf(config), []);
  // door -> triage would close a cycle only if provisional wires counted; they do not.
  assert.deepEqual(problemsOf({ ...config, edges: [...config.edges, wire("door", "triage", "provisional")] }).filter((p) => /cycle/.test(p)), []);
  assert.ok(!orderFrom(config, "text").includes("door"));
  const ran = [];
  const impl = (id) => async () => (ran.push(id), {});
  const g = createGraph(config, Object.fromEntries(config.nodes.map((n) => [n.id, impl(n.id)])));
  await g.run("text", {});
  assert.deepEqual(ran, ["text", "triage", "decide", "lanes"]);
});

test("provisionalWiring names the step run provisionally, what stops or restarts it and what it may do before the go", () => {
  assert.deepEqual(provisionalWiring(provisionalDraft()), {
    on: true,
    target: "door",
    sources: [
      { from: "triage", stop: ["running"], restart: [], allow: "revertible", unless: [] },
      { from: "decide", stop: ["quiet"], restart: ["wait"], allow: "read", unless: [] },
      { from: "lanes", stop: [], restart: [], allow: "revertible", unless: [] },
    ],
  });
  const offTriage = provisionalDraft();
  offTriage.nodes.find((n) => n.id === "triage").on = false;
  assert.deepEqual(provisionalWiring(offTriage).sources.map((s) => s.from), ["decide", "lanes"]);
  const offDoor = provisionalDraft();
  offDoor.nodes.find((n) => n.id === "door").on = false;
  assert.deepEqual(provisionalWiring(offDoor), { on: false, target: null, sources: [] });
  assert.equal(provisionalWiring(TEX_CONFIG).on, TEX_CONFIG.edges.some((e) => e.mode === "provisional"));
});

test("a provisional wire takes only stop: and restart: tags and a known allow, and only one step may run provisionally", () => {
  const bad = provisionalDraft();
  bad.edges.push(wire("text", "door", "provisional", ["quiet"]));
  assert.match(problemsOf(bad).join(), /provisional wire text -> door has when "quiet"/);
  const two = provisionalDraft();
  two.edges.push(wire("text", "lanes", "provisional"));
  assert.match(problemsOf(two).join(), /more than one step/);
  const allow = provisionalDraft();
  allow.edges.push({ ...wire("text", "door", "provisional"), allow: "anything" });
  assert.match(problemsOf(allow).join(), /allow "anything"/);
  const onWait = provisionalDraft();
  onWait.edges[0] = { ...onWait.edges[0], allow: "read" };
  assert.match(problemsOf(onWait).join(), /only a provisional wire has one/);
  const badUnless = provisionalDraft();
  badUnless.edges.push({ ...wire("text", "door", "provisional"), unless: ["sideways"] });
  assert.match(problemsOf(badUnless).join(), /unless \["sideways"\]/);
});

test("provisionalHeld is the wires' unless, and one wire's fact holds the run", () => {
  assert.deepEqual(provisionalHeld(["firstLook", "sms", "unpaired"], ["group", "sms"]), ["sms"]);
  assert.deepEqual(provisionalHeld([], ["firstLook"]), []);
  assert.deepEqual(provisionalHeld(undefined, ["firstLook"]), []);
  const held = provisionalDraft();
  held.edges.find((e) => e.from === "decide" && e.mode === "provisional").unless = ["firstLook"];
  const wiring = provisionalWiring(held);
  assert.deepEqual(wiring.sources.find((s) => s.from === "decide").unless, ["firstLook"]);
  assert.deepEqual(provisionalHeld(wiring.sources.flatMap((s) => s.unless), ["firstLook"]), ["firstLook"]);
  assert.deepEqual(provisionalHeld(wiring.sources.flatMap((s) => s.unless), ["sms"]), []);
});

// A generator wire (Dev2, 2026-11-16, the generators model): it starts a new run at an input node, so the runner never
// fires it, orderFrom never reaches through it, and it may point back up the graph. Sabotage: counting "generator" in the
// cycle check fails the first test; dropping the input-node check fails the second.
const generatorDraft = () => ({
  nodes: [node("text", { kind: "input" }), node("fd"), node("gate"), node("ask", { kind: "input" }), node("answer"), node("send")],
  edges: [
    wire("text", "fd"), wire("fd", "send"), wire("fd", "gate", "uses"), wire("ask", "answer"),
    wire("gate", "ask", "generator", ["ask"]),
    wire("answer", "ask", "generator", ["answer"]),
    wire("send", "text", "generator", ["answer"]),
  ],
});

test("a generator wire is never fired by the runner, never in a run's order, and no part of the cycle check", async () => {
  const config = generatorDraft();
  assert.deepEqual(problemsOf(config), []);
  assert.ok(!orderFrom(config, "text").includes("ask"));
  const ran = [];
  const impl = (id) => async () => (ran.push(id), { when: ["ask", "answer"] });
  const g = createGraph(config, Object.fromEntries(config.nodes.map((n) => [n.id, impl(n.id)])));
  await g.run("text", {});
  assert.deepEqual(ran, ["text", "fd", "send"]);
});

test("a generator wire starts a run only at an input node", () => {
  const bad = generatorDraft();
  bad.edges.push(wire("fd", "answer", "generator"));
  assert.match(problemsOf(bad).join(), /generator wire fd -> answer starts a run at "answer", which is not an input node/);
});
