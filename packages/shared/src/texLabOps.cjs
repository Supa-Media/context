/**
 * SMALL EDITS TO A TEX LAB DRAFT (Dev2, 2026-11-15: "you can edit the config, I can edit the config in the UI, the AI
 * can edit the config there, and then we're just collaborating"; design https://claude.ai/artifact/1nwVCYrrvYzRzJTGLYKGvk,
 * option 2A).
 *
 * A Lab draft is a saved Lab version: its graph is the Lab's own JSON (`{nodes, edges, folded?, modules?, models?,
 * convo?}`, `apps/mobile/features/tex/lab/types.ts`), unfolded. Both sides change it with the same small edits, so two
 * people (or a person and an AI over the MCP's `tex_dev` tool) can work on one draft at once:
 *
 *   { op: "set",    node, field, value }        one field of one step
 *   { op: "move",   node, x, y }                where a step sits on the canvas
 *   { op: "add",    node: {...} }               a new step (its id must be new)
 *   { op: "remove", node }                      a step, with every wire that touches it
 *   { op: "wire",   from, to, mode, when? }     a wire (one per from, to and mode; an existing one gets the new `when`)
 *   { op: "unwire", from, to, mode? }           a wire (every mode between the two when `mode` is left out)
 *   { op: "module", key, value }                one context module's edit (`graph.modules[key]`: words, size, cache); null drops it
 *   { op: "convo",  field, value }              one conversation setting (`graph.convo[field]`); null drops it
 *   { op: "put",    graph }                     the whole graph
 *
 * Each edit names the pieces it touches (`keysOf`). The control plane keeps which pieces every revision touched, and an
 * edit made against an older revision is refused only when a revision since then touched one of its pieces: two
 * edits to different fields both land, and the later of two edits to the same field is told the value it would have
 * overwritten (`functions/texLabDrafts.ts`). Nothing here reads a clock or a store: the Lab, the control plane and the
 * gateway run this same code.
 */

const MODES = ["wait", "uses", "background", "job", "loop"];
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
/** The fields a `set` may change: everything a step has but its id (which `remove` and `add` change). */
const NODE_FIELDS = new Set(["label", "goal", "log", "on", "rounds", "out", "ctx", "ms", "timeoutS", "areas", "file", "note", "icon", "model", "effort", "kind", "inSchema", "outSchema", "sendBack", "x", "y", "group"]);
/** At most this many edits in one batch. */
const MAX_OPS = 200;

class OpError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpError";
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const wireKey = (from, to, mode) => `e:${from}>${to}>${mode}`;
const show = (value) => (value === undefined ? "nothing" : typeof value === "string" ? value : JSON.stringify(value));
const short = (text, max = 60) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

function asGraph(graph) {
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new OpError("the graph has no steps and wires");
  return graph;
}

function needId(value, what) {
  if (typeof value !== "string" || !ID.test(value)) throw new OpError(`${what} is not a step id (${show(value)})`);
  return value;
}

/** The pieces one edit touches: `n:<id>:<field>` for a field, `n:<id>` for a whole step, a wire's key, `*` for all. */
function keysOf(op) {
  switch (op?.op) {
    case "set":
      return [`n:${op.node}:${op.field}`];
    case "move":
      return [`n:${op.node}:x`, `n:${op.node}:y`];
    case "add":
      return [`n:${op.node?.id}`];
    case "remove":
      return [`n:${op.node}`];
    case "wire":
      return [wireKey(op.from, op.to, op.mode)];
    case "unwire":
      return op.mode ? [wireKey(op.from, op.to, op.mode)] : [`e:${op.from}>${op.to}>*`];
    case "module":
      return [`m:${op.key}`];
    case "convo":
      return [`c:${op.field}`];
    case "put":
      return ["*"];
    default:
      return [];
  }
}

/** Do two touched pieces overlap? A whole step overlaps its fields, a wire with no mode every mode, `*` everything. */
function overlaps(a, b) {
  if (a === "*" || b === "*") return true;
  if (a === b) return true;
  const [short_, long_] = a.length <= b.length ? [a, b] : [b, a];
  if (short_.startsWith("n:") && long_.startsWith(short_ + ":")) return true;
  if (a.endsWith(">*") && b.startsWith(a.slice(0, -1))) return true;
  if (b.endsWith(">*") && a.startsWith(b.slice(0, -1))) return true;
  // A removed or added step touches every wire at it.
  const step = (k) => (/^n:[^:]+$/.test(k) ? k.slice(2) : null);
  const wireEnds = (k) => (k.startsWith("e:") ? k.slice(2).split(">").slice(0, 2) : null);
  for (const [s, w] of [[step(a), wireEnds(b)], [step(b), wireEnds(a)]]) if (s !== null && w !== null && w.includes(s)) return true;
  return false;
}

