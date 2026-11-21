#!/usr/bin/env node
/**
 * TEX'S DRAWING, AND WHAT TEX IS TOLD ABOUT ITSELF, COME FROM TEX'S CONFIG (Dev2, 2026-11-14: the config is the source
 * of truth for what runs, and the connections between nodes are config, never code; "we do sort of ... give Tex the
 * context of its own structure").
 *
 * `packages/tex/src/texConfig.json` holds every node and every wire Tex runs. This script makes, from it alone:
 *
 *   1. the drawing in `docs/architecture/tex.md`, between `<!-- tex-config: drawing begin -->` and `end -->`: one
 *      Mermaid flowchart per Lab page (a node's `graph`: Texting, then Nightly; Dev2, 2026-11-20), a box per node
 *      (its group as a subgraph) and an arrow per wire, drawn by its mode;
 *   2. the steps table in the same page, between `<!-- tex-config: steps begin -->` and `end -->`;
 *   3. `packages/tex/gateway/agent/texArchitecture.generated.js`: `TEX_MAP`, the same graph in words, which
 *      `texArchitecture.js` puts ahead of every Tex agent's prompt with the one line naming the node that agent is.
 *
 * Nothing here is hand-drawn, so nothing can drift: change the config (by hand or with the Lab's Promote), run this,
 * and the page and every prompt follow. `tex-diagram-check.mjs` fails CI when any of the three is stale.
 *
 *   node scripts/tex-architecture.mjs           write all three
 *   node scripts/tex-architecture.mjs --check   fail when any is stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { CONFIG_PATH, joinedTexConfig, readTexConfig } from "./lib/texConfigFile.mjs";

const { GRAPHS, graphOf } = createRequire(import.meta.url)("../packages/tex/src/texConfigSchema.cjs");
// Every architecture with a config of its own (Search, ...): each gets its own generated page (Dev2, 2026-11-21).
const { ARCHITECTURES } = createRequire(import.meta.url)("../packages/tex/src/architectures.cjs");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = CONFIG_PATH;
export const PAGE = "docs/architecture/tex.md";
export const MODULE = "packages/tex/gateway/agent/texArchitecture.generated.js";

/**
 * Every wire mode the runner knows (`packages/tex/src/texGraph.cjs`), and how the page and the words say it.
 * `behind` is the old spelling of `background`, read the same until the config's rename lands everywhere.
 */
export const MODES = Object.freeze({
  wait: { arrow: "-->", says: "then" },
  uses: { arrow: "-.->", says: "may call" },
  background: { arrow: "-.->", says: "afterwards, in the background, nobody waiting" },
  behind: { arrow: "-.->", says: "afterwards, in the background, nobody waiting" },
  loop: { arrow: "==>", says: "may send work back to" },
  job: { arrow: "==>", says: "may start as a background job" },
  // A provisional run (Dev2, 2026-11-17): the target starts without waiting for this step, which may stop or restart
  // it at any point; until this step says go, the target may only read, or make writes that can be undone.
  provisional: { arrow: "-..->", says: "may stop, restart or give its go to" },
  // A generator (Dev2, 2026-11-16, the generators model): fire and forget; the target, an input node, starts a run of
  // its own, in this chat or another, and nothing in this run waits for it.
  generator: { arrow: "-.->", says: "starts a new run at" },
});
const modeOf = (mode) => (mode === "behind" ? "background" : mode);

/** How the page and the words name each model, from a gateway id. */
export function modelName(id) {
  const claude = /^anthropic\/claude-([a-z]+)-(\d+)-(\d+)$/.exec(id ?? "");
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  if (id === "@cf/cloudflare/clef") return "Clef";
  const glm = /^@cf\/zai-org\/glm-([\d.]+)-flash$/.exec(id ?? "");
  if (glm) return `GLM-${glm[1]} Flash`;
  return id ?? "code";
}

/** A node's model as people read it: "code", or the model's name. */
export function nodeModel(config, n) {
  return n.model === "code" ? "code" : modelName(config.models?.[n.model] ?? n.model);
}

