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
 *   provisional  ("Provisional run") the target does not wait for the source to start: it starts once its other
 *           inputs allow, or at the run's start when every wire into it is `provisional`. The source's output is the
 *           target's verdict: tags matching the wire's `stop:<tag>` entries stop the running target, `restart:<tag>` stops
 *           and reruns it, and anything else says go. Until every `provisional` source into it has said go, the target
 *           may do only what the wire's `allow` lets it: "read" (reads only) or "revertible" (the default: reads, and writes
 *           that can be undone); anything that cannot be taken back always waits for the go. `unless` names the bursts
 *           that do not start it early (`firstLook`, `sms`, `unpaired`; `provisionalHeld`): any one of them on any
 *           provisional wire holds the run, and the step waits for those sources instead. The config check requires
 *           `firstLook` and `sms` on every provisional wire (`texConfigSchema.cjs`); this runner still reads a wire
 *           as written. One target per config; read
 *           by intake through `provisionalWiring`, never fired by `run` (Dev2, 2026-11-17).
 *   generator  ("Starts a new run") the source starts a new run of its own that begins at the target, an input node
 *           (`kind: "input"`), in this chat or another; nothing in the current run waits for it. A background job, a
 *           routine, an ask sent to another chat: each output re-enters Tex as a new input (Dev2, 2026-11-16, the
 *           generators model). `when` tags work as on `wait` ("ask", "answer"). Never fired by `run`, never part of
 *           `orderFrom`, and ignored by the cycle check, so a generator may point back up the graph. A node starts one
 *           through `io.start[target]`, handed to the host's `start` option; the wire's `rounds` cap the chain.
 * A `wait` or `background` wire whose `when` names "failed" catches its source's failure: the source's output is then
 * `{ when: ["failed"], failed: { name, message } }` and the run goes on down that wire instead of throwing.
 * `run`'s `progress` option (`{ get(nodeId), put(nodeId, output) }`, the host's durable store for one run) skips every
 * node it already holds an output for and keeps each new one, so a run resumed after a crash or deploy picks up there.
 * `when` on a wire: `["*"]`, or tags the source's output must carry (`output.when`, or `output.to` as one tag) for a
 * `wait` or `background` wire to fire. A node that is off (`on: false`) never runs, and its wires never fire.
 *
 * A node's `inSchema` and `outSchema` are its contract, checked strictly (Dev2, 2026-11-14: "fail"): every field named
 * must be there with its type unless marked `optional`, and no field may be there that is not named (but `when`, the
 * output's routing tags, and `log`, the node's own detail for its row: both logged, neither carried on). A mismatch fails the node with a `GraphError` naming the field. Types: text, yesno, score
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

// The wire modes and a provisional run's allows (reads only, or reads and writes that can be undone, the default) are
// the schema's (`texConfigSchema.cjs`).
const { MODES, ALLOW, START_FACTS } = require("./texConfigSchema.cjs");
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
 * input schema never names it, so a tagged output fed on as it is would fail the node it feeds), and without its `log`,
 * the node's own detail, kept in its row only (the Door's parts handed to the Front door failed it, 2026-11-16).
 */