/** Which of `keys` overlap any of `touched`. */
function conflicts(keys, touched) {
  return keys.filter((k) => touched.some((t) => overlaps(k, t)));
}

/**
 * Apply a batch of edits to a graph. Answers `{ graph, keys, said }`: the new graph (the input is not changed), every
 * piece the batch touched, and one plain line per edit for the change list. Throws `OpError` naming the first edit
 * that cannot apply, and then nothing of the batch applies.
 */
function applyOps(graph, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpError("there are no edits");
  if (ops.length > MAX_OPS) throw new OpError(`at most ${MAX_OPS} edits at once`);
  let g = clone(asGraph(graph));
  const keys = [];
  const said = [];
  ops.forEach((op, i) => {
    const at = (message) => new OpError(`edit ${i + 1} (${show(op?.op)}): ${message}`);
    const find = (id) => g.nodes.find((n) => n.id === id);
    try {
      switch (op?.op) {
        case "set": {
          const n = find(needId(op.node, "node"));
          if (!n) throw at(`there is no step "${op.node}"`);
          if (!NODE_FIELDS.has(op.field)) throw at(`"${op.field}" is not a field a step has (${[...NODE_FIELDS].join(", ")})`);
          if (op.value === undefined) throw at("it has no value");
          const before = n[op.field];
          if (op.value === null) delete n[op.field];
          else n[op.field] = clone(op.value);
          said.push(`set ${n.id} ${op.field} ${short(show(before))} → ${short(show(op.value === null ? undefined : op.value))}`);
          break;
        }
        case "move": {
          const n = find(needId(op.node, "node"));
          if (!n) throw at(`there is no step "${op.node}"`);
          if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) throw at("x and y must be numbers");
          n.x = Math.round(op.x);
          n.y = Math.round(op.y);
          said.push(`moved ${n.id}`);
          break;
        }
        case "add": {
          const n = op.node;
          if (!n || typeof n !== "object" || Array.isArray(n)) throw at("it has no step");
          needId(n.id, "the new step's id");
          if (find(n.id)) throw at(`there is already a step "${n.id}"`);
          for (const k of Object.keys(n)) if (k !== "id" && !NODE_FIELDS.has(k)) throw at(`"${k}" is not a field a step has`);
          g.nodes.push({ label: n.id, goal: "", log: true, on: true, rounds: 1, out: 300, ctx: [], ms: 0, timeoutS: 0, areas: [], file: "", note: "", icon: "", model: "code", x: 0, y: 0, ...clone(n) });
          said.push(`added step ${n.id}`);
          break;
        }
        case "remove": {
          const id = needId(op.node, "node");
          if (!find(id)) throw at(`there is no step "${id}"`);
          g.nodes = g.nodes.filter((n) => n.id !== id);
          const wires = g.edges.length;
          g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
          said.push(`removed step ${id}` + (wires > g.edges.length ? ` and its ${wires - g.edges.length} wire${wires - g.edges.length === 1 ? "" : "s"}` : ""));
          break;
        }
        case "wire": {
          needId(op.from, "from");
          needId(op.to, "to");
          if (!find(op.from) || !find(op.to)) throw at(`a wire joins a step that is not there (${op.from} → ${op.to})`);
          if (!MODES.includes(op.mode)) throw at(`mode must be one of ${MODES.join(", ")}`);
          const when = op.when === undefined ? ["*"] : op.when;
          if (!Array.isArray(when) || !when.every((w) => typeof w === "string" && w.length > 0 && w.length <= 40)) throw at("when must be a list of tags");
          const had = g.edges.find((e) => e.from === op.from && e.to === op.to && e.mode === op.mode);
          if (had) had.when = [...when];
          else g.edges.push({ from: op.from, to: op.to, mode: op.mode, when: [...when] });
          said.push(`${had ? "rewired" : "wired"} ${op.from} → ${op.to} (${op.mode}${when.join(",") === "*" ? "" : ", when " + when.join(", ")})`);
          break;
        }
        case "unwire": {
          if (op.mode !== undefined && !MODES.includes(op.mode)) throw at(`mode must be one of ${MODES.join(", ")}`);
          const keep = g.edges.filter((e) => !(e.from === op.from && e.to === op.to && (op.mode === undefined || e.mode === op.mode)));
          if (keep.length === g.edges.length) throw at(`there is no wire ${op.from} → ${op.to}${op.mode ? " (" + op.mode + ")" : ""}`);
          g.edges = keep;
          said.push(`unwired ${op.from} → ${op.to}${op.mode ? " (" + op.mode + ")" : ""}`);
          break;
        }
        case "module": {
          if (typeof op.key !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(op.key)) throw at("key is not a module key");
          if (op.value !== null && (typeof op.value !== "object" || Array.isArray(op.value))) throw at("value must be the module's edit as an object, or null");
          g.modules = { ...(g.modules ?? {}) };
          if (op.value === null) delete g.modules[op.key];
          else g.modules[op.key] = clone(op.value);
          said.push(op.value === null ? `dropped the edit to module ${op.key}` : `edited module ${op.key}${typeof op.value.text === "string" ? " (its words)" : ""}`);
          break;
        }
        case "convo": {
          if (typeof op.field !== "string" || !/^[A-Za-z]{1,30}$/.test(op.field)) throw at("field is not a conversation setting");
          if (op.value === undefined) throw at("it has no value");
          g.convo = { ...(g.convo ?? {}) };
          const before = g.convo[op.field];
          if (op.value === null) delete g.convo[op.field];
          else g.convo[op.field] = clone(op.value);
          said.push(`set conversation ${op.field} ${short(show(before))} → ${short(show(op.value === null ? undefined : op.value))}`);
          break;
        }
        case "put": {
          g = clone(asGraph(op.graph));
          said.push("replaced the whole graph");
          break;
        }
        default:
          throw at("not an edit: use set, move, add, remove, wire, unwire, module, convo or put");
      }
    } catch (error) {
      if (error instanceof OpError && error.message.startsWith("edit ")) throw error;
      throw at(error instanceof Error ? error.message : String(error));
    }
    keys.push(...keysOf(op));
  });
  return { graph: g, keys: [...new Set(keys)], said };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The edits that turn graph `a` into graph `b`: what the Lab sends when a person changes a live draft. Steps and
 * wires become field edits; anything else the graph holds (`modules`, `models`, `convo`, `folded`) changing makes
 * the batch one `put`, since those have no smaller edit. Answers [] when nothing changed.
 */