/** Problems with the config's shape that would make the drawing a lie: a wire to a node that isn't there, an unknown mode. */
export function shapeProblems(config) {
  const ids = new Set((config.nodes ?? []).map((n) => n.id));
  const problems = [];
  const seen = new Set();
  for (const n of config.nodes ?? []) {
    if (seen.has(n.id)) problems.push(`node "${n.id}" is in ${CONFIG} twice`);
    seen.add(n.id);
  }
  for (const e of config.edges ?? []) {
    if (!ids.has(e.from)) problems.push(`a wire starts at "${e.from}", which is not a node in ${CONFIG}`);
    if (!ids.has(e.to)) problems.push(`a wire ends at "${e.to}", which is not a node in ${CONFIG}`);
    if (!(e.mode in MODES)) problems.push(`the wire ${e.from} → ${e.to} has mode "${e.mode}", which the runner does not know`);
  }
  return problems;
}

const when = (e) => ((e.when ?? ["*"]).join() === "*" ? "" : (e.when ?? []).join(", "));
/** What a provisional run may do before its go, as the words say it: "provisional run (revertible)". */
const provisionalAs = (e) => `provisional run (${e.allow === "read" ? "read only" : "revertible"})`;
/** Bursts that do not start a provisional run early, as the words say it. */
const unless = (e) => (Array.isArray(e.unless) && e.unless.length ? `, unless ${e.unless.join(", ")}` : "");
const quote = (text) => String(text).replaceAll('"', "#quot;");
const cell = (text) => String(text).replaceAll("|", "\\|");
/** Mermaid ids: the node's id, kept clear of Mermaid's own words. */
const mid = (id) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;

/** How each Lab page is titled on the page. */
const GRAPH_TITLES = Object.freeze({ texting: "Texting", nightly: "Nightly", search: "Search" });

/**
 * The drawing: one Mermaid flowchart per Lab page that has steps, each under its title, the texting graph first. A
 * page draws its own nodes and the wires among them (the schema refuses a wire across pages).
 */
export function drawingFor(config) {
  const pages = GRAPHS.filter((graph) => config.nodes.some((n) => graphOf(n) === graph));
  return pages
    .map((graph) => {
      const nodes = config.nodes.filter((n) => graphOf(n) === graph);
      const ids = new Set(nodes.map((n) => n.id));
      const edges = config.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
      return `### ${GRAPH_TITLES[graph] ?? graph}\n\n${flowchartFor(config, nodes, edges)}`;
    })
    .join("\n\n");
}

/** One Mermaid flowchart of `nodes` and `edges`, each group a subgraph. */
function flowchartFor(config, nodes, edges) {
  const lines = ["```mermaid", "flowchart LR"];
  const box = (n) => {
    const model = nodeModel(config, n);
    const effort = n.model !== "code" && n.effort ? ` · effort ${n.effort}` : "";
    const parts = [n.label, `${model}${effort}${n.on ? "" : " · off"}`];
    if (n.file) parts.push(n.file);
    const text = quote(parts.join("<br/>"));
    const cls = !n.on ? "off" : n.kind === "input" ? "start" : n.kind === "tool" ? "tool" : n.model === "code" ? "code" : "model";
    return n.kind === "input" ? `${mid(n.id)}(["${text}"]):::${cls}` : `${mid(n.id)}["${text}"]:::${cls}`;
  };
  const groups = new Map();
  for (const n of nodes) {
    if (!n.group) lines.push(`  ${box(n)}`);
    else groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
  }
  // Groups nest (Dev2, 2026-11-16): a group with a parent is drawn inside its parent's subgraph.
  const parentOf = (g) => config.groups?.[g]?.parent;
  for (const g of [...groups.keys()]) for (let up = parentOf(g), seen = 0; up && seen < 64; up = parentOf(up), seen++) if (!groups.has(up)) groups.set(up, []);
  const drawn = new Set();
  const subgraph = (group, depth) => {
    if (drawn.has(group)) return;
    drawn.add(group);
    const pad = "  ".repeat(depth);
    const title = config.groups?.[group]?.label ?? group;
    lines.push(`${pad}subgraph ${mid(`group_${group}`)}["${quote(title)}"]`);
    for (const n of groups.get(group)) lines.push(`${pad}  ${box(n)}`);
    for (const child of groups.keys()) if (parentOf(child) === group) subgraph(child, depth + 1);
    lines.push(`${pad}end`);
  };
  for (const group of groups.keys()) if (!parentOf(group) || !groups.has(parentOf(group))) subgraph(group, 1);
  for (const e of edges) {
    const mode = modeOf(e.mode);
    const tags = when(e);
    const kind = mode === "provisional" ? `${provisionalAs(e)}${unless(e)}` : mode === "generator" ? "starts a new run" : mode;
    const label = mode === "wait" ? tags : tags ? `${kind}: ${tags}` : kind;
    const arrow = MODES[e.mode]?.arrow ?? "-->";
    lines.push(`  ${mid(e.from)} ${arrow}${label ? `|${quote(label)}|` : ""} ${mid(e.to)}`);
  }
  lines.push(
    "  classDef start fill:#ffe3ee,stroke:#ff4f8b,color:#1d1838",
    "  classDef code fill:#dcf7f3,stroke:#11b5a4,color:#1d1838",
    "  classDef model fill:#ece5ff,stroke:#7b4dff,color:#1d1838",
    "  classDef tool fill:#fff0e2,stroke:#ff8a2a,color:#1d1838",
    "  classDef off fill:#eeeeee,stroke:#999999,color:#555555,stroke-dasharray:4 3",
    "```",
  );
  return lines.join("\n");
}