function carried(output) {
  if (!plain(output) || !("when" in output || "log" in output)) return output;
  const { when, log, ...rest } = output;
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
  for (const k of Object.keys(value)) if (!named.has(k) && !(which === "output" && (k === "when" || k === "log")) && value[k] !== undefined) throw new GraphError(`"${id}" ${which} has "${k}", which its schema does not name`);
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
    if (e.mode === "provisional") for (const t of Array.isArray(e.when) ? e.when : [])
      if (t !== "*" && !/^(stop|restart):[\w-]+$/.test(String(t))) problems.push(`provisional wire ${e.from} -> ${e.to} has when "${t}": only "*", "stop:<tag>" or "restart:<tag>"`);
    if (e.allow !== undefined && !(e.mode === "provisional" && ALLOW.includes(e.allow)))
      problems.push(`wire ${e.from} -> ${e.to} has allow "${e.allow}": only a provisional wire has one, "read" or "revertible"`);
    if (e.unless !== undefined && !(e.mode === "provisional" && Array.isArray(e.unless) && e.unless.every((fact) => START_FACTS.includes(fact))))
      problems.push(`wire ${e.from} -> ${e.to} has unless ${JSON.stringify(e.unless)}: only a provisional wire has one, a list of ${START_FACTS.join(", ")}`);
  }
  // A generator starts a new run, so it can only start one where runs start: an input node.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of config?.edges ?? []) if (e.mode === "generator" && byId.has(e.to) && byId.get(e.to).kind !== "input")
    problems.push(`generator wire ${e.from} -> ${e.to} starts a run at "${e.to}", which is not an input node`);
  const provisionalTargets = new Set((config?.edges ?? []).filter((e) => e.mode === "provisional").map((e) => e.to));
  if (provisionalTargets.size > 1) problems.push(`provisional wires point at more than one step (${[...provisionalTargets].join(", ")}): one step may run provisionally`);
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
 * How a config runs a step provisionally (Dev2, 2026-11-17): the target of its `provisional` wires and, for each wire
 * whose two ends are on, its source, the tags that stop or restart the target (`when` entries "stop:<tag>",
 * "restart:<tag>"; any other output is go), what the target may do before the go (`allow`, "revertible" when the
 * wire names none) and which bursts do not start it early (`unless`; empty when the wire names none). `on` is false
 * with no such wire. Read by intake; the runner never fires these wires.
 */
function provisionalWiring(config) {
  const isOn = (id) => {
    const n = (config?.nodes ?? []).find((x) => x.id === id);
    return !!n && n.on !== false;
  };
  const wires = (Array.isArray(config?.edges) ? config.edges : []).filter((e) => e.mode === "provisional" && isOn(e.from) && isOn(e.to));
  if (!wires.length) return { on: false, target: null, sources: [] };
  const target = wires[0].to;
  const tags = (e, kind) => (Array.isArray(e.when) ? e.when : []).filter((t) => typeof t === "string" && t.startsWith(`${kind}:`)).map((t) => t.slice(kind.length + 1));
  const unlessOf = (e) => (Array.isArray(e.unless) ? e.unless.filter((fact) => typeof fact === "string") : []);
  const sources = wires.filter((e) => e.to === target).map((e) => ({ from: e.from, stop: tags(e, "stop"), restart: tags(e, "restart"), allow: e.allow === "read" ? "read" : "revertible", unless: unlessOf(e) }));
  return { on: true, target, sources };
}

/**
 * Which of `facts` hold a provisional run back (`unless` on its wires, the union: one wire that names a fact holds
 * every wire). Empty when the run starts. The texting Worker and the Lab both call this, so a burst the config holds
 * is held in both (Dev2, 2026-11-17: the gate is the wire's, not code's).
 */
function provisionalHeld(unless, facts) {
  const block = new Set(Array.isArray(unless) ? unless : []);
  return (Array.isArray(facts) ? facts : []).filter((fact) => typeof fact === "string" && block.has(fact));
}

