#!/usr/bin/env node
/**
 * TEX'S DRAWING CAN'T DRIFT FROM TEX'S CONFIG (Dev2, 2026-11-13: the Lab's config is "the only source of truth").
 *
 * `packages/shared/src/texConfig.json` is what Tex runs. This writes its steps table into `docs/architecture/tex.md`,
 * between `<!-- tex-config: steps begin -->` and `end -->`, and checks every model and effort the drawing's boxes
 * name against the step that runs it. The table sits after "## The rule", outside the part of the page every Tex
 * prompt carries (`tex-architecture-module.mjs`), so a promoted config changes the page without changing a prompt.
 *
 *   node scripts/tex-config-table.mjs           write the table
 *   node scripts/tex-config-table.mjs --check   fail when the table is stale or a box disagrees with the config
 *
 * `tex-diagram-check.mjs` runs the check in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = "packages/shared/src/texConfig.json";
export const PAGE = "docs/architecture/tex.md";
const BEGIN = "<!-- tex-config: steps begin -->";
const END = "<!-- tex-config: steps end -->";

/** How the drawing names each model family, from a gateway id. */
export function modelName(id) {
  const claude = /^anthropic\/claude-([a-z]+)-(\d+)-(\d+)$/.exec(id ?? "");
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  if (id === "@cf/cloudflare/clef") return "Clef";
  const glm = /^@cf\/zai-org\/glm-([\d.]+)-flash$/.exec(id ?? "");
  if (glm) return `GLM-${glm[1]} Flash`;
  return id ?? "code";
}

const cell = (text) => String(text).replaceAll("|", "\\|");

/** The steps table, as Markdown. */
export function tableFor(config) {
  const rows = config.nodes.map((n) => {
    const model = n.model === "code" ? "code" : modelName(config.models[n.model]);
    const effort = n.model === "code" ? "" : (n.effort ?? "");
    const limit = n.timeoutS > 0 ? `${n.timeoutS} s` : "";
    const reads = (n.ctx ?? []).join(", ");
    return `| ${cell(n.label)} | ${n.on ? "on" : "off"} | ${cell(model)} | ${effort} | ${limit} | ${cell(reads)} | ${cell(n.file)} |`;
  });
  const wires = config.edges.map((e) => `${e.from} → ${e.to} (${e.mode}${e.when.join() === "*" ? "" : `, ${e.when.join(", ")}`})`).join(" · ");
  return [
    BEGIN,
    `Generated from \`${CONFIG}\` by \`scripts/tex-config-table.mjs\`. Do not edit: change the config (the Lab's Promote) and run the script.`,
    "",
    "| Step | | Model | Effort | Time limit | Reads, in order | Where |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Wires: ${wires}`,
    END,
  ].join("\n");
}

/** The page with its table replaced, or added before the change log when it has none. */
export function pageWithTable(page, config) {
  const table = tableFor(config);
  const start = page.indexOf(BEGIN);
  const end = page.indexOf(END);
  if (start !== -1 && end > start) return page.slice(0, start) + table + page.slice(end + END.length);
  const log = page.indexOf("## Change log");
  if (log === -1) throw new Error(`${PAGE}: no "## Change log" to put the steps table before`);
  return `${page.slice(0, log)}## Every step, from Tex's config\n\n${table}\n\n${page.slice(log)}`;
}

/**
 * Boxes in the drawing that disagree with the config: a box whose label names a step's file (its first
 * file name) and says "effort <word>" or one model family must say the step's. Only boxes' labels are read, never
 * the words on an arrow.
 */
export function labelProblems(page, config) {
  const drawn = page.slice(page.indexOf("## 1. "), page.indexOf("## The rule"));
  const boxes = [...drawn.matchAll(/\b[A-Za-z]+(?:\["([^"]*)"\]|\(\[([^\]]*)\]\))/g)].map((m) => m[1] ?? m[2]);
  const problems = [];
  for (const n of config.nodes) {
    if (n.model === "code" || !n.on) continue;
    const file = /[A-Za-z0-9_]+\.(?:js|ts|cjs)/.exec(n.file ?? "")?.[0];
    if (!file) continue;
    const name = modelName(config.models[n.model]);
    const family = /^[A-Za-z]+/.exec(name)?.[0];
    for (const box of boxes.filter((line) => new RegExp(`(^|[^A-Za-z0-9_])${file.replace(".", "\\.")}`).test(line))) {
      const effort = /effort (\w+)/.exec(box)?.[1];
      if (effort !== undefined && effort !== n.effort) problems.push(`${PAGE} draws ${file} at effort ${effort}; Tex's config runs step "${n.id}" at ${n.effort}`);
      const families = [...box.matchAll(/\b(Haiku|Sonnet|Opus|GLM|Clef)\b/g)].map((m) => m[1]);
      if (families.length === 1 && families[0] !== family) problems.push(`${PAGE} draws ${file} on ${families[0]}; Tex's config runs step "${n.id}" on ${name}`);
    }
  }
  return problems;
}

/** Everything wrong between the page and the config, for `tex-diagram-check.mjs`. */
export function configProblems(root = ROOT) {
  const page = readFileSync(join(root, PAGE), "utf8");
  const config = JSON.parse(readFileSync(join(root, CONFIG), "utf8"));
  const problems = labelProblems(page, config);
  if (pageWithTable(page, config) !== page) problems.push(`${PAGE}'s steps table is not what ${CONFIG} makes: run node scripts/tex-config-table.mjs`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const problems = configProblems();
    for (const problem of problems) console.error(`tex-config-table: ${problem}`);
    if (problems.length > 0) process.exit(1);
    console.log("tex-config-table: current");
  } else {
    const page = readFileSync(join(ROOT, PAGE), "utf8");
    writeFileSync(join(ROOT, PAGE), pageWithTable(page, JSON.parse(readFileSync(join(ROOT, CONFIG), "utf8"))));
    console.log(`tex-config-table: wrote ${PAGE}`);
  }
}
