/**
 * EVERY SEARCH BENCHMARK, ONE RUNNER (`packages/bench`: one folder per benchmark; `docs/decisions/search/search-suite.md`):
 *
 *   node apps/mcp/bench/evals/cli.mjs search --bench <run id> [--n 40] [--fetch <dir>] --out result.json [--fake]
 *     --sets a,b        the sets (NanoBEIR) or products (HERB) to run, not the run's own
 *     --part dev        a part of a custom set (search-real: training | dev)
 *     --cases <file>    a part handed in from outside: how the search gate runs the sealed Test part
 *     --database-only   skip the workspace-object world each case is also searched in
 *
 * A run's folder says what it is (`bench.json`) and reads its data (`source.mjs`): a BEIR set (`load`), whose
 * documents become notes in Sam's empty personal workspace, one world per haystack; or its own worlds (`worlds`),
 * laid over this bench's seven workspaces. Each case is one `search_notes` call through the MCP endpoint, on both
 * ways production answers. Only the embedder is called (Workers AI when its keys are set, the bench's fake one
 * otherwise or with `--fake`), so a run costs embeddings and minutes, never Claude. Scored as the folder says:
 *
 *   beir       nDCG@10, Recall@10, MRR@10 per set or question type and their mean (NanoBEIR's headline), beside a
 *              reference ranking's (BM25) when the set has one
 *   first      right note first, top 5, MRR, per kind
 *   retrieval  are the answer documents in the top 5 (any, all), per ability
 */

import { benchmarkOf } from "../../../../packages/bench/src/registry.mjs";
import { beirWorlds } from "../../../../packages/bench/src/beir.mjs";
import { irScores, mean, r3 } from "../../../../packages/bench/src/score.mjs";

import { REPO_BENCH_FOLDER } from "../folder.mjs";
import { expandWorkspaces, parseTest, readBenchFolder } from "../load.mjs";
import { EVAL_PERSON, EVAL_WORKSPACE, evalBench } from "./memoryRun.mjs";
import { embedderFor, overlay, rowOf, runSearchCases, searchScores, splitAddress, TOP_K } from "./searchSuite.mjs";

const say = (line) => process.stderr.write(`${line}\n`);
const pctOf = (n, of) => (of === 0 ? null : Math.round((1000 * n) / of) / 10);
const listOf = (x) => (x ? String(x).split(",").map((s) => s.trim()).filter(Boolean) : null);

/** The compatibility scores block the Lab's older readers show: right note first as "correct". */
const labScores = (s) => ({ n: s.n, correct: s.first, pct: s.firstPct, asked: s.n, failed: s.errors, usd: { filing: 0, reading: 0, judging: 0, total: 0 } });

/** Right note first per kind. */
export function byKind(records) {
  const kinds = {};
  for (const r of records) {
    if (!(r.expect ?? []).length) continue;
    const k = (kinds[r.kind ?? "other"] ??= { n: 0, first: 0 });
    k.n += 1;
    if (r.rank === 1) k.first += 1;
  }
  return Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { n: v.n, firstPct: Math.round((1000 * v.first) / v.n) / 10 }]));
}

/**
 * BEIR's scores of a run: `searchScores` over every case, plus `ndcg10`, `recall10`, `mrr10` as the mean over groups
 * (a case's `kind`: NanoBEIR's set, HERB's question type; sets differ in size, so never over pooled queries),
 * `bm25Ndcg10` (the reference ranking, null when the set has none), the object world's `objectNdcg10`, and `bySet`.
 */