/**
 * The runner for one config and one process's nodes.
 *
 *   impls       { [nodeId]: async (input, io) => output }: the nodes this process runs.
 *   log         ({ node, input, output, ms, own, ok, error, at, via }) => void: every node run (`ms` from start to end,
 *               `own` less its waits on the nodes it called); never awaited, never throws out.
 *   background  (promise) => void: where a `background` wire's run goes (a Worker's `waitUntil`); awaited when absent.
 *   handOff     (nodeId, input, ctx) => Promise: a node this process does not run (the gateway's, seen from the Worker);
 *               its result ends this process's part of the run. Without it, such a node throws.
 *   now         () => number.
 *   onStart     ({ node, id, parent, at, via, input }) => void: each node run as it starts, before its code runs (the
 *               Lab's test chat shows running steps); never awaited, never throws out.
 *   count       (nodeId, output) => number | null: how many items a node handed on, counted from its whole output
 *               before the log cuts a long one, and kept on its entry as `count` (search's notes per step, Dev2
 *               2026-11-21). Never throws out; a non-number is left off.
 *   concurrent  true: a node starts as soon as every node that may feed it has finished, so two steps fed by the same
 *               one run side by side (search's word and meaning nominators, Dev2 2026-11-21). False (Tex's runs): one
 *               node at a time, in order. What runs, and on what input, is the same either way.
 *
 * Every run has an `id`, unique in this isolate, and the `parent` run that started it, recorded as it runs: the caller
 * for a `uses`, `loop` or `job` handle, the node whose fired wire fed it on a `wait` or `background` path, none for the
 * start. Both are on the log entry, so a run's cause is read from what ran, never inferred from times.
 */
