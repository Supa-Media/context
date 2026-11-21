/**
 * EVERY ARCHITECTURE THAT HAS A CONFIG OF ITS OWN (Dev2, 2026-11-21: "people know that we have like three different
 * architectures. Texting be the main one, and then there's nightly, and then there's also our search, and then maybe in
 * the future we add other things ... But they go through the same process for iterating on them in the lab and evals").
 *
 * Texting is `texConfig.json`, the default: a step with no `graph`, or one on a page no entry here claims, is Tex's.
 * Every other architecture is one entry below: its Lab page, its config file, that file's schema check and who runs it.
 * A Lab draft holds every architecture in one graph, each entry's steps tagged with `graph: <page>`, a tag that lives only
 * in the Lab; these helpers move steps between a draft and the entries' files, so the Lab, `tex_dev`, the checks, Promote
 * and the diagram treat every entry the same way. A new architecture (Nightly next, then meeting summaries) is one entry.
 */
"use strict";

const search = require("../../../apps/mcp/src/search/config/searchConfig.cjs");

/**
 * Each entry: `page` (a `GRAPHS` page, `texConfigSchema.cjs`), `label`, `file` (repo path), `versionKey` (the field
 * naming its schema version), `config` (main's, checked at load), `problems(config)` (its schema check, sentences),
 * `nodeKeys` and `edgeKeys` (the fields its file keeps), `promoted` (the step fields a Promote copies from a draft;
 * the rest is its code's), `runs` (who runs it, for a person reading the Lab or the diagram).
 */
const ARCHITECTURES = Object.freeze([
  Object.freeze({
    page: "search",
    label: "Search",
    file: "apps/mcp/src/search/config/searchConfig.json",
    versionKey: "searchConfig",
    config: search.SEARCH_CONFIG,
    problems: search.searchConfigProblems,
    nodeKeys: search.NODE_KEYS,
    edgeKeys: search.EDGE_KEYS,
    promoted: Object.freeze(["on", "label", "goal", "x", "y", "settings"]),
    runs: "The gateway's search, for every caller (an AI client's search_notes, the app's search bar, Tex): findNotes in apps/mcp/src/tools/search.js runs its steps (apps/mcp/src/search/config/nodes.js) on the shared graph runner.",
  }),
]);

// A JSON copy: jsdom (the Lab's test environment) has no structuredClone, and these are plain data.
const copy = (x) => JSON.parse(JSON.stringify(x));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** The entry for a page, or null for Texting (and any page no entry claims). */
function architectureOf(page) {
  return ARCHITECTURES.find((a) => a.page === page) ?? null;
}

/** Whether a draft's step belongs to a registered architecture (not Tex). */
const isOwnStep = (n) => Boolean(n) && ARCHITECTURES.some((a) => a.page === n.graph);

/** An entry's config as a draft's steps and wires, each step tagged with the entry's page. */
function draftStepsOf(entry, config = entry.config) {
  return { nodes: config.nodes.map((n) => ({ ...copy(n), graph: entry.page })), edges: config.edges.map(copy) };
}

/** Every registered architecture's main config as draft steps and wires, in registry order: what a draft adds to Tex's. */
function ownGraphs() {
  const parts = ARCHITECTURES.map((a) => draftStepsOf(a));
  return { nodes: parts.flatMap((p) => p.nodes), edges: parts.flatMap((p) => p.edges) };
}

/**
 * A draft's steps on an entry's page as that entry's config, or null when the draft holds none (a draft made before
 * the page existed): it then runs as main does. Only the fields the entry's file keeps survive, so the Lab's own fields
 * never reach it.
 */
function configFromDraft(graph, entry) {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((n) => n && n.graph === entry.page);
  if (nodes.length === 0) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(graph?.edges) ? graph.edges : []).filter((e) => e && ids.has(e.from) && ids.has(e.to));
  return { [entry.versionKey]: entry.config[entry.versionKey], about: entry.config.about, nodes: nodes.map((n) => pick(n, entry.nodeKeys)), edges: edges.map((e) => pick(e, entry.edgeKeys)) };
}

/** A draft without any registered architecture's steps and their wires: Tex's side, what Tex's config, checks and Promote read. */
function texSideOf(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const own = new Set(nodes.filter(isOwnStep).map((n) => n.id));
  if (own.size === 0) return graph;
  return { ...graph, nodes: nodes.filter((n) => !own.has(n.id)), edges: (graph.edges ?? []).filter((e) => !own.has(e.from) && !own.has(e.to)) };
}

