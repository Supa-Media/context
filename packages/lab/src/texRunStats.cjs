/**
 * Statistics for a Lab run's rows (Dev2, 2026-11-19: Lab bench statistics, building on the repeats and noise band in
 * `texRunBand.cjs` and the recorded world of #3717). Four things, each so a change in the Lab is read with the right
 * uncertainty:
 *
 * 1) Paired comparison. A draft is compared with its base (main) on the same rows, and on the same recorded world when
 *    both runs have one. Each row gives a difference (draft pass rate minus base pass rate). The mean difference, its
 *    standard error and a 95% Student's t interval are read over the rows. A draft wins only when the interval lies
 *    entirely above 0, loses only when it lies entirely below 0, and is within noise otherwise.
 * 2) Clustered standard errors by conversation. Turns in one chat are not independent, so the rows are clustered by
 *    conversation (Liang and Zeger's CR1 estimator, as in the Anthropic note on statistical approaches to evals),
 *    with G - 1 degrees of freedom. One conversation gives no interval. Pass rates get a Wilson score interval.
 * 3) Minimum detectable effect. Every comparison reports the smallest row change detectable at 80% power, given the
 *    rows, the clusters and the observed variance: (t + z(0.8)) times the standard error.
 * 4) pass^k. The unbiased estimate, per row and overall, that all k repeats of a row pass (tau-bench, arXiv 2406.12045).
 *
 * References: anthropic.com/research/statistical-approach-to-model-evals; arxiv.org/abs/2411.00640.
 * Dev items only: nothing here reads a sealed Test set, and nothing here is tuned on Dev items.
 *
 * Rates are rounded to 4 decimals, row quantities to 2. Verdicts use the unrounded numbers.
 */
"use strict";

const { bandVerdict } = require("./texRunBand.cjs");

/** One-sided z for 80% power. */
const Z80 = 0.8416;

/** Two-sided 95% Student's t for df 1..30. */
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120,
  2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/** Two-sided 95% Student's t; a df between table entries takes the next lower table df (conservative). */
function t975(df) {
  if (!Number.isFinite(df) || df < 1) return Infinity;
  const d = Math.floor(df);
  if (d <= 30) return T975[d - 1];
  if (d < 40) return 2.042;
  if (d < 60) return 2.021;
  if (d < 120) return 2.0;
  if (d === 120) return 1.98;
  return 1.96;
}

const round = (x, places) => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};
const r4 = (x) => round(x, 4);
const r2 = (x) => round(x, 2);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** A row's key across two runs: the same conversation, turn and node. */
function rowKey(row) {
  return `${row.convId}\u0000${row.msgIndex}\u0000${row.node}`;
}

/** The rows a run counts: not `ran: false`, not `ambiguous`. A repeated row reads its runs and passes, else its ok. */
function countedRows(results) {
  const rows = results && Array.isArray(results.rows) ? results.rows : [];
  return rows
    .filter((r) => r && typeof r === "object" && r.ran !== false && r.ambiguous !== true)
    .map((r) => {
      const repeated = r.runs > 0;
      const runs = repeated ? r.runs : 1;
      const passes = repeated ? Number(r.passes) || 0 : r.ok ? 1 : 0;
      return { key: rowKey(r), convId: r.convId, msgIndex: r.msgIndex, node: r.node, runs, passes, rate: passes / runs };
    });
}

/** Wilson score interval for `passes` out of `n` at two-sided z (1.96 for 95%). */
function wilson(passes, n, z = 1.96) {
  if (!(n > 0)) return { p: 0, lo: 0, hi: 1 };
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p: r4(p), lo: r4(clamp01(centre - half)), hi: r4(clamp01(centre + half)) };
}

/**
 * The mean of `values` with its standard error clustered by `clusters` (same length). `naiveSe` ignores the clusters;
 * `clusteredSe` is null with fewer than two clusters. `se` is the clustered one when there is one, else the naive one.
 */