let runSeq = 0;
/** A run id, unique in the isolate: every log entry gets its own, so a parent always names an entry that was kept. */
const nextRunId = () => ((runSeq = (runSeq + 1) % Number.MAX_SAFE_INTEGER), `r${runSeq}`);
function createGraph(config, impls, { log = () => {}, background = null, handOff = null, now = Date.now, onStart = null, start = null, concurrent = false, count = null } = {}) {
  const problems = problemsOf(config);
  if (problems.length) throw new GraphError(problems.join("; "));
  const byId = new Map(config.nodes.map((n) => [n.id, n]));
  const out = (id, mode) => config.edges.filter((e) => e.from === id && e.mode === mode);

  const counted = (id, output) => {
    if (!count) return {};
    try {
      const n = count(id, output);
      return typeof n === "number" && Number.isFinite(n) ? { count: n } : {};
    } catch {
      return {};
    }
  };
  const keep = (entry) => {
    try {
      const r = log(entry);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* a log never stops a run */
    }
  };

  const started = (entry) => {
    if (typeof onStart !== "function") return;
    try {
      onStart(entry);
    } catch {
      /* a watcher never stops a run */
    }
  };

  /** Run one node: its handles, its timing, its log. `parent` is the run that started it. */
  async function runNode(id, input, ctx, via, parent) {
    const node = byId.get(id);
    if (!node) throw new GraphError(`no node "${id}"`);
    if (node.on === false) return { ran: false };
    const impl = impls[id];
    const at = now();
    const self = nextRunId();
    const ids = { id: self, ...(typeof parent === "string" ? { parent } : {}) };
    // Shaped only for a watcher: a real turn sets none, and shaping costs a serialisation of the whole input.
    if (typeof onStart === "function") started({ node: id, ...ids, at, via, input: shaped(input) });
    if (typeof impl !== "function") {
      if (handOff) {
        const output = await handOff(id, input, ctx);
        keep({ node: id, input: shaped(input), output: shaped(output), ms: now() - at, own: now() - at, ok: true, at, via, handedOff: true, ...ids });
        return { ran: true, output, handedOff: true, id: self };
      }
      throw new GraphError(`node "${id}" has no code in this process`);
    }
    let backs = 0;
    // The node's own time is its run less the time it waited on other nodes it called (`use`, `back`; a `job`
    // runs beside it), counted once however many were in flight, so a node that hands work on never shows that work as its own.
    let inFlight = 0;
    let since = 0;
    let nested = 0;
    const waited = async (work) => {
      if (inFlight++ === 0) since = now();
      try {
        return await work();
      } finally {
        if (--inFlight === 0) nested += now() - since;
      }
    };
    const timing = () => {
      const ms = now() - at;
      return { ms, own: Math.max(0, ms - nested - (inFlight > 0 ? now() - since : 0)) };
    };
    const handles = (mode, run) => Object.fromEntries(out(id, mode).map((e) => [e.to, run(e.to, e)]));
    // `lend` (the second argument of `use` and `job`) is extra ctx for that one call: the callee's io.ctx gets it, and
    // this node's ctx does not. It is never part of the input, so it is never logged.
    const withLend = (lend) => (lend ? { ...ctx, ...lend } : ctx);
    const io = {
      node,
      ctx,
      // Whether a node this one may reach is on: a caller that would wait on other work before calling an off node
      // (the Door waits on the Shape gate before the router) asks first, so an off node never holds anything up.
      on: (to) => byId.get(to)?.on !== false,
      use: handles("uses", (to) => async (arg, lend) => waited(async () => (await runNode(to, arg, withLend(lend), `${id}:uses`, self)).output)),
      // A send-back spends one of the wire's rounds; a `release` (the caller letting the work go on unchanged, the
      // answer check's "let it go") spends none, so a spent budget can always hand the work back. `left()` says how
      // many sends remain: a node that sees 0 lets the work go instead of sending it back (Dev2, 2026-11-17: a part
      // whose third notice crashed the turn threw its finished answer away ten times). Sending past the budget is
      // still refused, as a bug in the node.
      back: handles("loop", (to, wire) => {
        const most = [wire.rounds, byId.get(to)?.rounds].find((r) => Number.isInteger(r) && r > 0) ?? 1;
        const send = async (arg, how) => {
          if (how?.release !== true) {
            if (backs >= most) throw new GraphError(`"${id}" sent work back to "${to}" more than ${most} times`);
            backs += 1;
          }
          return waited(() => sendBack(to, id, arg, ctx, self));
        };
        send.left = () => Math.max(0, most - backs);
        return send;
      }),
      job: handles("job", (to) => (arg, lend) => {
        const run = runNode(to, arg, withLend(lend), `${id}:job`, self);
        if (background) background(run.catch(() => {}));
        return run;
      }),
      // A generator wire starts a new run at its target, through the host's `start` (it persists and schedules it: a
      // job's next part, an ask to another chat). The wire's rounds cap the chain: `ctx.generation` counts the runs
      // before this one, and a start past the cap is answered `{ started: false, why: "spent" }`, never thrown, so the
      // node can end the chain itself (Dev2, 2026-11-17, jobs as config).
      start: handles("generator", (to, wire) => async (arg) => {
        const generation = Number.isInteger(ctx?.generation) ? ctx.generation : 0;
        if (Number.isInteger(wire.rounds) && wire.rounds > 0 && generation + 1 >= wire.rounds) return { started: false, why: "spent" };
        if (typeof start !== "function") throw new GraphError(`"${id}" starts a run at "${to}", and this process has no start`);
        if (!fires(wire, arg)) return { started: false, why: "when" };
        keep({ node: to, input: shaped(arg), output: null, ms: 0, own: 0, ok: true, at: now(), via: `${id}:generator`, started: true, id: nextRunId(), parent: self });
        const result = await start(to, carried(arg), { from: id, generation: generation + 1, parent: self });
        return { started: true, ...(plain(result) ? result : {}) };
      }),
    };
    // A handle to a node with no wire here is refused, not undefined, so a mistake fails loudly.
    for (const kind of ["use", "back", "job", "start"]) {
      io[kind] = new Proxy(io[kind], {
        get(target, key) {
          if (typeof key !== "string" || key in target || key === "then" || key === "toJSON") return target[key];
          throw new GraphError(`"${id}" has no ${{ use: "uses", back: "loop", job: "job", start: "generator" }[kind]} wire to "${key}"`);
        },
      });
    }
    try {
      checkShape(id, "input", input, node.inSchema);
      const output = await impl(input, io);
      checkShape(id, "output", output, node.outSchema);
      keep({ node: id, input: shaped(input), output: shaped(output), ...counted(id, output), ...timing(), ok: true, at, via, ...ids });
      return { ran: true, output, id: self };
    } catch (error) {
      keep({ node: id, input: shaped(input), output: null, ...timing(), ok: false, error: error?.name === "GraphError" ? error.message : String(error?.name ?? "error"), at, via, ...ids });
      // The failed run's id rides on the error, so a `failed` wire's target names the entry that failed as its parent.
      if (error && typeof error === "object" && !("runId" in error)) {
        try {
          Object.defineProperty(error, "runId", { value: self, enumerable: false });
        } catch {
          /* a frozen error keeps no id; its catcher falls back */
        }
      }
      throw error;
    }
  }

  /**
   * Work sent back over a loop wire: the target runs, then every node on the `wait` path from it forward to the caller
   * (each once, fed as in `run`), so a rewritten draft passes the same steps it passed the first time; returns the
   * output of the last of them, the one that feeds the caller. Every run on the path is logged as via "caller:loop".
   */
  async function sendBack(to, caller, arg, ctx, parent) {
    const wait = config.edges.filter((e) => e.mode === "wait");
    const reaches = new Set([caller]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of wait) if (reaches.has(e.to) && !reaches.has(e.from)) (reaches.add(e.from), (grew = true));
    }
    const path = orderFrom({ ...config, edges: wait }, to).filter((n) => n !== caller && (n === to || reaches.has(n)));
    const fed = new Map([[to, [arg]]]);
    // The run whose fired wire fed each node last: its parent. The target's is the caller that sent the work back.
    const fedBy = new Map([[to, parent]]);
    let last;
    for (const n of path) {
      const feeds = fed.get(n);
      if (!feeds) continue;
      const given = feeds.length === 1 ? feeds[0] : Object.assign({}, ...feeds.filter(plain));
      const r = await runNode(n, given, ctx, `${caller}:loop`, fedBy.get(n));
      if (!r.ran) continue;
      last = r.output;
      for (const e of wait) if (e.from === n && e.to !== caller && path.includes(e.to) && fires(e, r.output)) (fed.set(e.to, [...(fed.get(e.to) ?? []), carried(r.output)]), fedBy.set(e.to, r.id));
    }
    return last;
  }

  /**
   * Run from an input node: it, then every node its fired `wait` wires reach, each once, after all that feed it; a
   * fired `background` wire's target runs in the background. Returns `{ outputs, ran }`: each node's output by id, in run
   * order.
   */
  async function run(begin, input, ctx = {}, { stopAt = [], progress = null } = {}) {
    const start = begin;
    const stops = new Set(stopAt);
    if (!byId.has(start)) throw new GraphError(`no node "${start}"`);
    const order = orderFrom(config, start);
    const outputs = {};
    const ran = [];
    const fed = new Map([[start, [input]]]);
    // The run whose fired wire fed each node last: its parent (`runNode`). The start has none.
    const fedBy = new Map();
    const later = new Map();
    const step = async (id) => {
      const feeds = fed.get(id);
      if (!feeds) return; // nothing fired into it
      // Merged in wire order; a lone input is passed as it is.
      const given = feeds.length === 1 ? feeds[0] : Object.assign({}, ...feeds.filter(plain));
      if (later.get(id)) {
        const run = runNode(id, given, ctx, "background", fedBy.get(id)).catch(() => {});
        if (background) background(run);
        else await run;
        return;
      }
      // A node a durable run already finished (`progress`, the host's store for this run: a job part resumed after a
      // crash or a deploy) is not run again: its kept output feeds on as it did (Dev2, 2026-11-17, jobs as config).
      const kept = progress ? await progress.get(id) : undefined;
      let r;
      if (kept !== undefined) {
        const resumedId = nextRunId();
        keep({ node: id, input: shaped(given), output: shaped(kept), ms: 0, own: 0, ok: true, at: now(), via: "resumed", resumed: true, id: resumedId, ...(fedBy.get(id) ? { parent: fedBy.get(id) } : {}) });
        r = { ran: true, output: kept, id: resumedId };
      } else {
        try {
          r = await runNode(id, given, ctx, "wait", fedBy.get(id));
        } catch (error) {
          // A node that fails is an output when a wire from it says what happens then (`when: ["failed"]`): the run goes
          // on down that wire with what failed, never thrown away. With no such wire it throws, as before.
          const caught = [...out(id, "wait"), ...out(id, "background")].some((e) => Array.isArray(e.when) && e.when.includes("failed"));
          if (!caught) throw error;
          r = { ran: true, output: { when: ["failed"], failed: { name: String(error?.name ?? "Error"), message: String(error?.message ?? "").slice(0, 300) } }, id: error?.runId };
        }
        if (r.ran && progress && !r.output?.failed) await progress.put(id, r.output);
      }
      if (!r.ran) return;
      outputs[id] = r.output;
      ran.push(id);
      if (r.handedOff || stops.has(id)) return;
      for (const e of out(id, "wait")) if (fires(e, r.output)) (fed.set(e.to, [...(fed.get(e.to) ?? []), carried(r.output)]), fedBy.set(e.to, r.id));
      for (const e of out(id, "background")) if (fires(e, r.output)) {
        fed.set(e.to, [...(fed.get(e.to) ?? []), carried(r.output)]);
        fedBy.set(e.to, r.id);
        later.set(e.to, true);
      }
    };
    if (!concurrent) {
      for (const id of order) await step(id);
    } else {
      // Each node waits for every node in this run that has a wire into it, then runs (or finds nothing fed it).
      const flow = config.edges.filter((e) => e.mode === "wait" || e.mode === "background");
      const done = new Map();
      for (const id of order) {
        const before = [...new Set(flow.filter((e) => e.to === id && done.has(e.from)).map((e) => e.from))].map((from) => done.get(from));
        done.set(id, Promise.all(before).then(() => step(id)));
      }
      await Promise.all(done.values());
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

  /** Whether the config has a `from` -> `to` wire, so code that may fire either of two wires picks the one drawn. */
  const wired = (from, to) => config.edges.some((e) => e.from === from && e.to === to);

  return { run, runNode, fire, wired, order: (start) => orderFrom(config, start) };
}

/**
 * What the code must match: every node has code in exactly one of the processes named (`{ gateway: [...ids], worker:
 * [...ids] }`), and no process has code for a node the config does not have, unless that node is on the shelf
 * (`texNodeShelf.json`: merged, not wired, never run; Dev2, 2026-11-16). A shelf node the config has is promoted and
 * comes off the shelf; one with no code is a stale entry. Returns problems, empty when it matches.
 */
function coverageProblems(config, processes, shelf = []) {
  const problems = [];
  const ids = new Set(config.nodes.map((n) => n.id));
  const shelved = new Set(shelf);
  const where = new Map();
  for (const id of shelved) if (ids.has(id)) problems.push(`"${id}" is in the config now: take it off the shelf (texNodeShelf.json)`);
  for (const [name, list] of Object.entries(processes)) {
    for (const id of list) {
      if (!ids.has(id) && !shelved.has(id)) problems.push(`${name} has code for "${id}", which the config has no node for (a node merged before it is wired goes on the shelf, texNodeShelf.json)`);
      if (where.has(id)) problems.push(`"${id}" has code in both ${where.get(id)} and ${name}`);
      where.set(id, name);
    }
  }
  for (const id of ids) if (!where.has(id)) problems.push(`node "${id}" has no code in any process`);
  for (const id of shelved) if (!ids.has(id) && !where.has(id)) problems.push(`shelf node "${id}" has no code in any process: take it off the shelf`);
  return problems;
}

module.exports = { MODES, GraphError, createGraph, problemsOf, coverageProblems, checkShape, fires, tagsOf, shaped, orderFrom, provisionalWiring, provisionalHeld, ALLOW, START_FACTS };
