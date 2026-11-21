/**
 * TEX'S CONFIG IS TWO FILES: TEXTING AND NIGHTLY (Dev2, 2026-11-21: "we can have like a texting config, text nightly
 * config, and then search config", each iterated on the same way in the Lab and evals).
 *
 * `texConfig.json` holds the texting graph (and the models, browsers and groups every Tex step names); `nightlyConfig.json`
 * holds the nightly cleanup's steps (Nightly, Dream, Day summaries, Housekeeping, the About me checks) and the wires among
 * them. Both are Tex: one runner, one node schema (`texConfigSchema.cjs`), so every reader gets them JOINED, as one config
 * with each nightly step tagged `graph: "nightly"`, exactly as before the split; only the files are two. Writers split a
 * joined config back with `splitConfig`. Search is a separate architecture with its own schema (`architectures.cjs`).
 *
 * Pure: the loaders (`texConfig.cjs`, `scripts/lib/texConfigFile.mjs`), Promote, the merge and the Lab's config-at-a-
 * commit reader all call these, so the two files can never be joined two ways.
 */
"use strict";

const NIGHTLY_PAGE = "nightly";
/** The nightly file's path from the repository root, and the field naming its own format version. */
const NIGHTLY_PATH = "packages/tex/src/nightlyConfig.json";
const NIGHTLY_VERSION = 1;
const NIGHTLY_ABOUT =
  "Tex's nightly cleanup as it runs: Nightly starts each person's night, then the dream, the day summaries, housekeeping and the About me checks, with every wire among them. Same steps and schema as texConfig.json, kept in a file of its own so it is iterated on as its own architecture (Dev2, 2026-11-21). The Lab shows it on Architecture > Nightly; Promote writes it.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One config from the two files: the texting file with the nightly file's steps (tagged `graph: "nightly"`) and wires
 * appended. A missing nightly file (a commit from before the split, whose texConfig.json still holds them) answers the
 * texting file as it is. A step id in both files is an error, never a silent pick.
 */
function joinConfigs(tex, nightly) {
  // Only a nightly file joins: anything else (a missing file, an error page, another config) leaves Tex's as it is.
  if (!isObj(nightly) || !Number.isInteger(nightly.nightlyConfig)) return tex;
  const have = new Set((tex.nodes ?? []).map((n) => n.id));
  const nodes = (Array.isArray(nightly.nodes) ? nightly.nodes : []).map((n) => {
    if (have.has(n.id)) throw new Error(`step ${n.id} is in both texConfig.json and nightlyConfig.json`);
    return { ...n, graph: NIGHTLY_PAGE };
  });
  const edges = Array.isArray(nightly.edges) ? nightly.edges : [];
  return { ...tex, nodes: [...(tex.nodes ?? []), ...nodes], edges: [...(tex.edges ?? []), ...edges] };
}

/**
 * The two files' contents from one joined config: `{ tex, nightly }`. The nightly steps lose their `graph` tag (the
 * file says it), and a wire goes with its steps; a wire joining the two pages is refused by the schema already.
 */
function splitConfig(config) {
  const night = new Set((config.nodes ?? []).filter((n) => n && n.graph === NIGHTLY_PAGE).map((n) => n.id));
  const isNight = (e) => night.has(e.from) || night.has(e.to);
  const nightly = {
    nightlyConfig: NIGHTLY_VERSION,
    about: NIGHTLY_ABOUT,
    nodes: config.nodes.filter((n) => night.has(n.id)).map(({ graph: _graph, ...n }) => n),
    edges: config.edges.filter(isNight),
  };
  const tex = { ...config, nodes: config.nodes.filter((n) => !night.has(n.id)), edges: config.edges.filter((e) => !isNight(e)) };
  return { tex, nightly };
}

/** The nightly file's text: the head, then one step and one wire per line, as the texting file is written. */
function nightlyText(nightly) {
  const lines = (a) => "[\n" + a.map((x) => "    " + JSON.stringify(x)).join(",\n") + "\n  ]";
  return `{\n  "nightlyConfig": ${nightly.nightlyConfig},\n  "about": ${JSON.stringify(nightly.about)},\n  "nodes": ${lines(nightly.nodes)},\n  "edges": ${lines(nightly.edges)}\n}\n`;
}

module.exports = { NIGHTLY_PAGE, NIGHTLY_PATH, NIGHTLY_VERSION, NIGHTLY_ABOUT, joinConfigs, splitConfig, nightlyText };