/** The steps table, as Markdown. */
export function tableFor(config) {
  const rows = config.nodes.map((n) => {
    const model = nodeModel(config, n);
    const effort = n.model === "code" ? "" : (n.effort ?? "");
    const limit = n.timeoutS > 0 ? `${n.timeoutS} s` : "";
    const reads = (n.ctx ?? []).join(", ");
    return `| ${cell(n.label)} | ${cell(n.id)} | ${cell(n.group ?? "")} | ${n.on ? "on" : "off"} | ${cell(model)} | ${effort} | ${limit} | ${cell(reads)} | ${cell(n.file ?? "")} |`;
  });
  const wires = config.edges.map((e) => `${e.from} → ${e.to} (${modeOf(e.mode)}${when(e) ? `, ${when(e)}` : ""}${unless(e)})`).join(" · ");
  return [
    "| Step | Id | Group | | Model | Effort | Time limit | Reads, in order | Where |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Wires: ${wires}`,
  ].join("\n");
}

/** The graph in words, as every Tex agent reads it: what each node does and where its wires go. */
export function mapFor(config) {
  const byId = new Map(config.nodes.map((n) => [n.id, n]));
  const name = (id) => byId.get(id)?.label ?? id;
  const out = (id, mode) => config.edges.filter((e) => e.from === id && modeOf(e.mode) === mode);
  const list = (edges) =>
    edges
      .map((e) => `${name(e.to)}${e.mode === "provisional" ? ` as a ${provisionalAs(e)}${unless(e)}` : ""}${when(e) ? ` (when ${when(e)})` : ""}`)
      .join("; ");
  const starts = config.nodes.filter((n) => n.kind === "input");
  const lines = [
    "Tex is a graph of steps (nodes) joined by wires, both read from Tex's config (texConfig.json), which is what runs. A step is code or one model call. A wire says what runs next and on what: \"then\" runs the next step on this one's output, only when its condition holds; \"may call\" lets a step call another and wait for the answer; \"may send work back to\" returns a draft for another try; \"may start as a background job\" starts work that reports later; \"afterwards, in the background\" runs once the text has gone, with nobody waiting.",
    "",
    `A turn starts at one of: ${starts.map((n) => n.label).join("; ")}.`,
    "",
  ];
  const groups = new Set();
  for (const n of config.nodes) {
    if (n.group && !groups.has(n.group)) {
      groups.add(n.group);
      const members = config.nodes.filter((m) => m.group === n.group).map((m) => m.label);
      const parent = config.groups?.[n.group]?.parent;
      const inside = parent ? `, inside ${config.groups?.[parent]?.label ?? parent}` : "";
      lines.push(`${config.groups?.[n.group]?.label ?? n.group} (a group of steps${inside}): ${members.join(", ")}.`);
    }
    const model = nodeModel(config, n);
    const head = `- ${n.label} (${model === "code" ? "code, no model" : model}${n.on ? "" : ", turned off: never runs"})`;
    lines.push(n.goal ? `${head}: ${n.goal}` : head);
    for (const mode of ["wait", "uses", "loop", "job", "background", "provisional", "generator"]) {
      const edges = out(n.id, mode);
      if (edges.length > 0) lines.push(`  ${MODES[mode].says}: ${list(edges)}`);
    }
  }
  return lines.join("\n");
}

