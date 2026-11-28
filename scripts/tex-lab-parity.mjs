#!/usr/bin/env node
/**
 * PARITY BETWEEN THE LAB SANDBOX'S BENCH RUN AND THE GITHUB RUN (plan `products/tex/research/
 * sandbox-bench-scoring-2026-11-19.md`). Both runners walk the same Front door ("fd") unit tests of the same
 * conversations (`packages/lab/src/labRunSets.mjs` `benchUnits`) and report results in the same shape (`resultsOf` in
 * `scripts/tex-lab-run.mjs`). This file answers two questions without calling any model or network service:
 *
 *   node scripts/tex-lab-parity.mjs --estimate [--set training|dev] [--repeats 3] [--tex-model M] [--tex-input-tokens N]
 *                                   [--tex-output-tokens N] [--judge-input-tokens N] [--judge-output-tokens N]
 *                                                             what a parity check costs, per side, before it runs
 *   node scripts/tex-lab-parity.mjs --sandbox <file> --github <file> [--json]
 *                                                             whether two finished runs agree within their noise bands
 *
 * A run file may be `tex_dev runs { id }`'s `{ status: "ok", run: {...} }`, `{ run: {...} }`, a run object with
 * `results`, or a bare results object. Standard output says counts, ids and numbers only.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DEFAULT_JUDGE, DEFAULT_VOTES } from "../apps/mcp/bench/judge.mjs";
import { priceUsd } from "../apps/mcp/bench/report.mjs";
import { benchUnits, notWords, runConversations } from "../packages/lab/src/labRunSets.mjs";

const requireHere = createRequire(import.meta.url);
const { repeatsOf } = requireHere("../packages/lab/src/texRunBand.cjs");
const REPO = fileURLToPath(new URL("../packages/lab/src/texSetsRepo.generated.json", import.meta.url));

/** The assumptions an estimate states unless told otherwise (a turn is one Tex reply; a call is one judge question). */
export const DEFAULT_TEX = { model: "claude-sonnet-5-5", input: 30_000, output: 1_500 };
export const DEFAULT_JUDGE_USAGE = { input: 6_000, output: 600 };
const MAX_LIST = 50;

/** Why a unit's message is out of the sandbox's reach, or null when it is texted words (`labRunSets.mjs` `notWords`). */
export function sandboxCannotWhy(conv, unit) {
  return notWords(Array.isArray(conv?.msgs) ? conv.msgs[unit.at] : undefined);
}

const usdOf = (model, input, output, calls) => {
  const each = priceUsd(model, { input, output });
  return each === null ? null : each * calls;
};
const sumUsd = (a, b) => (a === null || b === null ? null : a + b);

/**
 * What a parity check costs before it runs: the units of the set (Front door tests, once per repeat as a run walks
 * them), how many the sandbox can run, and per side the expected Tex turns, judge calls and dollars. No model call.
 */
export function estimateParity({ set = "training", repeats = 3, repo, drafts = [], tex = DEFAULT_TEX, judge = DEFAULT_JUDGE_USAGE } = {}) {
  const n = repeatsOf(repeats);
  if (n === null) throw new Error("repeats must be an integer from 1 to 5");
  const convs = runConversations(set, repo, drafts);
  const units = benchUnits(convs, 1);
  const byReason = {};
  let runnable = 0;
  for (const unit of units) {
    const conv = convs.find((c) => c.id === unit.chat);
    const why = sandboxCannotWhy(conv, unit);
    if (why === null) runnable += 1;
    else byReason[why] = (byReason[why] ?? 0) + 1;
  }
  const judgeModel = judge.model ?? DEFAULT_JUDGE;
  const side = (count) => {
    const turns = count * n;
    const judgeCalls = turns * DEFAULT_VOTES;
    const texUsd = usdOf(tex.model, tex.input, tex.output, turns);
    const judgeUsd = usdOf(judgeModel, judge.input, judge.output, judgeCalls);
    return { turns, judgeCalls, texUsd, judgeUsd, totalUsd: sumUsd(texUsd, judgeUsd) };
  };
  const sandbox = side(runnable);
  const github = side(units.length);
  const total = {
    turns: sandbox.turns + github.turns,
    judgeCalls: sandbox.judgeCalls + github.judgeCalls,
    texUsd: sumUsd(sandbox.texUsd, github.texUsd),
    judgeUsd: sumUsd(sandbox.judgeUsd, github.judgeUsd),
    totalUsd: sumUsd(sandbox.totalUsd, github.totalUsd),
  };
  return {
    set,
    conversations: convs.length,
    units: units.length,
    sandboxRunnable: runnable,
    sandboxCannot: { total: units.length - runnable, byReason },
    repeats: n,
    assumptions: {
      tex: { model: tex.model, input: tex.input, output: tex.output },
      judge: { model: judgeModel, input: judge.input, output: judge.output, votes: DEFAULT_VOTES },
    },
    sides: { sandbox, github, total },
  };
}

