/**
 * SMALL EDITS TO A TEX LAB DRAFT (Dev2, 2026-11-15: "you can edit the config, I can edit the config in the UI, the AI
 * can edit the config there, and then we're just collaborating"; design https://claude.ai/artifact/1nwVCYrrvYzRzJTGLYKGvk,
 * option 2A).
 *
 * A Lab draft is a saved Lab version: its graph is the Lab's own JSON (`{nodes, edges, folded?, modules?, models?,
 * convo?}`, `packages/lab/app/types.ts`), unfolded. Both sides change it with the same small edits, so two
 * people (or a person and an AI over the MCP's `tex_dev` tool) can work on one draft at once:
 *
 *   { op: "set",    node, field, value }        one field of one step
 *   { op: "move",   node, x, y }                where a step sits on the canvas
 *   { op: "add",    node: {...} }               a new step (its id must be new)
 *   { op: "remove", node }                      a step, with every wire that touches it and every read of its output
 *                                               (`out:<id>` in another step's `ctx`); never `text` or `send`
 *   { op: "wire",   from, to, mode, when?, allow?, unless? }  a wire (one per from, to and mode; an existing one gets the new `when`)
 *   { op: "unwire", from, to, mode? }           a wire (every mode between the two when `mode` is left out)
 *   { op: "module", key, value }                one context module's edit (`graph.modules[key]`: words, size, cache); null drops it
 *   { op: "convo",  field, value }              one conversation setting (`graph.convo[field]`); null drops it
 *   { op: "convo_tool", tool, on }              one chat tool in `graph.convo.tools` on or off; null drops the setting
 *   { op: "model",  key, value }                one of the draft's own models (`graph.models[key]`); null deletes it,
 *                                               and the steps on it move to haiku-5-5, as the Lab's model form does
 *   { op: "group",  id, value }                 one group's box (`graph.groups[id]`: label, goal?, icon?, x?, y?, parent?), the
 *                                               box the steps whose `group` names it fold into; null drops the draft's own
 *   { op: "put",    graph }                     the whole graph
 *
 * Each edit names the pieces it touches (`keysOf`). The control plane keeps which pieces every revision touched, and an
 * edit made against an older revision is refused only when a revision since then touched one of its pieces: two
 * edits to different fields both land, and the later of two edits to the same field is told the value it would have
 * overwritten (`functions/texLabDrafts.ts`). Nothing here reads a clock or a store: the Lab, the control plane and the
 * gateway run this same code.
 */

// The wire modes, a provisional wire's allows and a step's fields are the schema's (`texConfigSchema.cjs`).
const SCHEMA = require("../../tex/src/texConfigSchema.cjs");
const MODES = [...SCHEMA.MODES];
const ALLOW = [...SCHEMA.ALLOW];
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
/** The fields a `set` may change: everything a step has but its id (which `remove` and `add` change). */
const NODE_FIELDS = new Set(SCHEMA.NODE_FIELDS);
/** At most this many edits in one batch. */
const MAX_OPS = 200;
/** Every version needs a start and a send (the Lab's `delSel`). */
const KEPT_STEPS = new Set(["text", "send"]);
/** The model a step moves to when the model it ran on is deleted (the Lab's `deleteModel`). */
const FALLBACK_MODEL = "haiku-5-5";
/** A change line as the change list shows it, and the whole line `tex_dev`'s `changes` answers (cut at this). */
const SHORT = 60;
const FULL = 1000;

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
    case "convo_tool":
      return [`c:tools:${op.tool}`];
    case "model":
      return [`md:${op.key}`];
    case "group":
      return [`g:${op.id}`];
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
  // A whole step overlaps its fields; the conversation's whole tool list overlaps each tool.
  if ((short_.startsWith("n:") || short_.startsWith("c:")) && long_.startsWith(short_ + ":")) return true;
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
 * Apply a batch of edits to a graph. Answers `{ graph, keys, said, full }`: the new graph (the input is not changed),
 * every piece the batch touched, one plain line per edit for the change list, and the same lines uncut (up to
 * `FULL` characters) for `tex_dev`'s `changes`. Throws `OpError` naming the first edit that cannot apply, and then
 * nothing of the batch applies.
 */