export function beirScores(records) {
  const bySet = {};
  const hasBm25 = records.some((r) => Array.isArray(r.bm25));
  for (const kind of [...new Set(records.map((r) => r.kind))]) {
    const group = records.filter((r) => r.kind === kind);
    const object = group.some((r) => r.object && typeof r.object === "object") ? irScores(group.filter((r) => r.object), (r) => r.object.hits) : null;
    const first = searchScores(group);
    bySet[kind] = { n: first.n, ...irScores(group), firstPct: first.firstPct, bm25Ndcg10: hasBm25 ? irScores(group, (r) => r.bm25).ndcg10 : null, ...(object ? { objectNdcg10: object.ndcg10 } : {}) };
  }
  const avg = (key) => r3(mean(Object.values(bySet).map((s) => s[key]).filter((x) => typeof x === "number")));
  return {
    ...searchScores(records),
    ndcg10: avg("ndcg10"),
    recall10: avg("recall10"),
    mrr10: avg("mrr10"),
    bm25Ndcg10: hasBm25 ? avg("bm25Ndcg10") : null,
    ...(Object.values(bySet).some((s) => s.objectNdcg10 !== undefined) ? { objectNdcg10: avg("objectNdcg10") } : {}),
    bySet,
  };
}

/** A retrieval record: are its expected notes in the top 5, any of them and all of them. */
export function withRecall(record) {
  const top = (record.hits ?? []).slice(0, TOP_K);
  const inTop = record.expect.filter((address) => top.includes(address)).length;
  return { ...record, recallAny5: record.expect.length > 0 && inTop > 0, recallAll5: record.expect.length > 0 && inTop === record.expect.length };
}

/** Retrieval scores: `searchScores` plus `recallAny5Pct`, `recallAll5Pct` and `byAbility` { ability: { n, recallAny5Pct } }. */
export function retrievalScores(records) {
  const scored = records.filter((r) => (r.expect ?? []).length > 0);
  const byAbility = {};
  for (const ability of [...new Set(scored.map((r) => r.ability ?? "search"))]) {
    const group = scored.filter((r) => (r.ability ?? "search") === ability);
    byAbility[ability] = { n: group.length, recallAny5Pct: pctOf(group.filter((r) => r.recallAny5).length, group.length) };
  }
  return {
    ...searchScores(records),
    recallAny5Pct: pctOf(scored.filter((r) => r.recallAny5).length, scored.length),
    recallAll5Pct: pctOf(scored.filter((r) => r.recallAll5).length, scored.length),
    byAbility,
  };
}

/** The expected notes a world does not have: a case naming one could never pass, so the run stops instead. */
export function missingExpected(bench, cases) {
  const missing = [];
  for (const c of cases) {
    for (const address of c.expect ?? []) {
      const parts = splitAddress(address);
      if (parts && bench.workspaces[parts[0]]?.files?.[parts[1]] !== undefined) continue;
      missing.push(`${c.id} ${address}`);
    }
  }
  return missing;
}

/** The worlds a run searches, from its folder's source: `{ total, worlds: [{ id, base, notes, cases, today }] }`. */
export async function worldsOf(run, source, options) {
  const n = options.n ?? null;
  const sets = listOf(options.sets);
  if (run.format === "beir") {
    const loaded = await source.load({ run, dir: options.fetch ?? null, data: options.data ?? null, sets, n: run.slice === "source" ? n : null });
    const perSet = run.slice === "per-set" && n !== null ? Math.max(1, Math.ceil(n / loaded.length)) : null;
    const notes = { workspace: EVAL_WORKSPACE, as: EVAL_PERSON, ...run.notes };
    const worlds = loaded.flatMap((set) =>
      beirWorlds(set, { ...notes, n: run.slice === "source" ? null : perSet ?? n, slice: run.slice === "spread" ? "spread" : "first", caseIds: run.caseIds }).map((w) => ({ ...w, base: "empty", size: set.corpus.length })),
    );
    const total = loaded.every((set) => Number.isSafeInteger(set.total)) ? loaded.reduce((t, set) => t + set.total, 0) : null;
    return { total, worlds };
  }
  const got = await source.worlds({ run, dir: options.fetch ?? null, part: options.part ?? undefined, cases: options.cases ?? null, today: options.today ?? null, sets, helpers: { parseTest } });
  return { total: got.total, worlds: n === null ? got.worlds : got.worlds.map((w) => ({ ...w, cases: w.cases.slice(0, n) })) };
}

/** `--shard s/k` as `{ index: s - 1, of: k }`, or null. */
export function shardOf(text) {
  if (!text) return null;
  const match = /^(\d+)\/(\d+)$/.exec(String(text));
  const [index, of] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (!match || of < 1 || index < 1 || index > of) throw new Error("--shard is s/k, 1 <= s <= k");
  return { index: index - 1, of };
}

