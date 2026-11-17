/**
 * THE SHAPE OF TEX'S CONFIG, IN ONE PLACE (Dev2, 2026-11-17: "how do we define the schema version of this, and make sure
 * that when we make updates or changes to the schema everything is updated"; chose "A + B + schema, no split").
 *
 * `texConfig.json` is read by the gateway, the texting Worker, the Lab, `tex_dev`, the bench, Convex and a dozen
 * scripts. Each kept its own list of wire modes and efforts, and they drifted (the Lab's effort picker lacked "max").
 * This file is the one definition:
 *
 *   - `SCHEMA_VERSION`: the config's `"texConfig"` number. The committed file is always at it (CI).
 *   - the field lists every reader and editor takes theirs from: `NODE_FIELDS`, `MODES`, `EFFORTS`, `ALLOW`,
 *     `GROUP_FIELDS`, `KINDS`, `IO_TYPES`.
 *   - `configProblems(config)`: everything wrong with a config, as plain sentences; `texConfigOf(config)` throws on any.
 *   - `MIGRATIONS[i]` takes a graph from version i to i+1. A schema change bumps `SCHEMA_VERSION`, adds its migration,
 *     and runs it over the committed config in the same pull request (`node scripts/tex-config-migrate.mjs`). The same
 *     migrations run over a Lab draft when it is opened and when it is promoted (`migrateGraph`), so a draft saved under
 *     an older shape is upgraded rather than refused or misread. Every migration is idempotent, because a draft carries
 *     no version: it is run through all of them.
 *
 * Readers do not import `texConfig.json` themselves: runtime code reads `texConfig.cjs` (which checks it with this
 * file), Node scripts read it through `scripts/lib/texConfigFile.mjs`, and `scripts/tex-config-readers.mjs` fails CI
 * for any other file that does.
 */
"use strict";

const SCHEMA_VERSION = 2;

const MODES = Object.freeze(["wait", "uses", "background", "job", "loop", "provisional", "generator"]);
const EFFORTS = Object.freeze(["off", "low", "medium", "high", "xhigh", "max"]);
/** What a provisional run may do before its go: reads only, or reads and writes that can be undone (the default). */
const ALLOW = Object.freeze(["read", "revertible"]);
const KINDS = Object.freeze(["input", "tool"]);
/** The types a node's input and output fields may have (`inSchema`, `outSchema`; checked by the runner, `texGraph.cjs`). */
const IO_TYPES = Object.freeze(["text", "number", "choice", "object", "yesno", "score", "ids", "list"]);
const GROUP_FIELDS = Object.freeze(["label", "goal", "icon", "x", "y", "parent"]);

const isText = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isBool = (v) => typeof v === "boolean";
const isTextList = (v) => Array.isArray(v) && v.every(isText);
const isIo = (v) => Array.isArray(v) && v.every((f) => f && typeof f === "object" && isText(f.name) && IO_TYPES.includes(f.type) && (f.optional === undefined || isBool(f.optional)) && (f.options === undefined || isText(f.options)));