function applyOps(graph, ops) {
  if (!Array.isArray(ops) || ops.length === 0) throw new OpError("there are no edits");
  if (ops.length > MAX_OPS) throw new OpError(`at most ${MAX_OPS} edits at once`);
  let g = clone(asGraph(graph));
  const keys = [];
  const said = [];
  const full = [];
  /** One line, from a function of how long a value may be shown. */
  const line = (of) => {
    said.push(of(SHORT));
    full.push(short(of(FULL), FULL));
  };
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
          line((max) => `set ${n.id} ${op.field} ${short(show(before), max)} → ${short(show(op.value === null ? undefined : op.value), max)}`);
          break;
        }
        case "move": {
          const n = find(needId(op.node, "node"));
          if (!n) throw at(`there is no step "${op.node}"`);
          if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) throw at("x and y must be numbers");
          n.x = Math.round(op.x);
          n.y = Math.round(op.y);
          line(() => `moved ${n.id}`);
          break;
        }
        case "add": {
          const n = op.node;
          if (!n || typeof n !== "object" || Array.isArray(n)) throw at("it has no step");
          needId(n.id, "the new step's id");
          if (find(n.id)) throw at(`there is already a step "${n.id}"`);
          for (const k of Object.keys(n)) if (k !== "id" && !NODE_FIELDS.has(k)) throw at(`"${k}" is not a field a step has`);
          g.nodes.push({ label: n.id, goal: "", log: true, on: true, rounds: 1, out: 300, ctx: [], ms: 0, timeoutS: 0, areas: [], file: "", note: "", icon: "", model: "code", x: 0, y: 0, ...clone(n) });
          line(() => `added step ${n.id}`);
          break;
        }
        case "remove": {
          const id = needId(op.node, "node");
          if (!find(id)) throw at(`there is no step "${id}"`);
          if (KEPT_STEPS.has(id)) throw at("every version needs a start and a send, so text and send stay (turn a step off instead)");
          g.nodes = g.nodes.filter((n) => n.id !== id);
          const wires = g.edges.length;
          g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
          // The steps that read its output stop reading it, as the Lab's delete does (`delSel`).
          const readers = g.nodes.filter((n) => Array.isArray(n.ctx) && n.ctx.includes("out:" + id));
          for (const n of readers) {
            n.ctx = n.ctx.filter((c) => c !== "out:" + id);
            keys.push(`n:${n.id}:ctx`);
          }
          const w = wires - g.edges.length;
          const parts = [w ? `its ${w} wire${w === 1 ? "" : "s"}` : "", readers.length ? `${readers.map((n) => n.id).join(", ")}'s read${readers.length === 1 ? "" : "s"} of its output` : ""].filter(Boolean);
          line(() => `removed step ${id}` + (parts.length ? " and " + parts.join(" and ") : ""));
          break;
        }
        case "wire": {
          needId(op.from, "from");
          needId(op.to, "to");
          if (!find(op.from) || !find(op.to)) throw at(`a wire joins a step that is not there (${op.from} → ${op.to})`);
          if (!MODES.includes(op.mode)) throw at(`mode must be one of ${MODES.join(", ")}`);
          const when = op.when === undefined ? ["*"] : op.when;
          if (!Array.isArray(when) || !when.every((w) => typeof w === "string" && w.length > 0 && w.length <= 40)) throw at("when must be a list of tags");
          // A provisional wire's allow (Dev2, 2026-11-17): what its step may do before the go; kept on a rewire that names
          // none, and dropped (back to the default, revertible) by null.
          if (op.allow !== undefined && op.allow !== null && !(op.mode === "provisional" && ALLOW.includes(op.allow))) throw at(`allow is only for a provisional wire, and one of ${ALLOW.join(", ")}`);
          // `unless`: the bursts that do not start a provisional run early. null clears it (every burst starts it).
          const unlessOk = Array.isArray(op.unless) && op.unless.every((fact) => SCHEMA.START_FACTS.includes(fact));
          if (op.unless !== undefined && op.unless !== null && !(op.mode === "provisional" && unlessOk)) throw at(`unless is only for a provisional wire, and each one of ${SCHEMA.START_FACTS.join(", ")}`);
          const had = g.edges.find((e) => e.from === op.from && e.to === op.to && e.mode === op.mode);
          if (had) {
            had.when = [...when];
            if (op.allow === null) delete had.allow;
            else if (op.allow !== undefined) had.allow = op.allow;
            if (op.unless === null) delete had.unless;
            else if (op.unless !== undefined) had.unless = [...op.unless];
          } else g.edges.push({ from: op.from, to: op.to, mode: op.mode, when: [...when], ...(typeof op.allow === "string" ? { allow: op.allow } : {}), ...(Array.isArray(op.unless) ? { unless: [...op.unless] } : {}) });
          const allow = op.allow ?? had?.allow;
          const unless = op.unless === null ? undefined : (op.unless ?? had?.unless);
          line(() => `${had ? "rewired" : "wired"} ${op.from} → ${op.to} (${op.mode}${allow ? " " + allow : ""}${Array.isArray(unless) && unless.length ? ", unless " + unless.join(", ") : ""}${when.join(",") === "*" ? "" : ", when " + when.join(", ")})`);
          break;
        }
        case "unwire": {
          if (op.mode !== undefined && !MODES.includes(op.mode)) throw at(`mode must be one of ${MODES.join(", ")}`);
          const keep = g.edges.filter((e) => !(e.from === op.from && e.to === op.to && (op.mode === undefined || e.mode === op.mode)));
          if (keep.length === g.edges.length) throw at(`there is no wire ${op.from} → ${op.to}${op.mode ? " (" + op.mode + ")" : ""}`);
          g.edges = keep;
          line(() => `unwired ${op.from} → ${op.to}${op.mode ? " (" + op.mode + ")" : ""}`);
          break;
        }
        case "module": {
          if (typeof op.key !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(op.key)) throw at("key is not a module key");
          if (op.value !== null && (typeof op.value !== "object" || Array.isArray(op.value))) throw at("value must be the module's edit as an object, or null");
          g.modules = { ...(g.modules ?? {}) };
          if (op.value === null) delete g.modules[op.key];
          else g.modules[op.key] = clone(op.value);
          line(() => (op.value === null ? `dropped the edit to module ${op.key}` : `edited module ${op.key}${typeof op.value.text === "string" ? " (its words)" : ""}`));
          break;
        }
        case "convo": {
          if (typeof op.field !== "string" || !/^[A-Za-z]{1,30}$/.test(op.field)) throw at("field is not a conversation setting");
          if (op.value === undefined) throw at("it has no value");
          g.convo = { ...(g.convo ?? {}) };
          const before = g.convo[op.field];
          if (op.value === null) delete g.convo[op.field];
          else g.convo[op.field] = clone(op.value);
          line((max) => `set conversation ${op.field} ${short(show(before), max)} → ${short(show(op.value === null ? undefined : op.value), max)}`);
          break;
        }
        case "convo_tool": {
          if (typeof op.tool !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(op.tool)) throw at("tool is not a chat tool's name");
          if (op.on !== null && typeof op.on !== "boolean") throw at("on must be true, false, or null to drop the setting");
          // One tool merged into the list, as the Lab's Conversation tab does (`setCvTool`).
          g.convo = { ...(g.convo ?? {}) };
          g.convo.tools = { ...(g.convo.tools ?? {}) };
          const before = g.convo.tools[op.tool];
          if (op.on === null) delete g.convo.tools[op.tool];
          else g.convo.tools[op.tool] = op.on;
          line(() => `set conversation tool ${op.tool} ${show(before)} → ${show(op.on === null ? undefined : op.on)}`);
          break;
        }
        case "model": {
          if (typeof op.key !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(op.key)) throw at("key is not a model key");
          if (op.value === undefined || (op.value !== null && (typeof op.value !== "object" || Array.isArray(op.value)))) throw at("value must be the model as an object, or null to delete it");
          if (op.value !== null && (typeof op.value.name !== "string" || !op.value.name.trim())) throw at("a model needs a name");
          g.models = { ...(g.models ?? {}) };
          if (op.value === null) {
            if (!g.models[op.key]) throw at(`this draft has no model "${op.key}" of its own`);
            delete g.models[op.key];
            // Its steps move to Haiku, as the Lab's model form does when a model is deleted (`deleteModel`).
            const moved = g.nodes.filter((n) => n.model === op.key);
            for (const n of moved) {
              n.model = FALLBACK_MODEL;
              keys.push(`n:${n.id}:model`);
            }
            line(() => `deleted model ${op.key}` + (moved.length ? ` (${moved.map((n) => n.id).join(", ")} moved to ${FALLBACK_MODEL})` : ""));
          } else {
            const had = g.models[op.key];
            g.models[op.key] = clone(op.value);
            line(() => `${had ? "changed" : "added"} model ${op.key} (${op.value.name}${typeof op.value.id === "string" ? ", " + op.value.id : ""})`);
          }
          break;
        }
        case "group": {
          if (typeof op.id !== "string" || !ID.test(op.id)) throw at("id is not a group id");
          if (op.value === undefined || (op.value !== null && (typeof op.value !== "object" || Array.isArray(op.value)))) throw at("value must be the group's box { label, goal?, icon?, x?, y?, parent?, component? }, or null");
          if (op.value !== null) {
            if (typeof op.value.label !== "string" || !op.value.label.trim()) throw at("a group needs a label");
            for (const k of Object.keys(op.value)) if (!["label", "goal", "icon", "x", "y", "parent", "component"].includes(k)) throw at(`a group has no field ${k}`);
            if (g.nodes.some((n) => n.id === op.id)) throw at(`${op.id} is a step's id; a group needs an id of its own`);
            // Groups nest (Dev2, 2026-11-16): `parent` is the group this one sits in, never itself or one inside it.
            if (op.value.parent !== undefined) {
              if (typeof op.value.parent !== "string" || !ID.test(op.value.parent)) throw at("parent is not a group id");
              if (op.value.parent === op.id) throw at("a group cannot sit inside itself");
              for (let up = op.value.parent, seen = 0; up && seen <= 64; up = g.groups?.[up]?.parent, seen++)
                if (up === op.id) throw at(`${op.value.parent} sits inside ${op.id}, so ${op.id} cannot sit inside it`);
            }
            for (const k of ["goal", "icon"]) if (op.value[k] !== undefined && typeof op.value[k] !== "string") throw at(`${k} must be words`);
            for (const k of ["x", "y"]) if (op.value[k] !== undefined && !Number.isFinite(op.value[k])) throw at(`${k} must be a number`);
            if (op.value.component !== undefined && typeof op.value.component !== "boolean") throw at("component must be true or false");
          }
          g.groups = { ...(g.groups ?? {}) };
          const had = g.groups[op.id];
          if (op.value === null) delete g.groups[op.id];
          else g.groups[op.id] = clone(op.value);
          if (Object.keys(g.groups).length === 0) delete g.groups;
          line(() => (op.value === null ? `dropped group ${op.id}` : `${had ? "changed" : "added"} group ${op.id} (${op.value.label})`));
          break;
        }
        case "put": {
          g = clone(asGraph(op.graph));
          line(() => "replaced the whole graph");
          break;
        }
        default:
          throw at("not an edit: use set, move, add, remove, wire, unwire, module, convo, convo_tool, model, group or put");
      }
    } catch (error) {
      if (error instanceof OpError && error.message.startsWith("edit ")) throw error;
      throw at(error instanceof Error ? error.message : String(error));
    }
    keys.push(...keysOf(op));
  });
  return { graph: g, keys: [...new Set(keys)], said, full };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const isMap = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const allBool = (map) => Object.values(map).every((x) => typeof x === "boolean");

