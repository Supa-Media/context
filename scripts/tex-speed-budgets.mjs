#!/usr/bin/env node
/**
 * How long do people wait for Tex's first text? Read from production's own
 * timings, the `tex_text_timing` dataset the texting Worker writes for every
 * answered text (`apps/agent/src/textTiming.ts`: double5 is arrival to the
 * first bubble out), and red when a kind's median or p95 over the window is
 * over its bar or its target in `scripts/tex-speed-budgets.json`.
 *
 * Asked for by Dev2 on 2026-11-13: "do we have CI/CD about ... reply speed?
 * I've launched multiple campaigns to fix the speed of text, but the speed
 * keeps regressing", and "I'll wake up to CI/CD that we are maybe just not
 * hitting the target. That could be what we work towards fixing rather than
 * vibes." The replay budgets (`apps/mcp/test/replay/speed-budget.json`) count
 * the calls a turn makes before a pull request merges; this measures what a
 * person feels once it is live, which no test can.
 *
 * Two lines per kind. A **bar** is the measured wait plus headroom: over it,
 * Tex got slower than it was. A **target** is where Dev2 wants it: over it is
 * the work still to do. Both make the run red, and the report says which.
 *
 * Reads kinds, counts and milliseconds only: the dataset holds no number, no
 * chat and no words, and this prints none. The account id and token come from
 * the environment, never from this file.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const LIMITS = JSON.parse(readFileSync(new URL("./tex-speed-budgets.json", import.meta.url), "utf8"));

/** The dataset's kind for each budgeted name. */
const KIND = Object.freeze({ "1:1": "one", group: "group" });

/** Fewer answered texts than this in the window and a kind is shown, not judged. */
export const MIN_SAMPLES = 10;

const seconds = (ms) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/**
 * The verdict for each budgeted kind from the dataset's rows.
 *
 * @param {Array<{kind: string, n: number|string, p50: number, p95: number}>} rows
 */
export function judge(rows, limits = LIMITS, minSamples = MIN_SAMPLES) {
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  return Object.entries(limits.paths).map(([name, bar]) => {
    const row = byKind.get(KIND[name]);
    const target = limits.targets?.[name] ?? {};
    const n = Math.round(Number(row?.n ?? 0));
    const p50 = row ? Math.round(Number(row.p50)) : null;
    const p95 = row ? Math.round(Number(row.p95)) : null;
    const misses = [];
    if (n >= minSamples) {
      if (p50 > bar.p50Ms) misses.push(`median ${seconds(p50)} is over its bar of ${seconds(bar.p50Ms)}: slower than it was`);
      if (p95 > bar.p95Ms) misses.push(`p95 ${seconds(p95)} is over its bar of ${seconds(bar.p95Ms)}: slower than it was`);
      if (typeof target.p50Ms === "number" && p50 > target.p50Ms) misses.push(`median ${seconds(p50)} is short of the ${seconds(target.p50Ms)} target`);
      if (typeof target.p95Ms === "number" && p95 > target.p95Ms) misses.push(`p95 ${seconds(p95)} is short of the ${seconds(target.p95Ms)} target`);
    }
    const regressed = misses.some((miss) => miss.endsWith("slower than it was"));
    const verdict = n < minSamples ? "too few" : regressed ? "regressed" : misses.length > 0 ? "short of target" : "ok";
    return { name, n, p50, p95, bar, target, verdict, misses };
  });
}

/** The verdicts as a Markdown table, with the window named. */
export function report(verdicts, span) {
  const mark = { ok: "✅ ok", regressed: "❌ slower than its bar", "short of target": "❌ short of target", "too few": "— too few to judge" };
  const lines = [
    `### Tex reply speed, last ${span}: arrival to Tex's first text`,
    "",
    "| chat | median | p95 | bar (median / p95) | target (median / p95) | texts | verdict |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const v of verdicts) {
    lines.push(
      `| ${v.name} | ${seconds(v.p50)} | ${seconds(v.p95)} | ${seconds(v.bar.p50Ms)} / ${seconds(v.bar.p95Ms)} | ${seconds(v.target.p50Ms ?? null)} / ${seconds(v.target.p95Ms ?? null)} | ${v.n} | ${mark[v.verdict]} |`,
    );
  }
  const misses = verdicts.flatMap((v) => v.misses.map((miss) => `- ${v.name}: ${miss}`));
  if (misses.length > 0) lines.push("", ...misses);
  lines.push(
    "",
    "Bars and targets: `scripts/tex-speed-budgets.json`. Where the time goes per turn: `tex_timing` stages and `tex_model_calls` rounds. Calls a turn makes before the model: `apps/mcp/test/replay/speed-budget.json`.",
  );
  return lines.join("\n");
}

/** The Analytics Engine query: one row per kind, its median and p95 wait to the first text. */
export function query(dataset, minutes) {
  if (!/^[a-z_]+$/.test(dataset)) throw new Error("dataset must be lowercase letters and _");
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10080) throw new Error("minutes must be 5 to 10080");
  return `SELECT blob1 AS kind, SUM(_sample_interval) AS n,
    quantileWeighted(0.5)(double5, _sample_interval) AS p50,
    quantileWeighted(0.95)(double5, _sample_interval) AS p95
    FROM ${dataset}
    WHERE double5 >= 0 AND timestamp > NOW() - INTERVAL '${minutes}' MINUTE
    GROUP BY kind FORMAT JSON`;
}

async function main() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, GITHUB_STEP_SUMMARY: summary, REPORT_FILE: reportFile } = process.env;
  const dataset = process.env.DATASET || "tex_text_timing";
  const minutes = Number(process.env.MINUTES || 1440);
  if (!token || !account) {
    console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
    process.exit(2);
  }
  const answer = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: query(dataset, minutes),
  });
  if (!answer.ok) {
    console.error(`the timings query failed: ${answer.status}`);
    process.exit(2);
  }
  const { data } = await answer.json();
  const verdicts = judge(data ?? []);
  const span = minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
  const out = report(verdicts, span);
  console.log(out);
  if (summary) appendFileSync(summary, `${out}\n`);
  if (reportFile) appendFileSync(reportFile, `${out}\n`);
  const red = verdicts.filter((v) => v.verdict === "regressed" || v.verdict === "short of target");
  if (red.length > 0) {
    console.error(`red: ${red.map((v) => `${v.name} ${v.verdict}`).join("; ")}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