function clusteredMean(values, clusters) {
  const xs = Array.isArray(values) ? values : [];
  const cs = Array.isArray(clusters) ? clusters : [];
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : 0;
  const ss = xs.reduce((a, x) => a + (x - mean) ** 2, 0);
  const naiveSe = n >= 2 ? Math.sqrt(ss / (n - 1)) / Math.sqrt(n) : 0;
  const sums = new Map();
  xs.forEach((x, i) => sums.set(cs[i], (sums.get(cs[i]) ?? 0) + (x - mean)));
  const G = sums.size;
  let clusteredSe = null;
  if (G >= 2) {
    let total = 0;
    for (const s of sums.values()) total += s * s;
    clusteredSe = Math.sqrt((G / (G - 1)) * total) / n;
  }
  return {
    n,
    clusters: G,
    mean,
    naiveSe,
    clusteredSe,
    se: clusteredSe ?? naiveSe,
    df: clusteredSe === null ? n - 1 : G - 1,
  };
}

/** Unbiased pass^k: the chance that k repeats drawn from n, of which c passed, all pass. Null when k is not 1..n. */
function passHatK(n, c, k) {
  if (!(k >= 1) || k > n) return null;
  if (c < k) return 0;
  let p = 1;
  for (let j = 0; j < k; j++) p *= (c - j) / (n - j);
  return p;
}

/** A run's own numbers: its row count, conversations, mean row rate with a clustered interval, Wilson and pass^k. */
function runStats(results) {
  const rows = countedRows(results);
  if (rows.length === 0) return null;
  const cm = clusteredMean(
    rows.map((r) => r.rate),
    rows.map((r) => r.convId),
  );
  const half = cm.se > 0 && cm.df >= 1 ? t975(cm.df) * cm.se : 0;
  const passes = rows.reduce((a, r) => a + r.passes, 0);
  const runs = rows.reduce((a, r) => a + r.runs, 0);
  const k = Math.min(...rows.map((r) => r.runs));
  const passK = rows.map((r) => passHatK(r.runs, r.passes, k));
  const w = wilson(passes, runs);
  return {
    rows: rows.length,
    conversations: cm.clusters,
    k,
    rate: r4(cm.mean),
    se: r4(cm.se),
    clustered: cm.clusteredSe !== null,
    lo: r4(clamp01(cm.mean - half)),
    hi: r4(clamp01(cm.mean + half)),
    wilson: { lo: w.lo, hi: w.hi },
    passK: {
      k,
      rate: r4(passK.reduce((a, b) => a + b, 0) / rows.length),
      allPass: rows.filter((r) => r.passes === r.runs).length,
    },
  };
}

/** Signed to 2 decimals, with a true minus sign. */
const sg = (x) => (x < 0 ? "−" : "+") + Math.abs(x).toFixed(2);

/**
 * The paired comparison of a draft's results with a base's, on the rows both runs counted. Verdict "wins" when the
 * interval lies above 0, "loses" when below, "within noise" otherwise; "too few conversations" with one conversation;
 * "no shared rows" when the two runs have no row in common.
 */