/**
 * The edits that turn graph `a` into graph `b`: what the Lab sends when a person changes a live draft, and the undo a
 * change keeps (with `b` the graph before it). Steps, wires, modules, the draft's own models, conversation settings
 * and each chat tool become edits of their own; anything else the graph holds (`folded`) changing makes the batch one
 * `put`, since that has no smaller edit. Answers [] when nothing changed.
 */
function diffGraphs(a, b) {
  asGraph(a);
  asGraph(b);
  const rest = (g) => {
    const { nodes: _n, edges: _e, modules: _m, convo: _c, models: _d, groups: _g, ...others } = g;
    return others;
  };
  if (!same(rest(a), rest(b))) return [{ op: "put", graph: clone(b) }];
  const ops = [];
  for (const [part, op, name] of [["modules", "module", "key"], ["models", "model", "key"], ["convo", "convo", "field"], ["groups", "group", "id"]]) {
    const was = a[part] ?? {};
    const now = b[part] ?? {};
    for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (same(was[k], now[k])) continue;
      // The chat tools are one edit per tool, so two people turning on different tools both land.
      const tw = was[k] ?? {};
      const tn = now[k];
      if (part === "convo" && k === "tools" && isMap(tw) && isMap(tn) && allBool(tn)) {
        for (const t of new Set([...Object.keys(tw), ...Object.keys(tn)])) if (tw[t] !== tn[t]) ops.push({ op: "convo_tool", tool: t, on: tn[t] === undefined ? null : tn[t] });
        continue;
      }
      ops.push({ op, [name]: k, value: now[k] === undefined ? null : clone(now[k]) });
    }
  }
  const before = new Map(a.nodes.map((n) => [n.id, n]));
  const after = new Map(b.nodes.map((n) => [n.id, n]));
  for (const id of before.keys()) if (!after.has(id)) ops.push({ op: "remove", node: id });
  // A removed step takes the reads of its output with it, and a deleted model moves its steps to Haiku: the edits do
  // that themselves, so those are not edits of their own.
  const goneOut = new Set([...before.keys()].filter((id) => !after.has(id)).map((id) => "out:" + id));
  const goneModels = new Set(ops.filter((o) => o.op === "model" && o.value === null).map((o) => o.key));
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
      if (field === "ctx" && goneOut.size && Array.isArray(was.ctx) && Array.isArray(n.ctx) && same(was.ctx.filter((c) => !goneOut.has(c)), n.ctx)) continue;
      if (field === "model" && goneModels.has(was.model) && n.model === FALLBACK_MODEL) continue;
      if (!same(was[field], n[field])) ops.push({ op: "set", node: id, field, value: n[field] === undefined ? null : clone(n[field]) });
    }
  }
  const key = (e) => `${e.from}>${e.to}>${e.mode}`;
  const wa = new Map(a.edges.map((e) => [key(e), e]));
  const wb = new Map(b.edges.map((e) => [key(e), e]));
  // A removed step's wires go with it.
  const gone = new Set(ops.filter((o) => o.op === "remove").map((o) => o.node));
  for (const [k, e] of wa) if (!wb.has(k) && !gone.has(e.from) && !gone.has(e.to)) ops.push({ op: "unwire", from: e.from, to: e.to, mode: e.mode });
  for (const [k, e] of wb) {
    const was = wa.get(k);
    const allow = was?.allow !== e.allow ? { allow: e.allow ?? null } : {};
    const unlessChanged = !same(was?.unless ?? null, e.unless ?? null);
    const unless = unlessChanged ? { unless: e.unless ?? null } : {};
    if (!was || !same(was.when, e.when) || was.allow !== e.allow || unlessChanged) ops.push({ op: "wire", from: e.from, to: e.to, mode: e.mode, when: [...(e.when ?? ["*"])], ...allow, ...unless });
  }
  return ops;
}

module.exports = { MODES, ALLOW, NODE_FIELDS, MAX_OPS, KEPT_STEPS, FALLBACK_MODEL, OpError, applyOps, diffGraphs, keysOf, overlaps, conflicts };