const money = (v) => (v === null || v === undefined ? "unknown (no price)" : `$${v.toFixed(4)}`);

/** The estimate as plain text, one fact per line. */
export function estimateText(e) {
  const a = e.assumptions;
  const lines = [
    "Tex parity estimate (no model call made)",
    `assumptions: Tex ${a.tex.model}, ${a.tex.input} input and ${a.tex.output} output tokens a turn`,
    `assumptions: judge ${a.judge.model}, ${a.judge.input} input and ${a.judge.output} output tokens a call, ${a.judge.votes} votes a judged question`,
    `set: ${e.set} (the repo's conversations, no Lab drafts)`,
    `conversations: ${e.conversations}`,
    `front door units: ${e.units}`,
    `sandbox can run (words only): ${e.sandboxRunnable}`,
    `sandbox cannot run: ${e.sandboxCannot.total}`,
    ...Object.entries(e.sandboxCannot.byReason)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([why, count]) => `  ${why}: ${count}`),
    `repeats: ${e.repeats}`,
  ];
  for (const [name, s] of [
    ["sandbox", e.sides.sandbox],
    ["github", e.sides.github],
    ["total", e.sides.total],
  ]) {
    lines.push(
      `${name}: expected Tex turns ${s.turns}, judge calls ${s.judgeCalls}, Tex ${money(s.texUsd)}, judge ${money(s.judgeUsd)}, total ${money(s.totalUsd)}`,
    );
  }
  return lines.join("\n");
}

/** A run file's results object and commit: accepts the shapes listed in the header. */
export function resultsFrom(file) {
  let o = file && typeof file === "object" ? file : null;
  const commit = [o?.commit, o?.run?.commit].find((c) => typeof c === "string" && c !== "") ?? null;
  if (o?.run && typeof o.run === "object") o = o.run;
  if (o?.results && typeof o.results === "object") o = o.results;
  const results = o && typeof o === "object" && (o.score || typeof o.pass === "number") ? o : null;
  return { results, commit: commit ?? (typeof results?.commit === "string" ? results.commit : null) };
}

/** The noise range of a score: (max - min) over total, from one side's band. */
const rangeOf = (min, max, total) => (total > 0 ? (max - min) / total : 0);

const repeatsOfResults = (r) => (r?.score?.repeats ?? r?.repeats ?? 1);

/** A rate metric: both sides' rates, the delta, the noise, and whether the delta is inside it. */
function rateMetric(metric, sRate, gRate, noise) {
  const delta = sRate - gRate;
  return { metric, sandbox: round(sRate), github: round(gRate), delta: round(delta), noise: round(noise), withinNoise: Math.abs(delta) <= noise + 1e-9 };
}

const round = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1e6) / 1e6 : x);

/** Rows keyed as a unit is: `convId|msgIndex|node`. Only the rows a side counted (not `ran: false`, not ambiguous). */
const keyOf = (r) => `${r.convId}|${r.msgIndex}|${r.node}`;
const countedRows = (rows) => new Map((Array.isArray(rows) ? rows : []).filter((r) => r.ran !== false && !r.ambiguous).map((r) => [keyOf(r), r]));

/** Unit-level agreement: how many units both sides counted agree on `ok`, the disagreeing units, and the one-side units. */
function rowsOf(s, g) {
  const sr = countedRows(s.rows);
  const gr = countedRows(g.rows);
  const shared = [...sr.keys()].filter((k) => gr.has(k));
  const disagree = [];
  let agree = 0;
  for (const k of shared) {
    const a = sr.get(k);
    const b = gr.get(k);
    if (Boolean(a.ok) === Boolean(b.ok)) {
      agree += 1;
      continue;
    }
    if (disagree.length < MAX_LIST) {
      disagree.push({
        unit: k,
        sandbox: { ok: Boolean(a.ok), passes: a.passes ?? (a.ok ? 1 : 0), runs: a.runs ?? 1 },
        github: { ok: Boolean(b.ok), passes: b.passes ?? (b.ok ? 1 : 0), runs: b.runs ?? 1 },
      });
    }
  }
  const onlySandbox = [...sr.keys()].filter((k) => !gr.has(k));
  const onlyGithub = [...gr.keys()].filter((k) => !sr.has(k));
  return {
    shared: shared.length,
    agree,
    disagree: { count: shared.length - agree, units: disagree },
    onlySandbox: { count: onlySandbox.length, units: onlySandbox.slice(0, MAX_LIST) },
    onlyGithub: { count: onlyGithub.length, units: onlyGithub.slice(0, MAX_LIST) },
  };
}