/** Every field a step may have, and what its value must be. `id` is the step's name; the rest are its settings. */
const NODE_SHAPE = Object.freeze({
  label: [isText, "words"],
  goal: [isText, "words"],
  log: [isBool, "true or false"],
  on: [isBool, "true or false"],
  rounds: [isCount, "a whole number"],
  out: [isCount, "a whole number"],
  ctx: [isTextList, "a list of module names"],
  ms: [isNum, "a number"],
  timeoutS: [isNum, "a number"],
  areas: [isTextList, "a list of area names"],
  file: [isText, "words"],
  note: [isText, "words"],
  icon: [isText, "words"],
  model: [isText, "a model key"],
  effort: [(v) => EFFORTS.includes(v), `one of ${EFFORTS.join(", ")}`],
  kind: [(v) => KINDS.includes(v), `one of ${KINDS.join(", ")}`],
  inSchema: [isIo, "a list of { name, type, optional?, options? } (options in words, as texGraph.cjs reads them)"],
  outSchema: [isIo, "a list of { name, type, optional?, options? } (options in words, as texGraph.cjs reads them)"],
  sendBack: [isNum, "a number"],
  x: [isNum, "a number"],
  y: [isNum, "a number"],
  group: [isText, "a group id"],
  fallback: [isText, "a model key"],
  // A step's own limits (Part end: parts, minutes, machineParts, machineMinutes; `jobPartEnd.cjs`), each a whole number.
  limits: [(v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(isCount), "an object of whole numbers"],
});
const NODE_FIELDS = Object.freeze(Object.keys(NODE_SHAPE));
const REQUIRED = Object.freeze(["label", "on", "model"]);
const EDGE_FIELDS = Object.freeze(["from", "to", "mode", "when", "rounds", "allow"]);
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;

/** Everything wrong with a parsed `texConfig.json`, as sentences a person reads; [] when it is sound. */
function configProblems(config) {
  const out = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["the config is not an object"];
  if (config.texConfig !== SCHEMA_VERSION) out.push(`it is schema version ${JSON.stringify(config.texConfig)}, not ${SCHEMA_VERSION}: run node scripts/tex-config-migrate.mjs`);
  if (!config.models || typeof config.models !== "object" || !Object.values(config.models).every(isText)) out.push("models must map each model key to a gateway model id");
  if (config.texConfig === SCHEMA_VERSION) out.push(...browserProblems(config.browsers));
  if (!Array.isArray(config.nodes) || !Array.isArray(config.edges)) return [...out, "it has no nodes and edges lists"];
  const models = config.models ?? {};
  const groups = config.groups ?? {};
  for (const [id, g] of Object.entries(groups)) {
    if (!ID.test(id)) out.push(`group "${id}" has no usable id`);
    if (!g || !isText(g.label)) out.push(`group "${id}" has no label`);
    for (const k of Object.keys(g ?? {})) if (!GROUP_FIELDS.includes(k)) out.push(`group "${id}" has a field the schema does not know: ${k}`);
    if (g?.parent !== undefined && !groups[g.parent]) out.push(`group "${id}" sits in a group that is not there (${g.parent})`);
  }
  const ids = new Set();
  for (const n of config.nodes) {
    if (!n || !isText(n.id) || !ID.test(n.id)) {
      out.push(`a step has no usable id (${JSON.stringify(n?.id)})`);
      continue;
    }
    if (ids.has(n.id)) out.push(`step "${n.id}" is there twice`);
    ids.add(n.id);
    for (const k of REQUIRED) if (n[k] === undefined) out.push(`step "${n.id}" has no ${k}`);
    for (const [k, v] of Object.entries(n)) {
      if (k === "id") continue;
      const shape = NODE_SHAPE[k];
      if (!shape) out.push(`step "${n.id}" has a field the schema does not know: ${k} (add it to texConfigSchema.cjs, with a migration if old drafts need it)`);
      else if (!shape[0](v)) out.push(`step "${n.id}" ${k} must be ${shape[1]}`);
    }
    if (isText(n.model) && n.model !== "code" && !isText(models[n.model])) out.push(`step "${n.id}" runs on "${n.model}", which has no gateway model id`);
    if (isText(n.fallback) && !isText(models[n.fallback])) out.push(`step "${n.id}" falls back to "${n.fallback}", which has no gateway model id`);
    if (isText(n.group) && !groups[n.group]) out.push(`step "${n.id}" is in a group that is not there (${n.group})`);
  }
  const wires = new Set();
  for (const e of config.edges) {
    const name = `${e?.from} → ${e?.to}`;
    if (!e || !ids.has(e.from) || !ids.has(e.to)) {
      out.push(`the wire ${name} joins a step that is not there`);
      continue;
    }
    for (const k of Object.keys(e)) if (!EDGE_FIELDS.includes(k)) out.push(`the wire ${name} has a field the schema does not know: ${k}`);
    if (!MODES.includes(e.mode)) out.push(`the wire ${name} has mode "${e.mode}", not one of ${MODES.join(", ")}`);
    if (!isTextList(e.when) || e.when.length === 0) out.push(`the wire ${name} needs a when list`);
    if (e.rounds !== undefined && !(Number.isInteger(e.rounds) && e.rounds > 0 && e.rounds <= 100)) out.push(`the wire ${name} has rounds that are not a whole number from 1 to 100`);
    if (e.allow !== undefined && !(e.mode === "provisional" && ALLOW.includes(e.allow))) out.push(`the wire ${name} has allow "${e.allow}": only a provisional wire has one, ${ALLOW.join(" or ")}`);
    const key = `${e.from}>${e.to}>${e.mode}`;
    if (wires.has(key)) out.push(`the wire ${name} (${e.mode}) is there twice`);
    wires.add(key);
  }
  return out;
}

/** A parsed config, checked: answered as it is, or an error naming every problem. */
function texConfigOf(config) {
  const problems = configProblems(config);
  if (problems.length > 0) throw new Error(`texConfig.json does not match its schema (texConfigSchema.cjs): ${problems.join("; ")}`);
  return config;
}

/**
 * The migrations, oldest first: `MIGRATIONS[i]` takes a graph (a config, or a Lab draft's `{ nodes, edges, ... }`)
 * from version i to i+1 and answers the new graph. Each is idempotent and leaves alone what it does not recognise.
 */
const ON_OFF = new Set(["on", "off"]);

/** The browser fallback, filled in when a draft has none. Values stay inside the hard caps. */
function browsersOf(raw) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    browserUseFallback: b.browserUseFallback === "on" ? "on" : "off",
    jobMinutes: Number.isInteger(b.jobMinutes) && b.jobMinutes >= 1 && b.jobMinutes <= 15 ? b.jobMinutes : 15,
    dayUsd: typeof b.dayUsd === "number" && b.dayUsd > 0 && b.dayUsd <= 1 ? b.dayUsd : 1,
    monthUsd: typeof b.monthUsd === "number" && b.monthUsd > 0 && b.monthUsd <= 5 ? b.monthUsd : 5,
    minBalanceUsd: typeof b.minBalanceUsd === "number" && b.minBalanceUsd >= 0.5 ? b.minBalanceUsd : 0.5,
  };
}