function diffGraphs(a, b) {
  asGraph(a);
  asGraph(b);
  const rest = (g) => {
    const { nodes: _n, edges: _e, modules: _m, convo: _c, ...others } = g;
    return others;
  };
  if (!same(rest(a), rest(b))) return [{ op: "put", graph: clone(b) }];
  const ops = [];
  for (const [part, op, name] of [["modules", "module", "key"], ["convo", "convo", "field"]]) {
    const was = a[part] ?? {};
    const now = b[part] ?? {};
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (!same(was[k], now[k])) ops.push({ op, [name]: k, value: now[k] === undefined ? null : clone(now[k]) });
  }
  const before = new Map(a.nodes.map((n) => [n.id, n]));
  const after = new Map(b.nodes.map((n) => [n.id, n]));
  for (const id of before.keys()) if (!after.has(id)) ops.push({ op: "remove", node: id });
  for (const [id, n] of after) {
    const was = before.get(id);
    if (!was) {
      ops.push({ op: "add", node: clone(n) });
      continue;
    }
    if (was.x !== n.x || was.y !== n.y) ops.push({ op: "move", node: id, x: n.x, y: n.y });
    for (const field of new Set([...Object.keys(was), ...Object.keys(n)])) {
      if (field === "id" || field === "x" || field === "y") continue;
      if (!NODE_FIELDS.has(field)) return [{ op: "put", graph: clone(b) }];
      if (!same(was[field], n[field])) ops.push({ op: "set", node: id, field, value: n[field] === undefined ? null : clone(n[field]) });
    }
  }
  const key = (e) => `${e.from}>${e.to}>${e.mode}`;
  const wa = new Map(a.edges.map((e) => [key(e), e]));
  const wb = new Map(b.edges.map((e) => [key(e), e]));
  // A removed step's wires go with it.
  const gone = new Set(ops.filter((o) => o.op === "remove").map((o) => o.node));
  for (const [k, e] of wa) if (!wb.has(k) && !gone.has(e.from) && !gone.has(e.to)) ops.push({ op: "unwire", from: e.from, to: e.to, mode: e.mode });
  for (const [k, e] of wb) if (!wa.has(k) || !same(wa.get(k).when, e.when)) ops.push({ op: "wire", from: e.from, to: e.to, mode: e.mode, when: [...(e.when ?? ["*"])] });
  return ops;
}

module.exports = { MODES, NODE_FIELDS, MAX_OPS, OpError, applyOps, diffGraphs, keysOf, overlaps, conflicts };