function pairedCompare(draft, base) {
  const dMap = new Map(countedRows(draft).map((r) => [r.key, r]));
  const bMap = new Map(countedRows(base).map((r) => [r.key, r]));
  const shared = [...bMap.values()].filter((b) => dMap.has(b.key)).map((b) => ({ b, d: dMap.get(b.key) }));
  const onlyDraft = [...dMap.keys()].filter((k) => !bMap.has(k)).length;
  const onlyBase = [...bMap.keys()].filter((k) => !dMap.has(k)).length;
  if (shared.length === 0) {
    return { verdict: "no shared rows", why: "the two runs have no rows in common", rows: 0, onlyDraft, onlyBase };
  }

  const diffs = shared.map((s) => s.d.rate - s.b.rate);
  const cm = clusteredMean(
    diffs,
    shared.map((s) => s.b.convId),
  );
  const n = shared.length;
  const G = cm.clusters;
  const t = t975(cm.df);
  const finite = cm.se > 0 && Number.isFinite(t);
  const half = finite ? t * cm.se : 0;
  const lo = cm.mean - half;
  const hi = cm.mean + half;
  const mde = finite ? (t + Z80) * cm.se : 0;
  const meanRows = r2(cm.mean * n);
  const loRows = r2(lo * n);
  const hiRows = r2(hi * n);
  const mdeRows = r2(mde * n);

  let verdict;
  if (G < 2) verdict = "too few conversations";
  else if (lo > 0) verdict = "wins";
  else if (hi < 0) verdict = "loses";
  else verdict = "within noise";

  const draftMisses = draft && draft.world && typeof draft.world.misses === "number" ? draft.world.misses : null;
  const baseMisses = base && base.world && typeof base.world.misses === "number" ? base.world.misses : null;
  const sameWorld = draftMisses === 0 && baseMisses === 0;

  let why =
    G < 2
      ? `${sg(meanRows)} rows over ${n} shared rows, all in one conversation: turns in one chat are not independent, so there is no interval`
      : `${sg(meanRows)} rows (95% ${sg(loRows)} to ${sg(hiRows)}) over ${n} shared rows in ${G} conversations, clustered by conversation; smallest change detectable at 80% power: ${mdeRows.toFixed(2)} rows`;
  if (!sameWorld) {
    why += `; not the same recorded world (draft invented ${draftMisses ?? "?"}, base ${baseMisses ?? "?"} simulated answers)`;
  }
  if (onlyDraft + onlyBase > 0) why += `; ${onlyDraft + onlyBase} rows not in both runs left out`;

  const perRow = shared
    .map((s) => ({ key: s.b.key, convId: s.b.convId, msgIndex: s.b.msgIndex, node: s.b.node, draft: s.d.rate, base: s.b.rate, diff: s.d.rate - s.b.rate }))
    .filter((r) => r.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, 200)
    .map(({ key, ...rest }) => ({ ...rest, draft: r4(rest.draft), base: r4(rest.base), diff: r4(rest.diff) }));

  return {
    verdict,
    why,
    rows: n,
    conversations: G,
    onlyDraft,
    onlyBase,
    mean: r4(cm.mean),
    se: r4(cm.se),
    naiveSe: r4(cm.naiveSe),
    clustered: cm.clusteredSe !== null,
    lo: r4(lo),
    hi: r4(hi),
    mde: r4(mde),
    meanRows,
    loRows,
    hiRows,
    mdeRows,
    world: { draftMisses, baseMisses },
    sameWorld,
    perRow,
  };
}

/**
 * The verdict a Lab comparison shows: the paired rule when both runs have rows in common, else the noise band
 * (`bandVerdict`). The band is always returned too.
 */
function compareRuns(draft, base) {
  const band = bandVerdict(draft, base);
  if (countedRows(draft).length > 0 && countedRows(base).length > 0) {
    const paired = pairedCompare(draft, base);
    if (paired.verdict !== "no shared rows") return { verdict: paired.verdict, why: paired.why, paired, band };
  }
  return { ...band, paired: null, band };
}

/** The Lab's one line for a paired comparison; "" when there is none. */
function pairedWords(p) {
  if (!p || !p.rows) return "";
  const chats = p.conversations === 1 ? "chat" : "chats";
  return `Δ ${sg(p.meanRows)} rows (${sg(p.loRows)} to ${sg(p.hiRows)}) · detectable ±${Number(p.mdeRows).toFixed(2)} · ${p.rows} rows / ${p.conversations} ${chats}`;
}

/** The Lab's one line for a run: pass^k when it repeated, the Wilson interval, the clustered ± in points. "" when none. */
function statsWords(s) {
  if (!s) return "";
  const parts = [];
  if (s.k > 1) parts.push(`pass^${s.k} ${s.passK.rate.toFixed(2)}`);
  parts.push(`Wilson ${Math.round(s.wilson.lo * 100)}–${Math.round(s.wilson.hi * 100)}%`);
  const df = s.clustered ? s.conversations - 1 : s.rows - 1;
  const pts = s.se > 0 && df >= 1 ? t975(df) * s.se * 100 : 0;
  const chats = s.conversations === 1 ? "chat" : "chats";
  parts.push(`±${pts.toFixed(1)} pts (${s.conversations} ${chats})`);
  return parts.join(" · ");
}

module.exports = {
  Z80,
  t975,
  rowKey,
  countedRows,
  wilson,
  clusteredMean,
  passHatK,
  runStats,
  pairedCompare,
  compareRuns,
  pairedWords,
  statsWords,
};
