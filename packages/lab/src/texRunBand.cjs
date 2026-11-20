/**
 * A Lab run's score as a mean with a noise band, and whether a draft's run beats its base's (Dev2, 2026-11-19, after
 * main at one commit scored the Front door 11/30 and 15/30 in two runs minutes apart: "repeat each Front door row N
 * times ... a draft wins only if it clears the band vs its base"). Shared by the run's results
 * (`scripts/tex-lab-run.mjs`), Convex (`functions/texLabRuns.ts`, tex_dev `runs`) and the Lab (Runs panel, Compare).
 *
 * A run's `score` is `{ mean, min, max, lo, hi, repeats, total }`: `mean` the average over repeats of the run's total
 * pass count, `min`/`max` the lowest and highest repeat, `lo`/`hi` a 95% interval of the mean (Student's t over the
 * repeats; equal to the mean with one repeat), `total` the tests counted. The band a comparison reads is min..max.
 *
 * A draft wins only when its whole band is above its base's (draft min > base max), loses only when its whole band is
 * below (draft max < base min), and is within noise otherwise. A run of one repeat has no band, so it never wins or
 * loses: it is "no band". Runs with different models (gw against cc) or sets are not compared at all.
 */
"use strict";

/** Repeats of each Front door test a run makes unless asked otherwise, and the most it may ask for. */
const DEFAULT_REPEATS = 3;
const MAX_REPEATS = 5;

/** Two-sided 95% Student's t by degrees of freedom (1..4: repeats 2..5). */
const T95 = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776 };

/** A repeat count as a run may take it: an integer 1..MAX_REPEATS, the default when missing; null when it is not one. */
function repeatsOf(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_REPEATS;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_REPEATS ? n : null;
}

const round = (x, places = 2) => Math.round(x * 10 ** places) / 10 ** places;

/** The score of per-repeat pass counts out of `total`: mean, min, max and the 95% interval. */
function bandOf(passes, total) {
  const list = (Array.isArray(passes) ? passes : []).filter((x) => typeof x === "number" && Number.isFinite(x));
  if (list.length === 0) return { mean: 0, min: 0, max: 0, lo: 0, hi: 0, repeats: 0, total: Number(total) || 0 };
  const k = list.length;
  const mean = list.reduce((a, b) => a + b, 0) / k;
  const sd = k > 1 ? Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1)) : 0;
  const half = k > 1 ? (T95[k - 1] ?? 1.96) * (sd / Math.sqrt(k)) : 0;
  return { mean: round(mean), min: Math.min(...list), max: Math.max(...list), lo: round(Math.max(0, mean - half)), hi: round(Math.min(Number(total) || Infinity, mean + half)), repeats: k, total: Number(total) || 0 };
}

/** A results object's score: its own `score` when it has one, else its single pass count as a band of one repeat. */
function scoreOfResults(results) {
  if (!results || typeof results !== "object") return null;
  const s = results.score;
  if (s && typeof s === "object" && typeof s.mean === "number") return s;
  if (typeof results.pass !== "number") return null;
  return bandOf([results.pass], results.total);
}

/**
 * Whether `draft` beats `base` (each a results object or a score): "wins", "loses", "within noise", or "no band" when
 * either has fewer than two repeats. With the reason in words.
 */
function bandVerdict(draft, base) {
  const d = draft && typeof draft.mean === "number" ? draft : scoreOfResults(draft);
  const b = base && typeof base.mean === "number" ? base : scoreOfResults(base);
  if (!d || !b) return { verdict: "no base", why: "no finished run to compare with" };
  const words = (s) => `${s.mean} (${s.min}–${s.max} over ${s.repeats})`;
  if (d.repeats < 2 || b.repeats < 2) return { verdict: "no band", why: `${d.repeats < 2 ? "the draft's" : "the base's"} run has one repeat, so it has no noise band` };
  if (d.min > b.max) return { verdict: "wins", why: `${words(d)} is above ${words(b)}: its worst repeat beats the base's best` };
  if (d.max < b.min) return { verdict: "loses", why: `${words(d)} is below ${words(b)}: its best repeat is under the base's worst` };
  return { verdict: "within noise", why: `${words(d)} overlaps ${words(b)}` };
}

/** Why a run on Claude Code ("cc") is labelled "model family only" (`apps/mcp/bench/socketAnswerer.mjs`). */
const CC_FIDELITY = "model family only";
const CC_FIDELITY_WHY =
  "Claude Code answers each call with the same model family, but cannot apply production's exact model version, effort, token cap or temperature. Measure an effort, temperature or token-cap change with an AI gateway (gw) run.";

/** A run's fidelity label by its models: "model family only" for cc, null for gw. */
const fidelityOf = (models) => (models === "cc" ? CC_FIDELITY : null);

module.exports = { DEFAULT_REPEATS, MAX_REPEATS, repeatsOf, bandOf, scoreOfResults, bandVerdict, CC_FIDELITY, CC_FIDELITY_WHY, fidelityOf };