/**
 * Compares two finished runs' results objects (`resultsOf` shape, already unwrapped; `commit` read from the run files).
 * Returns `{ metrics, rows, verdict, notes }`; `verdict` is "within noise", "outside noise" (naming the metrics that
 * are not), or "not comparable". Noise is the larger of the two sides' bands; with one repeat on either side it is 0.
 */
export function compareParity(s, g, { sandboxCommit = null, githubCommit = null } = {}) {
  const notes = [];
  const missing = [];
  if (!s?.score || !(s.score.total > 0)) missing.push("sandbox");
  if (!g?.score || !(g.score.total > 0)) missing.push("github");
  if (missing.length > 0) {
    return { metrics: [], rows: null, verdict: "not comparable", notes: [`${missing.join(" and ")} has no results with tests counted`] };
  }
  if (sandboxCommit && githubCommit && sandboxCommit !== githubCommit) {
    return { metrics: [], rows: null, verdict: "not comparable", notes: ["the runs are on different commits: parity needs the same commit"] };
  }
  if (!sandboxCommit || !githubCommit) notes.push("a run file has no commit: the commit check could not run on both sides");
  const sConv = new Map((s.perConv ?? []).map((c) => [c.id, c]));
  const gConv = new Map((g.perConv ?? []).map((c) => [c.id, c]));
  const sharedConvs = [...sConv.keys()].filter((id) => gConv.has(id));
  if (sharedConvs.length === 0) {
    return { metrics: [], rows: null, verdict: "not comparable", notes: ["the runs share no conversations: they are on different sets"] };
  }
  const repeatsOK = repeatsOfResults(s) >= 2 && repeatsOfResults(g) >= 2;
  if (!repeatsOK) notes.push("repeats are needed: with one repeat on either side the noise is 0, so any difference counts");
  const noiseOf = (sr, gr) => (repeatsOK ? Math.max(sr, gr) : 0);

  const sRange = rangeOf(s.score.min, s.score.max, s.score.total);
  const gRange = rangeOf(g.score.min, g.score.max, g.score.total);
  const metrics = [];
  metrics.push(rateMetric("overall pass rate", s.score.mean / s.score.total, g.score.mean / g.score.total, noiseOf(sRange, gRange)));
  for (const id of sharedConvs) {
    const a = sConv.get(id);
    const b = gConv.get(id);
    if (!(a.total > 0) || !(b.total > 0)) continue;
    const sr = rangeOf(a.min ?? a.pass, a.max ?? a.pass, a.total);
    const gr = rangeOf(b.min ?? b.pass, b.max ?? b.pass, b.total);
    metrics.push(rateMetric(`conv ${id} pass rate`, a.pass / a.total, b.pass / b.total, noiseOf(sr, gr)));
  }
  const sFall = Number(s.fallbacks ?? 0) || 0;
  const gFall = Number(g.fallbacks ?? 0) || 0;
  metrics.push({ metric: "fallbacks", sandbox: sFall, github: gFall, delta: sFall - gFall, noise: null, withinNoise: sFall === gFall });
  const sCnr = (s.couldNotRun ?? []).length;
  const gCnr = (g.couldNotRun ?? []).length;
  metrics.push({ metric: "couldNotRun", sandbox: sCnr, github: gCnr, delta: sCnr - gCnr, noise: null, withinNoise: sCnr === gCnr });
  const sValid = s.valid === true;
  const gValid = g.valid === true;
  metrics.push({ metric: "valid", sandbox: sValid, github: gValid, delta: sValid === gValid, noise: null, withinNoise: sValid === gValid });
  metrics.push({ metric: "costUsd", sandbox: round(Number(s.costUsd ?? 0)), github: round(Number(g.costUsd ?? 0)), delta: round(Number(s.costUsd ?? 0) - Number(g.costUsd ?? 0)), noise: null, withinNoise: null });
  metrics.push({ metric: "total counted", sandbox: s.score.total, github: g.score.total, delta: s.score.total - g.score.total, noise: null, withinNoise: s.score.total === g.score.total });

  // The verdict's gate: the pass rates, no fallback on either side, and both runs valid.
  const outside = metrics.filter((m) => /pass rate$/.test(m.metric) && m.withinNoise === false).map((m) => m.metric);
  if (sFall > 0 || gFall > 0) outside.push("fallbacks");
  if (!(sValid && gValid)) outside.push("valid");
  const verdict = outside.length === 0 ? "within noise" : `outside noise: ${outside.join(", ")}`;
  if (!repeatsOK && outside.length === 0) notes.push("within noise with no band: the runs had one repeat, so this is not a claim of parity");

  return { metrics, rows: rowsOf(s, g), verdict, notes };
}

