/**
 * TEX RUNS ITS CONFIG'S GRAPH (Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the connections
 * between node to be code. They should be predefined").
 *
 * `texConfig.json` names every step (a node) and every wire between them (an edge). This file is the one interpreter of
 * the wires, shared by the gateway (where every node runs, Dev2 2026-11-14) and the Lab, so what runs, in what order, what waits for what and
 * what runs in the background is read from the config and never written as code. A node is code: one function, given its input
 * and a handle to only the nodes its wires reach, that returns its output.
 *
 * Wires, by `mode`:
 *   wait    the target runs after the source, given its output. A target several wires feed runs once, after every
 *           source that will feed it has run, on their outputs merged in wire order.
 *   background  the target runs after the source and nothing waits for it (the `background` option).
 *   uses    the source may call the target, through `io.use[target]`, any number of times. A node can call only what
 *           its `uses` wires reach: anything else throws.
 *   loop    the source may send work back to the target, through `io.back[target]`, at most the wire's `rounds` times
 *           (the target's `rounds` when the wire names none). The target runs, then the `wait` path from it forward
 *           to the source, and the call returns what the last node before the source gave.
 *   job     the source may start the target as a background job, through `io.job[target]`.
 * `when` on a wire: `["*"]`, or tags the source's output must carry (`output.when`, or `output.to` as one tag) for a
 * `wait` or `background` wire to fire. A node that is off (`on: false`) never runs, and its wires never fire.
 *
 * A node's `inSchema` and `outSchema` are its contract, checked strictly (Dev2, 2026-11-14: "fail"): every field named
 * must be there with its type unless marked `optional`, and no field may be there that is not named (but `when`, the
 * output's routing tags). A mismatch fails the node with a `GraphError` naming the field. Types: text, yesno, score
 * (a number, in its `options` range "a-b" when given), number, choice (a string; one of its `options` when they are a
 * list "a, b, c" of single words), ids (a list of strings), list, object, any.
 *
 * Every node run is logged by the runner (`log`): the node, its input and output (functions and cycles dropped, long
 * values cut), how long it took, and whether it went. So no node logs by hand, and none can run unlogged.
 *
 * What every node shares (the store, the session, the turn so far) is `ctx`, never an input: inputs and outputs are the
 * data the wires carry, kept small enough to log.
 */
"use strict";

const MODES = Object.freeze(["wait", "background", "uses", "loop", "job"]);
const MAX_LOG_CHARS = 3_500;

class GraphError extends Error {
  constructor(message) {
    super(`texGraph: ${message}`);
    this.name = "GraphError";
  }
}

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The tags a node's output carries for its wires' `when`. */
function tagsOf(output) {
  if (!plain(output)) return [];
  const tags = Array.isArray(output.when) ? output.when.filter((t) => typeof t === "string") : [];
  if (typeof output.to === "string") tags.push(output.to);
  return tags;
}

/** Whether a wire fires on its source's output. */
function fires(edge, output) {
  const when = Array.isArray(edge.when) && edge.when.length ? edge.when : ["*"];
  if (when.includes("*")) return true;
  const tags = tagsOf(output);
  return when.some((t) => tags.includes(t));
}

/** A value as the log keeps it: the fields its shape names (all, with none named), functions and cycles dropped, long ones cut. */
function shaped(value, schema) {
  let v = value;
  if (plain(value) && Array.isArray(schema) && schema.length) {
    v = {};
    for (const f of schema) if (f && typeof f.name === "string" && value[f.name] !== undefined) v[f.name] = value[f.name];
  }
  const seen = new WeakSet();
  let text;
  try {
    text = JSON.stringify(v, (_k, x) => {
      if (typeof x === "function" || typeof x === "symbol" || typeof x === "bigint") return undefined;
      if (x !== null && typeof x === "object") {
        if (seen.has(x)) return undefined;
        seen.add(x);
      }
      return x;
    });
  } catch {
    return { unloggable: true };
  }
  if (text === undefined) return null;
  return text.length > MAX_LOG_CHARS ? { cut: text.length, start: text.slice(0, 600) } : JSON.parse(text);
}

const WORD_LIST = /^[\w-]+(?:\s*,\s*[\w-]+)+$/;

