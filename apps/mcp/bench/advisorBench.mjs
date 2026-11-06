#!/usr/bin/env node
/**
 * THE ADVISOR-FIRST COMPARISON (Dev2, 2026-11-06: "bench first, then a flagged build").
 *
 * Three setups answer `tests/advisor.md` (single texts, and case 6, a stretch
 * of five), each from the live setup with only its models and flags changed:
 *
 *   advisor-a-router     today's router: a text it flags runs whole on `think` (Opus)
 *   advisor-b-first      `advisor_first: on`: every text on `main` (Haiku), Opus only as the advisor
 *   advisor-c-rung       b plus `effort_rung: high`: a flagged or sent-back text thinks harder on Haiku
 *
 * `node bench/advisorBench.mjs setups --dir <folder>` writes them into
 * `<folder>/setups/texting-assistant/` from the `production.md` that
 * `pnpm ai pull texting-assistant` put there. The setups folder is never
 * committed (`.gitignore`), so the three are made from the live setup each
 * time instead of copied. The result note's "Advisor first" lines
 * (`advisorLines`, called by `report.mjs`) are what the comparison reads.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSetup } from "../src/agent/production.js";
import { ROUTER_MODEL } from "../src/agent/router.js";
import { priceUsd } from "./report.mjs";

const OPUS = "anthropic/claude-opus-5-5";
const JOB = "texting-assistant";

/** Each setup's changes to the live one: model lines under `models:`, and top-level lines. */
export const ADVISOR_SETUPS = Object.freeze({
  "advisor-a-router": { models: { router: ROUTER_MODEL, think: OPUS }, top: {} },
  "advisor-b-first": { models: { router: ROUTER_MODEL, think: OPUS }, top: { advisor_first: "on" } },
  "advisor-c-rung": { models: { router: ROUTER_MODEL, think: OPUS }, top: { advisor_first: "on", effort_rung: "high" } },
});

/**
 * `raw` (a setup file) with `models` lines set under `models:` and `top`
 * lines set at the top level, each replacing a line of the same key. An
 * advisor is added when the file names none: advisor first needs one.
 */
export function withChanges(raw, { models, top }) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error("the setup has no front matter");
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^models:\s*$/.test(line));
  if (at < 0) throw new Error("the setup has no models section");
  let end = at + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;
  const section = lines.slice(at + 1, end);
  const set = { ...(section.some((line) => /^\s+advisor:/.test(line)) ? {} : { advisor: OPUS }), ...models };
  const kept = section.filter((line) => !Object.keys(set).some((key) => new RegExp(`^\\s+${key}:`).test(line)));
  const other = (line) => !Object.keys(top).some((key) => new RegExp(`^${key}:`).test(line));
  const front = [...lines.slice(0, at).filter(other), "models:", ...kept, ...Object.entries(set).map(([key, value]) => `  ${key}: ${value}`), ...lines.slice(end).filter(other), ...Object.entries(top).map(([key, value]) => `${key}: ${value}`)];
  return `---\n${front.join("\n")}\n---${raw.slice(match[0].length)}`;
}

/** Writes the three setups beside `production.md`; refuses one the product would refuse. */
export async function writeAdvisorSetups(dir) {
  const folder = join(dir, "setups", JOB);
  const live = await readFile(join(folder, "production.md"), "utf8");
  const written = [];
  for (const [name, changes] of Object.entries(ADVISOR_SETUPS)) {
    const raw = withChanges(live, changes);
    if ((await parseSetup(raw)) === null) throw new Error(`${name} would not be a valid setup`);
    await writeFile(join(folder, `${name}.md`), raw);
    written.push(name);
  }
  return written;
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const secs = (ms) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const usd = (v) => `$${v.toFixed(4)}`;
const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "n/a");

/**
 * The comparison's numbers for one setup's runs: time to each text (p50,
 * p95; the bench sends no text before the answer unless a progress line
 * went, so this is each turn's time), cost per text with Opus apart, the
 * share of input read from the cache per model, and how often a text asked
 * the advisor and how often it declined. Pass rate is the score's
 * (`pnpm ai score`), never counted here.
 */
export function advisorStats(runs) {
  const turnMs = runs.flatMap((run) => run.turnMs ?? []);
  const texts = runs.reduce((sum, run) => sum + (run.turnMs?.length ?? 0), 0);
  let opus = 0;
  let rest = 0;
  const cache = {};
  for (const run of runs) {
    for (const [model, usage] of Object.entries(run.usageByModel ?? {})) {
      const price = priceUsd(model, usage) ?? 0;
      if (model.endsWith("claude-opus-5-5")) opus += price;
      else rest += price;
      const into = (cache[model] ??= { read: 0, all: 0 });
      into.read += usage.cacheRead ?? 0;
      into.all += (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    }
  }
  const sum = (key) => runs.reduce((total, run) => total + (run.advice?.[key] ?? 0), 0);
  return {
    texts,
    p50: percentile(turnMs, 50),
    p95: percentile(turnMs, 95),
    opusPerText: texts ? opus / texts : 0,
    restPerText: texts ? rest / texts : 0,
    cache: Object.fromEntries(Object.entries(cache).map(([model, { read, all }]) => [model, all > 0 ? read / all : 0])),
    askedTexts: sum("askedTexts"),
    asks: sum("asks"),
    declined: sum("declined"),
    rungs: sum("rungTexts"),
  };
}

/**
 * What one conversation's turn traces say about the advisor, kept on its
 * record (`run.mjs`), since the traces themselves go to the ledger file.
 */
export function adviceOf(traces) {
  const asked = (entry) => entry?.kind === "tool" && entry.tool === "ask_advisor";
  const asks = traces.flat().filter(asked);
  return {
    asks: asks.length,
    declined: asks.filter((entry) => entry.declined === true).length,
    askedTexts: traces.filter((trace) => trace.some(asked)).length,
    rungTexts: traces.filter((trace) => trace.some((entry) => entry?.kind === "model" && typeof entry.rung === "string")).length,
  };
}

/** The result note's "Advisor first" lines, one per setup, for the advisor test only. */
export function advisorLines(test, setups, runs) {
  if (test !== "advisor") return [];
  const lines = [];
  for (const setup of setups) {
    const s = advisorStats(runs.filter((run) => run.setup === setup.name && !run.error));
    const cache = Object.entries(s.cache).map(([model, share]) => `${model} ${pct(share, 1)}`).join(", ") || "n/a";
    lines.push(
      `Advisor first: ${setup.name}, ${s.texts} texts: time to a text p50 ${secs(s.p50)}, p95 ${secs(s.p95)}; per text ${usd(s.restPerText + s.opusPerText)} (Opus ${usd(s.opusPerText)}, the rest ${usd(s.restPerText)}); ` +
        `cache read share ${cache}; asked the advisor on ${s.askedTexts} texts (${pct(s.askedTexts, s.texts)}), ${s.asks} asks, ${s.declined} declined (${pct(s.declined, s.asks)}); effort rung on ${s.rungs} texts.`,
      "",
    );
  }
  return lines;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : null;
if (entry === fileURLToPath(import.meta.url)) {
  const [command, flag, dir] = process.argv.slice(2);
  if (command !== "setups" || flag !== "--dir" || !dir) {
    process.stderr.write("usage: node bench/advisorBench.mjs setups --dir <benchmarks folder>\n");
    process.exit(2);
  }
  const written = await writeAdvisorSetups(dir);
  process.stdout.write(`wrote ${written.join(", ")} in ${join(dir, "setups", JOB)}\n`);
}
