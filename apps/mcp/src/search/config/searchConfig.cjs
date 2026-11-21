/**
 * SEARCH'S CONFIG, AS EVERY RUNTIME READS IT (Dev2, 2026-11-21: "we can have like a texting config, text nightly
 * config, and then search config because not only text users search").
 *
 * `searchConfig.json` holds every step a search runs (a node), its settings, and the wires between them, in the
 * Lab's graph shape (the one Tex's `texConfig.json` uses). The gateway's search (`config/nodes.js`, run by the shared
 * graph runner) and the defaults every other caller of the search code ranks by (`../ranking.js`, `../settings.js`)
 * read it through this file only, so a config that does not match the schema below fails loudly at start instead of
 * being misread. The Lab draws it on its Search page and a Promote changes it in a pull request.
 *
 * The schema is this file's: `SEARCH_SETTINGS_BOUNDS` (what each setting may be), the node and wire fields, and
 * `searchConfigProblems(config)`, everything wrong with a config as sentences. A draft from the Lab is checked by the
 * same function before a search runs on it.
 */
"use strict";

const SEARCH_SCHEMA_VERSION = 1;

/**
 * Every setting a search step may have, and what it may be. The ranking knobs are `../ranking.js`'s; `minScore`,
 * `extraNotes` and `snippetChars` are the person-facing search settings (`../settings.js`), whose defaults are here.
 */
const SEARCH_SETTINGS_BOUNDS = Object.freeze({
  minScore: { min: 0, max: 1, integer: false },
  extraNotes: { min: 0, max: 10, integer: true },
  snippetChars: { min: 50, max: 2000, integer: true },
  rrfK: { min: 1, max: 1000, integer: false },
  loosePenalty: { min: 0, max: 1000, integer: false },
  titleWeight: { min: 0, max: 1, integer: false },
  phraseBonus: { min: 0, max: 1, integer: false },
  snippetPhraseBonus: { min: 0, max: 1, integer: false },
  boostFactor: { min: 1, max: 10, integer: false },
  meaningFloor: { min: 0, max: 1, integer: false },
  looseReads: { min: 0, max: 20, integer: true },
  hits: { min: 1, max: 50, integer: true },
  logPrior: { min: 0, max: 1, integer: false },
  inboxPrior: { min: 0, max: 1, integer: false },
});

/** Which settings each step reads: a setting on a step that does not read it would be a knob that does nothing. */
const SETTINGS_OF = Object.freeze({
  search: Object.freeze([]),
  each: Object.freeze([]),
  open: Object.freeze([]),
  words: Object.freeze([]),
  meaning: Object.freeze(["minScore"]),
  merge: Object.freeze(["meaningFloor", "rrfK", "titleWeight", "phraseBonus", "snippetPhraseBonus"]),
  prior: Object.freeze(["logPrior", "inboxPrior"]),
  snippets: Object.freeze(["extraNotes", "snippetChars", "looseReads"]),
  fuse: Object.freeze(["hits", "rrfK", "loosePenalty", "titleWeight", "phraseBonus", "snippetPhraseBonus", "meaningFloor", "looseReads", "boostFactor", "logPrior", "inboxPrior"]),
});

const NODE_KEYS = Object.freeze(["id", "label", "goal", "on", "model", "kind", "icon", "file", "note", "x", "y", "group", "settings", "inSchema", "outSchema", "log"]);
const EDGE_KEYS = Object.freeze(["from", "to", "mode", "when"]);
/** `wait`: the next step runs on this one's output. `uses`: "Search each workspace" calls the step once per workspace. */
const MODES = Object.freeze(["wait", "uses"]);