/** A run's result from its records (one process's, or every shard's put back in order): what the Lab reports. */
export function resultOf(run, { total = null, records, ms, keep = false }) {
  const search = run.score === "beir" ? beirScores(records) : run.score === "retrieval" ? retrievalScores(records) : { ...searchScores(records), byKind: byKind(records) };
  const rows = records.map((r) => (run.score === "retrieval" ? { ...rowOf(r), ability: r.ability ?? "search" } : rowOf(r)));
  return { bench: run.id, variant: run.variant, total: total ?? records.length, n: records.length, ms, search, scores: labScores(search), rows, records: keep ? records : undefined };
}

/** Run one search benchmark and return the result object the Lab's eval workflow reports. */
export async function runSearchSet(options) {
  const { run, source } = await benchmarkOf(options.bench ?? "search-hard");
  if (run.kind !== "search") throw new Error(`${run.id} is a memory benchmark: cli.mjs longmemeval --bench ${run.id}`);
  const n = options.n === undefined ? null : Number(options.n);
  if (n !== null && (!Number.isSafeInteger(n) || n < 1)) throw new Error("--n is a whole number of cases");
  if (run.format === "beir" && !options.fetch && !options.data) throw new Error(`--fetch <dir> is required: ${run.title} is downloaded there`);
  const ai = embedderFor({ fake: options.fake === true || !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN) });
  const objects = options["database-only"] !== true;
  const started = Date.now();
  // A world's gateway logs a JSON line per step; a run prints one line per world or case instead.
  const log = console.log;
  console.log = () => {};
  try {
    const { total, worlds: all } = await worldsOf(run, source, { ...options, n });
    const shard = shardOf(options.shard);
    // One process's share of a `--parallel` run: every k-th case of each world (`cli.mjs search --parallel k`).
    const worlds = shard ? all.map((w) => ({ ...w, cases: w.cases.filter((_, i) => i % shard.of === shard.index) })).filter((w) => w.cases.length > 0) : all;
    const repo = worlds.some((w) => w.base === "repo") ? expandWorkspaces(await readBenchFolder(REPO_BENCH_FOLDER)) : null;
    const records = [];
    const many = worlds.length > 20;
    for (const w of worlds) {
      const bench = overlay(w.base === "repo" ? repo : evalBench(), w.notes);
      const missing = missingExpected(bench, w.cases);
      if (missing.length) throw new Error(`expected notes that exist nowhere: ${missing.join(", ")}`);
      if (!many) say(`${w.id}: ${Object.keys(w.notes).length} notes, ${w.cases.length} queries`);
      const at = Date.now();
      const got = await runSearchCases({ bench, cases: w.cases, ai, today: w.today ?? null, objects, log: many ? () => {} : (line) => process.stderr.write(line) });
      got.forEach((record, i) => {
        const c = w.cases[i];
        const full = { ...record, ...(c.bm25 ? { bm25: c.bm25 } : {}), ...(c.ability ? { ability: c.ability } : {}), ...(c.missing?.length ? { missing: c.missing } : {}) };
        records.push(run.score === "retrieval" ? withRecall(full) : full);
        if (many) say(`${record.id}: ${record.rank === null ? "miss" : `rank ${record.rank}`}`);
      });
      if (!many && run.score === "beir") {
        const s = beirScores(records.filter((r) => got.some((g) => g.id === r.id)));
        say(`${w.id}: nDCG@10 ${s.ndcg10}${s.objectNdcg10 !== undefined ? ` (objects ${s.objectNdcg10})` : ""}${s.bm25Ndcg10 !== null ? `, BM25 ${s.bm25Ndcg10}` : ""}, right note first ${s.firstPct}% in ${Math.round((Date.now() - at) / 1000)} s`);
      }
    }
    // A shard reports the whole run's total, not its share of it.
    return resultOf(run, { total: total ?? all.reduce((sum, w) => sum + w.cases.length, 0), records, ms: Date.now() - started, keep: options["keep-records"] === true || shard !== null });
  } finally {
    console.log = log;
  }
}
