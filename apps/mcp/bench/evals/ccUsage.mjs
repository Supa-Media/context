#!/usr/bin/env node
/**
 * WHAT A CLAUDE CODE EVAL RUN SPENT (`docs/decisions/testing/lab-evals.md`). A run through the model socket costs no
 * dollars; it spends the Claude Code subscription's limits. So a cc run reports two figures:
 *
 * - its tokens, measured: every answered call's own `usage` from the CLI's result (`socketAnswerer.mjs` writes one line
 *   per call to the socket's `usage.jsonl`);
 * - the share of the weekly limit it used, as Claude Code's own usage read (`/api/oauth/usage`, the figure `/usage`
 *   shows) answers it before and after the run. That figure covers the whole account, so anything else using the same
 *   subscription meanwhile is in it; when the read is refused or missing, the run says why and shows no percentage.
 *
 *   node apps/mcp/bench/evals/ccUsage.mjs weekly --out before.json
 *   node apps/mcp/bench/evals/ccUsage.mjs merge --usage <sock>/usage.jsonl --before before.json --after after.json --result result.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The tokens of every answered call, summed, and per model. */
export function sumUsage(text) {
  const total = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} };
  for (const line of String(text ?? "").split("\n")) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const model = typeof row.model === "string" && row.model ? row.model.slice(0, 40) : "unknown";
    const mine = (total.byModel[model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const into of [total, mine]) {
      into.calls += 1;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) into[key] += Number.isFinite(row[key]) && row[key] > 0 ? row[key] : 0;
    }
  }
  total.tokens = total.input + total.output + total.cacheRead + total.cacheWrite;
  return total;
}

/** The weekly figure from a usage read's body: `seven_day.utilization`, a percentage, or null. */
export function weeklyOf(body) {
  const value = body?.seven_day?.utilization;
  return Number.isFinite(value) ? value : null;
}

/** Claude Code's weekly usage for the token: `{ pct, at }`, or `{ pct: null, why }` when it cannot be read. */
export async function readWeekly(token, fetchImpl = fetch, now = Date.now) {
  if (!token) return { pct: null, why: "no Claude Code token" };
  try {
    const got = await fetchImpl(USAGE_URL, { headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", accept: "application/json" } });
    if (!got.ok) return { pct: null, why: `the usage read answered ${got.status}` };
    const pct = weeklyOf(await got.json());
    return pct === null ? { pct: null, why: "the usage read had no weekly figure" } : { pct, at: now() };
  } catch (error) {
    return { pct: null, why: `the usage read failed: ${String(error?.message ?? error).slice(0, 100)}` };
  }
}

/**
 * The run's `cc` figures: measured tokens, the weekly share used between the two reads, and both scaled to the whole
 * benchmark the way `fullRunUsd` is (this slice's figure per question, times every question).
 */
export function ccFigures(usage, before, after, { n, total }) {
  const scale = n > 0 && total > 0 ? total / n : null;
  const both = Number.isFinite(before?.pct) && Number.isFinite(after?.pct);
  const weeklyPct = both ? Math.max(0, Math.round((after.pct - before.pct) * 10) / 10) : null;
  return {
    calls: usage.calls,
    tokens: usage.tokens,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    byModel: usage.byModel,
    weeklyPct,
    weeklyBefore: Number.isFinite(before?.pct) ? before.pct : null,
    weeklyAfter: Number.isFinite(after?.pct) ? after.pct : null,
    weeklyWhy: both ? null : (before?.why ?? after?.why ?? "no usage read"),
    fullRunTokens: scale === null ? null : Math.round(usage.tokens * scale),
    fullRunWeeklyPct: scale === null || weeklyPct === null ? null : Math.round(weeklyPct * scale * 10) / 10,
  };
}

const readJson = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: { out: { type: "string" }, usage: { type: "string" }, before: { type: "string" }, after: { type: "string" }, result: { type: "string" } }, strict: true });
  if (command === "weekly") {
    if (!values.out) throw new Error("--out is required");
    const read = await readWeekly(String(env.CLAUDE_CODE_OAUTH_TOKEN ?? "").replace(/\s+/g, ""));
    writeFileSync(values.out, JSON.stringify(read));
    process.stderr.write(read.pct === null ? `weekly usage not read: ${read.why}\n` : `weekly usage ${read.pct}%\n`);
    return read;
  }
  if (command === "merge") {
    if (!values.result) throw new Error("--result is required");
    const result = readJson(values.result);
    if (!result) throw new Error(`no result at ${values.result}`);
    const usage = sumUsage(values.usage && existsSync(values.usage) ? readFileSync(values.usage, "utf8") : "");
    result.cc = ccFigures(usage, readJson(values.before), readJson(values.after), { n: result.n, total: result.total });
    writeFileSync(values.result, JSON.stringify(result));
    process.stderr.write(`Claude Code: ${result.cc.tokens} tokens over ${result.cc.calls} calls; weekly ${result.cc.weeklyPct ?? `not read (${result.cc.weeklyWhy})`}\n`);
    return result.cc;
  }
  throw new Error("usage: ccUsage.mjs weekly --out <file> | merge --usage <file> --before <file> --after <file> --result <file>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  });
}