const fmt = (v) => (typeof v === "boolean" ? String(v) : v === null || v === undefined ? "n/a" : String(v));

/** The comparison as plain text for the printed report. */
export function parityText(cmp) {
  const lines = [];
  lines.push(`verdict: ${cmp.verdict}`);
  for (const note of cmp.notes ?? []) lines.push(`note: ${note}`);
  for (const m of cmp.metrics ?? []) {
    const noise = m.noise === null || m.noise === undefined ? "" : `, noise ${fmt(m.noise)}`;
    const within = m.withinNoise === null || m.withinNoise === undefined ? "" : `, ${m.withinNoise ? "within" : "outside"}`;
    lines.push(`${m.metric}: sandbox ${fmt(m.sandbox)}, github ${fmt(m.github)}, delta ${fmt(m.delta)}${noise}${within}`);
  }
  if (cmp.rows) {
    const r = cmp.rows;
    lines.push(`units both counted: ${r.shared}, agree on ok: ${r.agree}, disagree: ${r.disagree.count}`);
    for (const d of r.disagree.units) {
      lines.push(`  disagree ${d.unit}: sandbox ${d.sandbox.passes}/${d.sandbox.runs}, github ${d.github.passes}/${d.github.runs}`);
    }
    lines.push(`units only the sandbox counted: ${r.onlySandbox.count}${r.onlySandbox.units.length ? ` (${r.onlySandbox.units.join(", ")})` : ""}`);
    lines.push(`units only GitHub counted: ${r.onlyGithub.count}${r.onlyGithub.units.length ? ` (${r.onlyGithub.units.join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

const USAGE = `usage:
  node scripts/tex-lab-parity.mjs --estimate [--set training|dev] [--repeats 3] [--tex-model M] [--tex-input-tokens N]
      [--tex-output-tokens N] [--judge-input-tokens N] [--judge-output-tokens N]
  node scripts/tex-lab-parity.mjs --sandbox <file> --github <file> [--json]`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return { error: `unexpected argument ${a}` };
    const key = a.slice(2);
    if (key === "estimate" || key === "json") {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `--${key} needs a value` };
    out[key] = value;
    i += 1;
  }
  return { options: out };
}

const intOf = (v, fallback) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

function readRun(path) {
  return resultsFrom(JSON.parse(readFileSync(path, "utf8")));
}

async function main(argv) {
  const { options, error } = parseArgs(argv);
  if (error) {
    console.error(error);
    console.error(USAGE);
    return 1;
  }
  if (options.estimate) {
    const set = options.set ?? "training";
    if (set !== "training" && set !== "dev") {
      console.error(USAGE);
      return 1;
    }
    const repeats = options.repeats === undefined ? 3 : Number(options.repeats);
    const tokens = [intOf(options["tex-input-tokens"], DEFAULT_TEX.input), intOf(options["tex-output-tokens"], DEFAULT_TEX.output), intOf(options["judge-input-tokens"], DEFAULT_JUDGE_USAGE.input), intOf(options["judge-output-tokens"], DEFAULT_JUDGE_USAGE.output)];
    if (tokens.includes(null) || repeatsOf(repeats) === null) {
      console.error(USAGE);
      return 1;
    }
    const repo = JSON.parse(readFileSync(REPO, "utf8")).sets;
    const e = estimateParity({
      set,
      repeats,
      repo,
      tex: { model: options["tex-model"] ?? DEFAULT_TEX.model, input: tokens[0], output: tokens[1] },
      judge: { model: DEFAULT_JUDGE, input: tokens[2], output: tokens[3] },
    });
    console.log(estimateText(e));
    return 0;
  }
  if (options.sandbox && options.github) {
    const a = readRun(options.sandbox);
    const b = readRun(options.github);
    const cmp = compareParity(a.results, b.results, { sandboxCommit: a.commit, githubCommit: b.commit });
    console.log(options.json ? JSON.stringify(cmp, null, 2) : parityText(cmp));
    return 0;
  }
  console.error(USAGE);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