/** Why a value does not match a field's type, or null when it does. */
function typeProblem(v, field) {
  const t = field.type ?? "any";
  const opts = typeof field.options === "string" ? field.options.trim() : "";
  switch (t) {
    case "any":
      return null;
    case "text":
      return typeof v === "string" ? null : "is not text";
    case "yesno":
      return typeof v === "boolean" ? null : "is not yes or no";
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? null : "is not a number";
    case "score": {
      if (!(typeof v === "number" && Number.isFinite(v))) return "is not a score";
      const range = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/.exec(opts);
      return range && (v < Number(range[1]) || v > Number(range[2])) ? `is ${v}, outside ${opts}` : null;
    }
    case "choice": {
      if (typeof v !== "string") return "is not one of its choices";
      if (!WORD_LIST.test(opts)) return null;
      const allowed = opts.split(",").map((o) => o.trim());
      return allowed.includes(v) ? null : `is "${v}", not one of ${allowed.join(", ")}`;
    }
    case "ids":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? null : "is not a list of ids";
    case "list":
      return Array.isArray(v) ? null : "is not a list";
    case "object":
      return plain(v) ? null : "is not an object";
    default:
      return `has a type the runner does not know ("${t}")`;
  }
}

/**
 * What a wire hands on: the output without its `when`, which picked the wires and is not the next node's input (a node's
 * input schema never names it, so a tagged output fed on as it is would fail the node it feeds).
 */
function carried(output) {
  if (!plain(output) || !("when" in output)) return output;
  const { when, ...rest } = output;
  return rest;
}

/**
 * Check a node's input or output against its schema (`which`: "input" or "output"). Throws a `GraphError` naming the
 * node and the field; a node with no schema for it is not checked.
 */
function checkShape(id, which, value, schema) {
  if (!Array.isArray(schema) || schema.length === 0) return;
  if (!plain(value)) throw new GraphError(`"${id}" ${which} is not an object with the fields its schema names`);
  const named = new Set(schema.map((f) => f.name));
  for (const f of schema) {
    if (value[f.name] === undefined || value[f.name] === null) {
      if (f.optional === true) continue;
      throw new GraphError(`"${id}" ${which} has no "${f.name}"`);
    }
    const why = typeProblem(value[f.name], f);
    if (why) throw new GraphError(`"${id}" ${which} "${f.name}" ${why}`);
  }
  for (const k of Object.keys(value)) if (!named.has(k) && !(which === "output" && k === "when") && value[k] !== undefined) throw new GraphError(`"${id}" ${which} has "${k}", which its schema does not name`);
}

/**
 * Check a config's graph: every wire joins two nodes and has a known mode, and the `wait` wires have no cycle (a turn
 * always ends). Returns the list of problems, empty when it is sound.
 */
function problemsOf(config) {
  const problems = [];
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) problems.push("node ids are not unique");
  for (const e of config?.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to)) problems.push(`wire ${e.from} -> ${e.to} joins a node that is not there`);
    if (!MODES.includes(e.mode)) problems.push(`wire ${e.from} -> ${e.to} has mode "${e.mode}"`);
  }
  // Kahn over wait and background wires.
  const flow = (config?.edges ?? []).filter((e) => e.mode === "wait" || e.mode === "background");
  const indeg = new Map([...ids].map((id) => [id, 0]));
  for (const e of flow) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const ready = [...ids].filter((id) => indeg.get(id) === 0);
  let done = 0;
  while (ready.length) {
    const id = ready.pop();
    done += 1;
    for (const e of flow) if (e.from === id) {
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) ready.push(e.to);
    }
  }
  if (done !== ids.size) problems.push("the wait and background wires go round in a cycle");
  return problems;
}

/** Every node a run from `start` could reach over `wait` and `background` wires, in an order where each comes after all that feed it. */
function orderFrom(config, start) {
  const flow = config.edges.filter((e) => e.mode === "wait" || e.mode === "background");
  const reach = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    for (const e of flow) if (e.from === id && !reach.has(e.to)) {
      reach.add(e.to);
      stack.push(e.to);
    }
  }
  const order = [];
  const placed = new Set();
  const visit = (id) => {
    if (placed.has(id)) return;
    placed.add(id);
    for (const e of flow) if (e.to === id && reach.has(e.from)) visit(e.from);
    order.push(id);
  };
  for (const id of reach) visit(id);
  return order;
}

