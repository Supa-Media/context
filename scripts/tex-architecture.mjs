#!/usr/bin/env node
/**
 * TEX'S DRAWING, AND WHAT TEX IS TOLD ABOUT ITSELF, COME FROM TEX'S CONFIG (Dev2, 2026-11-14: the config is the source
 * of truth for what runs, and the connections between nodes are config, never code; "we do sort of ... give Tex the
 * context of its own structure").
 *
 * `packages/shared/src/texConfig.json` holds every node and every wire Tex runs. This script makes, from it alone:
 *
 *   1. the drawing in `docs/architecture/tex.md`, between `<!-- tex-config: drawing begin -->` and `end -->`: one
 *      Mermaid flowchart, a box per node (its group as a subgraph) and an arrow per wire, drawn by its mode;
 *   2. the steps table in the same page, between `<!-- tex-config: steps begin -->` and `end -->`;
 *   3. `apps/mcp/src/agent/texArchitecture.generated.js`: `TEX_MAP`, the same graph in words, which
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = "packages/shared/src/texConfig.json";
export const PAGE = "docs/architecture/tex.md";
export const MODULE = "apps/mcp/src/agent/texArchitecture.generated.js";

/**
 * Every wire mode the runner knows (`packages/shared/src/texGraph.cjs`), and how the page and the words say it.
 * `behind` is the old spelling of `background`, read the same until the config's rename lands everywhere.
 */
export const MODES = Object.freeze({
  wait: { arrow: "-->", says: "then" },
  uses: { arrow: "-.->", says: "may call" },
  background: { arrow: "-.->", says: "afterwards, in the background, nobody waiting" },
  behind: { arrow: "-.->", says: "afterwards, in the background, nobody waiting" },
  loop: { arrow: "==>", says: "may send work back to" },
  job: { arrow: "==>", says: "may start as a background job" },
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
const quote = (text) => String(text).replaceAll('"', "#quot;");
const cell = (text) => String(text).replaceAll("|", "\\|");
/** Mermaid ids: the node's id, kept clear of Mermaid's own words. */
const mid = (id) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;

/** The drawing: one Mermaid flowchart of every node and wire, each group a subgraph. */
export function drawingFor(config) {
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
  for (const n of config.nodes) {
    if (!n.group) lines.push(`  ${box(n)}`);
    else groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
  }
  for (const [group, members] of groups) {
    const title = config.groups?.[group]?.label ?? group;
    lines.push(`  subgraph ${mid(`group_${group}`)}["${quote(title)}"]`);
    for (const n of members) lines.push(`    ${box(n)}`);
    lines.push("  end");
  }
  for (const e of config.edges) {
    const mode = modeOf(e.mode);
    const tags = when(e);
    const label = mode === "wait" ? tags : tags ? `${mode}: ${tags}` : mode;
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
  const wires = config.edges.map((e) => `${e.from} → ${e.to} (${modeOf(e.mode)}${when(e) ? `, ${when(e)}` : ""})`).join(" · ");
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
  const list = (edges) => edges.map((e) => (when(e) ? `${name(e.to)} (when ${when(e)})` : name(e.to))).join("; ");
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
      lines.push(`${config.groups?.[n.group]?.label ?? n.group} (a group of steps): ${members.join(", ")}.`);
    }
    const model = nodeModel(config, n);
    const head = `- ${n.label} (${model === "code" ? "code, no model" : model}${n.on ? "" : ", turned off: never runs"})`;
    lines.push(n.goal ? `${head}: ${n.goal}` : head);
    for (const mode of ["wait", "uses", "loop", "job", "background"]) {
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

/** Everything stale or wrong between the config, the page and the module, for `tex-diagram-check.mjs`. */
export function generatedProblems(root = ROOT) {
  const config = JSON.parse(read(root, CONFIG));
  const problems = shapeProblems(config);
  if (problems.length > 0) return problems;
  if (pageFor(read(root, PAGE), config) !== read(root, PAGE)) problems.push(`${PAGE} is not what ${CONFIG} draws: run node scripts/tex-architecture.mjs`);
  if (moduleFor(config) !== read(root, MODULE)) problems.push(`${MODULE} is not what ${CONFIG} says: run node scripts/tex-architecture.mjs`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const problems = generatedProblems();
    for (const problem of problems) console.error(`tex-architecture: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log("tex-architecture: current");
  } else {
    const config = JSON.parse(read(ROOT, CONFIG));
    const problems = shapeProblems(config);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`tex-architecture: ${problem}`);
      process.exit(1);
    }
    writeFileSync(join(ROOT, PAGE), pageFor(read(ROOT, PAGE), config));
    writeFileSync(join(ROOT, MODULE), moduleFor(config));
    console.log(`tex-architecture: wrote ${PAGE} and ${MODULE}`);
  }
}