function browserProblems(browsers) {
  if (!browsers || typeof browsers !== "object" || Array.isArray(browsers)) return ["browsers must be the browser settings object"];
  const out = [];
  for (const key of Object.keys(browsers)) {
    if (!["browserUseFallback", "jobMinutes", "dayUsd", "monthUsd", "minBalanceUsd"].includes(key)) out.push(`browsers has a field the schema does not know: ${key}`);
  }
  if (!ON_OFF.has(browsers.browserUseFallback)) out.push('browsers.browserUseFallback must be "on" or "off"');
  if (!(Number.isInteger(browsers.jobMinutes) && browsers.jobMinutes >= 1 && browsers.jobMinutes <= 15)) out.push("browsers.jobMinutes must be a whole number from 1 to 15");
  if (!(typeof browsers.dayUsd === "number" && browsers.dayUsd > 0 && browsers.dayUsd <= 1)) out.push("browsers.dayUsd must be a number from above 0 to 1");
  if (!(typeof browsers.monthUsd === "number" && browsers.monthUsd > 0 && browsers.monthUsd <= 5)) out.push("browsers.monthUsd must be a number from above 0 to 5");
  if (!(typeof browsers.minBalanceUsd === "number" && browsers.minBalanceUsd >= 0.5)) out.push("browsers.minBalanceUsd must be a number of at least 0.5");
  return out;
}

const MIGRATIONS = Object.freeze([
  // 0 → 1 (2026-11-14): the wire mode "behind" was renamed "background" (Dev2).
  (g) => ({ ...g, edges: (g.edges ?? []).map((e) => (e && e.mode === "behind" ? { ...e, mode: "background" } : e)) }),
  // 1 → 2 (2026-11-17): the Browser Use fallback and its caps, off unless a config says on.
  (g) => ({ ...g, browsers: browsersOf(g.browsers) }),
]);

/**
 * A graph brought to the current schema. A config names its version (`texConfig`) and runs only the migrations after it;
 * a Lab draft names none and runs through all of them, which is why every migration is idempotent.
 */
function migrateGraph(graph) {
  if (!graph || typeof graph !== "object") return graph;
  const from = Number.isInteger(graph.texConfig) ? graph.texConfig : 0;
  let g = graph;
  for (let v = from; v < MIGRATIONS.length; v++) g = MIGRATIONS[v](g);
  return Number.isInteger(graph.texConfig) ? { ...g, texConfig: Math.max(graph.texConfig, SCHEMA_VERSION) } : g;
}

module.exports = { SCHEMA_VERSION, MODES, EFFORTS, ALLOW, KINDS, IO_TYPES, GROUP_FIELDS, NODE_FIELDS, EDGE_FIELDS, configProblems, texConfigOf, MIGRATIONS, migrateGraph };
