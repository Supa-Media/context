#!/usr/bin/env node
/**
 * Tex's speed and cache report, from the gateway's Analytics Engine datasets
 * (`src/agent/turnStages.js`): `tex_model_calls`, one point per model call
 * (blob1 the turn's kind, blob2 the model, blob3 ok or failed, blob4 the turn
 * id, never read here; doubles in `CALL_COLUMNS` order), and `tex_timing`, one
 * point per turn (doubles in `COLUMNS` order). Aggregates only: no turn id, no
 * workspace, no word. Run by `.github/workflows/tex-speed.yml`.
 *
 *   node apps/mcp/bench/texSpeed.mjs query calls <dataset> <days> first|later
 *   node apps/mcp/bench/texSpeed.mjs query turns <dataset> <days>
 *     prints the SQL for the account's Analytics Engine SQL API
 *   node apps/mcp/bench/texSpeed.mjs report <first.json> <later.json> [turns.json]
 *     prints the Markdown tables from the API's JSON answers
 *
 * Cache read share = cacheRead / (input + cacheRead + cacheWrite): the share of
 * the prompt that was read from the cache.
 *
 * `tex_carry` is in no dataset: `readTheHistory.js` logs it as a line
 * (`{"event":"tex_carry",...}`), and `turnStages.js` puts the same counts on
 * the `turn_stages` line. Read it with `npx wrangler tail <gateway worker>
 * --format json --search tex_carry` (live), or in the dashboard's Workers
 * Logs, filtered on `event = tex_carry`.
 */

import { readFileSync } from "node:fs";
import { CALL_COLUMNS, COLUMNS } from "../src/agent/turnStages.js";

/** The SQL `doubleN` holding a named column (Analytics Engine counts from 1). */
const double = (columns, name) => `double${columns.indexOf(name) + 1}`;
const call = (name) => double(CALL_COLUMNS, name);
const turn = (name) => double(COLUMNS, name);
const DAY = "formatDateTime(toStartOfDay(timestamp), '%Y-%m-%d')";

/** The SQL for one report table. `days` and `dataset` are checked here, since they go into the query. */
export function query(what, dataset, days, round = "first") {
  if (!/^[a-z_]{1,64}$/.test(dataset)) throw new Error("dataset must be lowercase letters and _");
  if (!/^\d{1,2}$/.test(String(days)) || Number(days) < 1 || Number(days) > 90) throw new Error("days must be 1 to 90");
  const since = `timestamp > NOW() - INTERVAL '${Number(days)}' DAY`;
  if (what === "turns") {
    return `SELECT ${DAY} AS day, blob1 AS kind, SUM(_sample_interval) AS n,
      quantileWeighted(0.5)(${turn("totalMs")}, _sample_interval) AS p50,
      quantileWeighted(0.95)(${turn("totalMs")}, _sample_interval) AS p95,
      SUM(${turn("rounds")} * _sample_interval) / SUM(_sample_interval) AS rounds
      FROM ${dataset} WHERE ${since} GROUP BY day, kind ORDER BY day, kind LIMIT 500 FORMAT JSON`;
  }
  if (what !== "calls" || (round !== "first" && round !== "later")) throw new Error("query calls <dataset> <days> first|later, or query turns <dataset> <days>");
  return `SELECT ${DAY} AS day, blob1 AS kind, '${round}' AS round, SUM(_sample_interval) AS n,
    SUM(${call("input")} * _sample_interval) AS input,
    SUM(${call("cacheRead")} * _sample_interval) AS cacheRead,
    SUM(${call("cacheWrite")} * _sample_interval) AS cacheWrite,
    quantileWeighted(0.5)(${call("ms")}, _sample_interval) AS p50,
    quantileWeighted(0.95)(${call("ms")}, _sample_interval) AS p95
    FROM ${dataset} WHERE ${since} AND ${call("round")} ${round === "first" ? "= 1" : "> 1"}
    GROUP BY day, kind ORDER BY day, kind LIMIT 500 FORMAT JSON`;
}

const word = (value) => String(value ?? "").replace(/[^a-z0-9_:-]/gi, "").slice(0, 32) || "-";
const whole = (value) => String(Math.round(Number(value) || 0));
const share = (row) => {
  const prompt = Number(row.input) + Number(row.cacheRead) + Number(row.cacheWrite);
  return prompt > 0 ? `${Math.round((100 * Number(row.cacheRead)) / prompt)}%` : "-";
};

/** The report's Markdown, from the API's `data` rows: model calls (first and later rounds together), and turns when given. */
export function report(callRows, turnRows = null) {
  const sorted = [...callRows].sort((a, b) => `${a.day} ${a.kind} ${a.round}`.localeCompare(`${b.day} ${b.kind} ${b.round}`));
  const out = ["### Model calls, per day and chat kind", "", "Cache read share = cache reads / (input + cache reads + cache writes).", "", "| day | kind | round | calls | cache read share | p50 ms | p95 ms |", "| --- | --- | --- | ---: | ---: | ---: | ---: |"];
  for (const row of sorted) out.push(`| ${word(row.day)} | ${word(row.kind)} | ${word(row.round)} | ${whole(row.n)} | ${share(row)} | ${whole(row.p50)} | ${whole(row.p95)} |`);
  if (turnRows) {
    out.push("", "### Turns, per day and chat kind (tex_timing totalMs)", "", "| day | kind | turns | p50 ms | p95 ms | rounds each |", "| --- | --- | ---: | ---: | ---: | ---: |");
    for (const row of [...turnRows].sort((a, b) => `${a.day} ${a.kind}`.localeCompare(`${b.day} ${b.kind}`))) {
      out.push(`| ${word(row.day)} | ${word(row.kind)} | ${whole(row.n)} | ${whole(row.p50)} | ${whole(row.p95)} | ${(Number(row.rounds) || 0).toFixed(1)} |`);
    }
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  const rows = (file) => JSON.parse(readFileSync(file, "utf8")).data ?? [];
  if (command === "query") process.stdout.write(`${query(args[0], args[1], args[2], args[3])}\n`);
  else if (command === "report") process.stdout.write(`${report([...rows(args[0]), ...rows(args[1])], args[2] ? rows(args[2]) : null)}\n`);
  else {
    process.stderr.write("usage: texSpeed.mjs query calls <dataset> <days> first|later | query turns <dataset> <days> | report <first.json> <later.json> [turns.json]\n");
    process.exit(2);
  }
}