/** The module's source for a config. */
export function moduleFor(config) {
  return [
    `// Generated by scripts/tex-architecture.mjs from ${CONFIG}. Do not edit: change the config and run the script.`,
    "",
    "/** Tex's graph in words, as every Tex agent reads it (`texArchitecture.js`). */",
    `export const TEX_MAP = ${JSON.stringify(mapFor(config))};`,
    "",
  ].join("\n");
}

/** `page` with the text between `<!-- tex-config: <name> begin -->` and `end -->` replaced by `body`. */
export function withRegion(page, name, body) {
  const begin = `<!-- tex-config: ${name} begin -->`;
  const end = `<!-- tex-config: ${name} end -->`;
  const start = page.indexOf(begin);
  const stop = page.indexOf(end);
  if (start === -1 || stop < start) throw new Error(`${PAGE}: no ${begin} ... ${end} region`);
  return `${page.slice(0, start)}${begin}\n${body}\n${page.slice(stop)}`;
}

/** The page with its drawing and its table made from the config. */
export function pageFor(page, config) {
  return withRegion(withRegion(page, "drawing", drawingFor(config)), "steps", tableFor(config));
}

const read = (root, path) => readFileSync(join(root, path), "utf8");

/** Where an architecture's own generated page lives: `docs/architecture/<page>.md`. */
export const ownPagePath = (entry) => `docs/architecture/${entry.page}.md`;

/**
 * An architecture's own page, whole, from its config alone (`architectures.cjs`): who runs it, its drawing and each
 * step's settings. A sibling of Tex's page, never part of it, because Tex's page is read into every Tex prompt.
 */
export function ownPageFor(entry, config = entry.config) {
  const nodes = config.nodes;
  const settings = nodes.flatMap((n) => Object.entries(n.settings ?? {}).map(([name, value]) => `| ${cell(n.label)} | \`${name}\` | ${value} |`));
  return [
    `# ${entry.label} architecture`,
    "",
    `<!-- Generated from ${entry.file} by node scripts/tex-architecture.mjs; edit the config (or the Lab's ${entry.label} page), never this page. -->`,
    "",
    cell(config.about ?? ""),
    "",
    `**Who runs it.** ${entry.runs}`,
    "",
    "## Drawing",
    "",
    flowchartFor({ models: {}, groups: {}, ...config }, nodes, config.edges),
    "",
    "## Steps",
    "",
    "| Step | Goal | Code |",
    "|---|---|---|",
    ...nodes.map((n) => `| ${cell(n.label)}${n.on ? "" : " (off)"} | ${cell(n.goal ?? "")} | ${cell(n.file ?? "")} |`),
    "",
    "## Settings",
    "",
    ...(settings.length ? ["| Step | Setting | Value |", "|---|---|---|", ...settings] : ["None."]),
    "",
  ].join("\n");
}

/** Everything stale or wrong between the config, the page and the module, for `tex-diagram-check.mjs`. */
export function generatedProblems(root = ROOT) {
  const config = readTexConfig(root);
  const problems = shapeProblems(config);
  if (problems.length > 0) return problems;
  if (pageFor(read(root, PAGE), config) !== read(root, PAGE)) problems.push(`${PAGE} is not what ${CONFIG} draws: run node scripts/tex-architecture.mjs`);
  if (moduleFor(config) !== read(root, MODULE)) problems.push(`${MODULE} is not what ${CONFIG} says: run node scripts/tex-architecture.mjs`);
  for (const entry of ARCHITECTURES) {
    let page = null;
    try {
      page = read(root, ownPagePath(entry));
    } catch {
      /* missing is stale */
    }
    if (page !== ownPageFor(entry)) problems.push(`${ownPagePath(entry)} is not what ${entry.file} draws: run node scripts/tex-architecture.mjs`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const problems = generatedProblems();
    for (const problem of problems) console.error(`tex-architecture: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log("tex-architecture: current");
  } else {
    const config = joinedTexConfig(ROOT);
    const problems = shapeProblems(config);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`tex-architecture: ${problem}`);
      process.exit(1);
    }
    writeFileSync(join(ROOT, PAGE), pageFor(read(ROOT, PAGE), config));
    writeFileSync(join(ROOT, MODULE), moduleFor(config));
    for (const entry of ARCHITECTURES) writeFileSync(join(ROOT, ownPagePath(entry)), ownPageFor(entry));
    console.log(`tex-architecture: wrote ${PAGE}, ${MODULE}${ARCHITECTURES.map((entry) => ` and ${ownPagePath(entry)}`).join("")}`);
  }
}