/** Every problem with a draft's registered architectures, each prefixed with its label ("Search: ..."). */
function ownProblems(graph) {
  return ARCHITECTURES.flatMap((a) => {
    const config = configFromDraft(graph, a);
    return config ? a.problems(config).map((p) => `${a.label}: ${p}`) : [];
  });
}

/**
 * What a draft changes in each registered architecture against main, as lines a person reads:
 * "Search · Rank across workspaces: hits 12 → 8", a step turned on or off, added or gone. [] when all are as main.
 */
function ownVsMain(graph) {
  const lines = [];
  for (const a of ARCHITECTURES) {
    const draft = configFromDraft(graph, a);
    if (!draft) continue;
    const main = new Map(a.config.nodes.map((n) => [n.id, n]));
    for (const n of draft.nodes) {
      const m = main.get(n.id);
      const label = `${a.label} · ${n.label ?? m?.label ?? n.id}`;
      if (!m) {
        lines.push(`${label}: a new step (its code must merge first)`);
        continue;
      }
      if (m.on !== n.on) lines.push(`${label}: ${n.on ? "turned on" : "turned off"}`);
      for (const name of new Set([...Object.keys(m.settings ?? {}), ...Object.keys(n.settings ?? {})])) {
        const was = m.settings?.[name];
        const now = n.settings?.[name];
        if (was !== now) lines.push(`${label}: ${name} ${was ?? "unset"} → ${now ?? "unset"}`);
      }
    }
    const ids = new Set(draft.nodes.map((n) => n.id));
    for (const m of a.config.nodes) if (!ids.has(m.id)) lines.push(`${a.label} · ${m.label}: gone from the draft`);
  }
  return lines;
}

/**
 * The config a draft makes for one entry over its current file, `{ config }` or `{ refused }`. A draft with none of the
 * entry's steps leaves the file as it is. Each current step takes the draft step's `promoted` fields; the schema
 * version, the about line and the wires stay the file's (wires are not editable yet). A step the draft adds has no code,
 * so it is refused, as a new Tex step is; a step the draft lacks is refused too, never deleted here. The result must
 * pass the entry's own check.
 */
function promotedConfig(entry, graph, current) {
  const draft = configFromDraft(graph, entry);
  if (!draft) return { config: current };
  const drafted = new Map(draft.nodes.map((n) => [n.id, n]));
  const mains = new Set(current.nodes.map((n) => n.id));
  const added = draft.nodes.find((n) => !mains.has(n.id));
  if (added) return { refused: `${entry.label} step ${added.id} is new: its code must merge first` };
  const missing = current.nodes.find((n) => !drafted.has(n.id));
  if (missing) return { refused: `${entry.label} step ${missing.id} is missing from the draft: its steps are kept, so put it back` };
  const nodes = current.nodes.map((n) => {
    const d = drafted.get(n.id);
    const out = { ...n };
    for (const field of entry.promoted) if (d[field] !== undefined) out[field] = d[field];
    return out;
  });
  const config = { ...current, nodes };
  const problems = entry.problems(config);
  return problems.length > 0 ? { refused: `${entry.label.toLowerCase()}: ${problems.join("; ")}` } : { config };
}

/**
 * An architecture's config file as text: two-space JSON, with each small flat object (a schema field, a step's
 * settings) and each list of plain values on one line, so a file of many steps stays readable and under the
 * repository's file-size limit. Promote writes it, and the files are kept in it.
 */
function configFileText(config) {
  const flat = (v) => v !== null && typeof v === "object" && Object.values(v).every((x) => x === null || typeof x !== "object");
  const inline = (v) => (Array.isArray(v) ? JSON.stringify(v) : `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ")} }`);
  const out = (v, pad) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (flat(v) && (Array.isArray(v) || Object.keys(v).length === 0 || inline(v).length < 110)) return Array.isArray(v) || Object.keys(v).length ? inline(v) : "{}";
    const inner = `${pad}  `;
    if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + out(x, inner)).join(",\n")}\n${pad}]` : "[]";
    return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${out(x, inner)}`).join(",\n")}\n${pad}}`;
  };
  return `${out(config, "")}\n`;
}

module.exports = { ARCHITECTURES, architectureOf, configFileText, isOwnStep, draftStepsOf, ownGraphs, configFromDraft, texSideOf, ownProblems, ownVsMain, promotedConfig };