/**
 * The runner for one config and one process's nodes.
 *
 *   impls       { [nodeId]: async (input, io) => output }: the nodes this process runs.
 *   log         ({ node, input, output, ms, ok, error, at, via }) => void: every node run; never awaited, never throws out.
 *   background  (promise) => void: where a `background` wire's run goes (a Worker's `waitUntil`); awaited when absent.
 *   handOff     (nodeId, input, ctx) => Promise: a node this process does not run (the gateway's, seen from the Worker);
 *               its result ends this process's part of the run. Without it, such a node throws.
 *   now         () => number.
 */
function createGraph(config, impls, { log = () => {}, background = null, handOff = null, now = Date.now } = {}) {
  const problems = problemsOf(config);
  if (problems.length) throw new GraphError(problems.join("; "));
  const byId = new Map(config.nodes.map((n) => [n.id, n]));
  const out = (id, mode) => config.edges.filter((e) => e.from === id && e.mode === mode);

  const keep = (entry) => {
    try {
      const r = log(entry);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* a log never stops a run */
    }
  };

  /** Run one node: its handles, its timing, its log. */
  async function runNode(id, input, ctx, via) {
    const node = byId.get(id);
    if (!node) throw new GraphError(`no node "${id}"`);
    if (node.on === false) return { ran: false };
    const impl = impls[id];
    const at = now();
    if (typeof impl !== "function") {
      if (handOff) {
        const output = await handOff(id, input, ctx);
        keep({ node: id, input: shaped(input), output: shaped(output), ms: now() - at, ok: true, at, via, handedOff: true });
        return { ran: true, output, handedOff: true };
      }
      throw new GraphError(`node "${id}" has no code in this process`);
    }
    let backs = 0;
    const handles = (mode, run) => Object.fromEntries(out(id, mode).map((e) => [e.to, run(e.to, e)]));
    const io = {
      node,
      ctx,
      use: handles("uses", (to) => async (arg) => (await runNode(to, arg, ctx, `${id}:uses`)).output),
      back: handles("loop", (to, wire) => async (arg) => {
        const most = [wire.rounds, byId.get(to)?.rounds].find((r) => Number.isInteger(r) && r > 0) ?? 1;
        if (backs >= most) throw new GraphError(`"${id}" sent work back to "${to}" more than ${most} times`);
        backs += 1;
        return sendBack(to, id, arg, ctx);
      }),
      job: handles("job", (to) => (arg) => {
        const run = runNode(to, arg, ctx, `${id}:job`);
        if (background) background(run.catch(() => {}));
        return run;
      }),
    };
    // A handle to a node with no wire here is refused, not undefined, so a mistake fails loudly.
    for (const kind of ["use", "back", "job"]) {
      io[kind] = new Proxy(io[kind], {
        get(target, key) {
          if (typeof key !== "string" || key in target || key === "then" || key === "toJSON") return target[key];
          throw new GraphError(`"${id}" has no ${kind === "use" ? "uses" : kind === "back" ? "loop" : "job"} wire to "${key}"`);
        },
      });
    }
    try {
      checkShape(id, "input", input, node.inSchema);
      const output = await impl(input, io);
      checkShape(id, "output", output, node.outSchema);
      keep({ node: id, input: shaped(input), output: shaped(output), ms: now() - at, ok: true, at, via });
      return { ran: true, output };
    } catch (error) {
      keep({ node: id, input: shaped(input), output: null, ms: now() - at, ok: false, error: error?.name === "GraphError" ? error.message : String(error?.name ?? "error"), at, via });
      throw error;
    }
  }

  /**
   * Work sent back over a loop wire: the target runs, then every node on the `wait` path from it forward to the caller
   * (each once, fed as in `run`), so a rewritten draft passes the same steps it passed the first time; returns the
   * output of the last of them, the one that feeds the caller. Every run on the path is logged as via "caller:loop".
   */
  async function sendBack(to, caller, arg, ctx) {
    const wait = config.edges.filter((e) => e.mode === "wait");
    const reaches = new Set([caller]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of wait) if (reaches.has(e.to) && !reaches.has(e.from)) (reaches.add(e.from), (grew = true));
    }
    const path = orderFrom({ ...config, edges: wait }, to).filter((n) => n !== caller && (n === to || reaches.has(n)));
    const fed = new Map([[to, [arg]]]);
    let last;
    for (const n of path) {
      const feeds = fed.get(n);
      if (!feeds) continue;
      const given = feeds.length === 1 ? feeds[0] : Object.assign({}, ...feeds.filter(plain));
      const r = await runNode(n, given, ctx, `${caller}:loop`);
      if (!r.ran) continue;
      last = r.output;
      for (const e of wait) if (e.from === n && e.to !== caller && path.includes(e.to) && fires(e, r.output)) fed.set(e.to, [...(fed.get(e.to) ?? []), carried(r.output)]);
    }
    return last;
  }

  /**
   * Run from an input node: it, then every node its fired `wait` wires reach, each once, after all that feed it; a
   * fired `background` wire's target runs in the background. Returns `{ outputs, ran }`: each node's output by id, in run
   * order.
   */
  async function run(start, input, ctx = {}, { stopAt = [] } = {}) {
    const stops = new Set(stopAt);
    if (!byId.has(start)) throw new GraphError(`no node "${start}"`);
    const order = orderFrom(config, start);
    const outputs = {};
    const ran = [];
    const fed = new Map([[start, [input]]]);
    const later = new Map();
    for (const id of order) {
      const feeds = fed.get(id);
      if (!feeds) continue; // nothing fired into it
      // Merged in wire order; a lone input is passed as it is.
      const given = feeds.length === 1 ? feeds[0] : Object.assign({}, ...feeds.filter(plain));
      if (later.get(id)) {
        const run = runNode(id, given, ctx, "background").catch(() => {});
        if (background) background(run);
        else await run;
        continue;
      }
      const r = await runNode(id, given, ctx, "wait");
      if (!r.ran) continue;
      outputs[id] = r.output;
      ran.push(id);
      if (r.handedOff || stops.has(id)) continue;
      for (const e of out(id, "wait")) if (fires(e, r.output)) fed.set(e.to, [...(fed.get(e.to) ?? []), carried(r.output)]);
      for (const e of out(id, "background")) if (fires(e, r.output)) {
        fed.set(e.to, [...(fed.get(e.to) ?? []), carried(r.output)]);
        later.set(e.to, true);
      }
    }
    return { outputs, ran };
  }

  /**
   * Run one node over one config wire, for code not yet on the runner (the migration's bridge): throws unless the
   * config has a `from` -> `to` wire; the caller keeps to its mode (awaits a `uses` or `wait`, hands a `background`
   * run to `waitUntil`). Returns the node's output.
   */
  async function fire(from, to, input, ctx = {}) {
    const wire = config.edges.find((e) => e.from === from && e.to === to);
    if (!wire) throw new GraphError(`the config has no wire from "${from}" to "${to}"`);
    return (await runNode(to, input, ctx, `${from}:${wire.mode}`)).output;
  }

  return { run, runNode, fire, order: (start) => orderFrom(config, start) };
}

/**
 * What the code must match: every node has code in exactly one of the processes named (`{ gateway: [...ids], worker:
 * [...ids] }`), and no process has code for a node the config does not have. Returns problems, empty when it matches.
 */
function coverageProblems(config, processes) {
  const problems = [];
  const ids = new Set(config.nodes.map((n) => n.id));
  const where = new Map();
  for (const [name, list] of Object.entries(processes)) {
    for (const id of list) {
      if (!ids.has(id)) problems.push(`${name} has code for "${id}", which the config has no node for`);
      if (where.has(id)) problems.push(`"${id}" has code in both ${where.get(id)} and ${name}`);
      where.set(id, name);
    }
  }
  for (const id of ids) if (!where.has(id)) problems.push(`node "${id}" has no code in any process`);
  return problems;
}

module.exports = { MODES, GraphError, createGraph, problemsOf, coverageProblems, checkShape, fires, tagsOf, shaped, orderFrom };