/** Why one setting's value is refused, or null when it may be used. */
function settingProblem(name, value) {
  const bound = SEARCH_SETTINGS_BOUNDS[name];
  if (!bound) return `"${name}" is not a search setting (one of ${Object.keys(SEARCH_SETTINGS_BOUNDS).join(", ")})`;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a number`;
  if (value < bound.min || value > bound.max) return `${name} must be from ${bound.min} to ${bound.max}`;
  if (bound.integer && !Number.isInteger(value)) return `${name} must be a whole number`;
  return null;
}

/** Everything wrong with a parsed search config, as sentences a person reads; [] when it is sound. */
function searchConfigProblems(config) {
  const out = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["the search config is not an object"];
  if (config.searchConfig !== SEARCH_SCHEMA_VERSION) out.push(`it is search schema version ${JSON.stringify(config.searchConfig)}, not ${SEARCH_SCHEMA_VERSION}`);
  if (!Array.isArray(config.nodes) || !Array.isArray(config.edges)) return [...out, "it has no nodes and edges lists"];
  const ids = new Set();
  for (const n of config.nodes) {
    if (!n || typeof n.id !== "string") {
      out.push("a step has no id");
      continue;
    }
    if (ids.has(n.id)) out.push(`step "${n.id}" is there twice`);
    ids.add(n.id);
    const reads = SETTINGS_OF[n.id];
    if (!reads) out.push(`step "${n.id}" is not a search step (one of ${Object.keys(SETTINGS_OF).join(", ")})`);
    for (const k of Object.keys(n)) if (!NODE_KEYS.includes(k)) out.push(`step "${n.id}" has a field the search schema does not know: ${k}`);
    if (typeof n.label !== "string") out.push(`step "${n.id}" has no label`);
    if (typeof n.on !== "boolean") out.push(`step "${n.id}" on must be true or false`);
    if (n.model !== "code") out.push(`step "${n.id}" runs as code (model "code")`);
    const settings = n.settings ?? {};
    if (typeof settings !== "object" || Array.isArray(settings)) {
      out.push(`step "${n.id}" settings must be an object`);
      continue;
    }
    for (const [name, value] of Object.entries(settings)) {
      const problem = settingProblem(name, value);
      if (problem) out.push(`step "${n.id}": ${problem}`);
      else if (reads && !reads.includes(name)) out.push(`step "${n.id}" does not read ${name}`);
    }
    for (const name of reads ?? []) if (!(name in settings)) out.push(`step "${n.id}" has no ${name} setting`);
  }
  for (const id of Object.keys(SETTINGS_OF)) if (!ids.has(id)) out.push(`there is no "${id}" step`);
  for (const e of config.edges) {
    const name = `${e?.from} → ${e?.to}`;
    if (!e || !ids.has(e.from) || !ids.has(e.to)) {
      out.push(`the wire ${name} joins a step that is not there`);
      continue;
    }
    for (const k of Object.keys(e)) if (!EDGE_KEYS.includes(k)) out.push(`the wire ${name} has a field the search schema does not know: ${k}`);
    if (!MODES.includes(e.mode)) out.push(`the wire ${name} has mode "${e.mode}": search wires are ${MODES.join(" or ")}`);
    if (!Array.isArray(e.when) || e.when.length === 0) out.push(`the wire ${name} needs a when list`);
  }
  return out;
}

/** A parsed config, checked: answered as it is, or an error naming every problem. */
function searchConfigOf(config) {
  const problems = searchConfigProblems(config);
  if (problems.length > 0) throw new Error(`searchConfig.json does not match its schema (searchConfig.cjs): ${problems.join("; ")}`);
  return config;
}

const SEARCH_CONFIG = Object.freeze(searchConfigOf(require("./searchConfig.json")));

/** A step's settings in a config (main's when none is given), or {} when it has none. */
function settingsOf(id, config = SEARCH_CONFIG) {
  const node = (config?.nodes ?? []).find((n) => n && n.id === id);
  return node && node.settings && typeof node.settings === "object" ? node.settings : {};
}

module.exports = { NODE_KEYS, EDGE_KEYS, SEARCH_SCHEMA_VERSION, SEARCH_SETTINGS_BOUNDS, SETTINGS_OF, SEARCH_CONFIG, searchConfigProblems, searchConfigOf, settingProblem, settingsOf };
