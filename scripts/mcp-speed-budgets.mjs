#!/usr/bin/env node
/**
 * Is any MCP call slower than its bar? Read from production's (or staging's)
 * own timings, the `mcp_entry` dataset the gateway writes for every request
 * (`apps/mcp/src/mcp/mcpEntryPoint.js`), and red when a call's median
 * `to_response` (the whole request, at the server) crosses its budget.
 *
 * Asked for by Dev on 2026-11-03 ("some type of minimum bar we want for
 * reads, writes, orients, searches"), after a day of speed fixes with nothing
 * to stop them regressing. CI's own tests run against an in-memory store, so
 * they cannot measure this; production's timings can. The bars are measured
 * at the server, so the AI client's connector and the network, which add
 * 0.4 to 0.9 s we do not control, never count against them.
 *
 * The bars are today's medians plus headroom, not the goal: the goal is 100 ms
 * for each, and a bar comes down as each fix lands. Lowering one is the point;
 * raising one is a decision, said in the commit.
 *
 * A call with fewer than `MIN_SAMPLES` requests in the window is reported and
 * not judged: three slow requests at 4 a.m. are not a regression.
 *
 * Reads names and times only: the dataset holds no path and no words, and
 * this prints no workspace. The account id and token come from the
 * environment, never from this file.
 */

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Median `to_response` budget per call, in ms. The goal is 100 each. A speed fix lowers its call's bar in
 * the same change, to the measured median after it plus about 25% (Dev, 2026-11-03).
 */
export const BUDGETS = Object.freeze({
  "tools/call:fetch": 150,
  // A save names no action, so its calls are `tools/call:write` (`callOf`).
  // 250 -> 210 after #2820 (a new note's bytes and row in one call): 167 ms median.
  // 210 -> 130 after #2859, #2863 and #2864 (no tier write, the open beside the session, the checks in the create): 104 ms median.
  "tools/call:write": 130,
  // 250 -> 205 after #2806 (archive asks the object first, reading no body or history): about 165 ms median.
  // 205 -> 140 after #2850, #2899 and #2932 (no probe, the gateway beside the objects, one trip): 112 ms median.
  "tools/call:manage:archive": 140,
  // 400 -> 250 after #2825 and #2828 (no twin listing before a move the object makes): about 190 ms for 107 notes.
  // 250 -> 185 after #2844 (the object's move reads its rows by index, not by scanning them): 149 ms for 107 notes.
  // 185 -> 145 after #2899 (the gateway beside the objects): 114 ms median for 107 notes.
  "tools/call:manage:move_folder": 145,
  "tools/call:search": 800,
  // 900 -> 850 after #2834 and #2838 (faster key sort; each workspace draws its own map): 679 ms median.
  // 850 -> 600 after #2899 (the gateway beside the objects): about 480 ms median over the days since, 412 to 666 a day.
  "tools/call:orient": 600,
});

/** Fewer requests than this in the window and a call is shown, not judged. */
export const MIN_SAMPLES = 20;

/**
 * The verdict for each budgeted call from the dataset's rows.
 *
 * @param {Array<{call: string, n: number, p50_ms: number, p95_ms: number}>} rows
 * @param {Record<string, number>} budgets
 * @returns {Array<{call: string, budget: number, n: number, p50: number|null, p95: number|null, verdict: "ok"|"over"|"too few"}>}
 */
export function judge(rows, budgets = BUDGETS, minSamples = MIN_SAMPLES) {
  const byCall = new Map(rows.map((row) => [row.call, row]));
  return Object.entries(budgets).map(([call, budget]) => {
    const row = byCall.get(call);
    const n = Math.round(Number(row?.n ?? 0));
    const p50 = row ? Math.round(Number(row.p50_ms)) : null;
    const p95 = row ? Math.round(Number(row.p95_ms)) : null;
    const verdict = n < minSamples ? "too few" : p50 > budget ? "over" : "ok";
    return { call, budget, n, p50, p95, verdict };
  });
}

/** The verdicts as a Markdown table, with the window named. */
export function report(verdicts, span) {
  const lines = [
    `### MCP speed budgets, last ${span} (server-side median of the whole request)`,
    "",
    "| call | budget ms | p50 ms | p95 ms | requests | verdict |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const v of verdicts) {
    const mark = v.verdict === "over" ? "❌ over" : v.verdict === "ok" ? "✅ ok" : "— too few to judge";
    lines.push(`| ${v.call} | ${v.budget} | ${v.p50 ?? "—"} | ${v.p95 ?? "—"} | ${v.n} | ${mark} |`);
  }
  return lines.join("\n");
}

/** The Analytics Engine query: one row per budgeted call, its `to_response` median and p95. */
export function query(dataset, minutes, calls = Object.keys(BUDGETS)) {
  if (!/^[a-z_]+$/.test(dataset)) throw new Error("dataset must be lowercase letters and _");
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error("minutes must be 5 to 1440");
  for (const call of calls) if (!/^[a-z_/:]+$/.test(call)) throw new Error(`bad call name: ${call}`);
  const list = calls.map((call) => `'${call}'`).join(", ");
  return `SELECT blob2 AS call, SUM(_sample_interval) AS n,
    quantileWeighted(0.5)(double1, _sample_interval) AS p50_ms,
    quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms
    FROM ${dataset}
    WHERE blob1 = 'mcp' AND blob3 = 'to_response' AND blob4 = 'ok' AND blob2 IN (${list})
      AND timestamp > NOW() - INTERVAL '${minutes}' MINUTE
    GROUP BY call FORMAT JSON`;
}

async function main() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, GITHUB_STEP_SUMMARY: summary } = process.env;
  const dataset = process.env.DATASET || "mcp_entry";
  const minutes = Number(process.env.MINUTES || 60);
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
  const out = report(verdicts, `${minutes} min`);
  console.log(out);
  if (summary) appendFileSync(summary, `${out}\n`);
  const over = verdicts.filter((v) => v.verdict === "over");
  if (over.length > 0) {
    console.error(`over budget: ${over.map((v) => `${v.call} ${v.p50} ms > ${v.budget} ms`).join("; ")}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
