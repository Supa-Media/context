/**
 * Claude calls that fell back to another model, counted so a Lab run's score cannot pass as Tex's (2026-11-18).
 *
 * A turn whose main model failed is answered by the setup's fallback, and its tools line says so
 * (`fallback: <model> after <status>`, `world.mjs`; `report.mjs` counts them per setup). A Lab run on the AI gateway
 * that fell back even once scored some other model's answers, so its results carry the count and say the run is
 * not valid. Dependency-free, so the counting is tested on its own.
 */

/** How many of one answer's calls went to the fallback: each `fallback: ...` entry, a string or `{ tool }`. */
export function fallbacksIn(tools) {
  return (Array.isArray(tools) ? tools : []).filter((call) => String(typeof call === "string" ? call : call?.tool ?? "").startsWith("fallback: ")).length;
}

/** A run's rows summed: the fallback count, whether the score is Tex's, and why not. */
export function fallbackVerdict(rows) {
  const fallbacks = (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + (Number(row?.fallbacks) > 0 ? Math.floor(Number(row.fallbacks)) : 0), 0);
  if (fallbacks === 0) return { fallbacks: 0, valid: true };
  return { fallbacks, valid: false, invalid: `${fallbacks} Claude call(s) fell back to another model, so this score is not Tex's` };
}
