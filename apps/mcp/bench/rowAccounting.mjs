/**
 * A Lab row's invalid-row and fallback accounting, written once for both runners (plan
 * `products/tex/research/sandbox-bench-scoring-2026-11-19.md`, must-have: "invalid-row and model-fallback accounting
 * identical to the GitHub run, implemented through the same code paths and not a copy").
 *
 * The GitHub run (`setsRun.mjs` `runSets`, `setsFd.mjs` `runFd`, `coreArea.mjs` `coreCases`) and the Lab sandbox's
 * bench run (`scripts/tex-lab-sandbox-bench.mjs`) both make a row that could not run with `couldNotRunRow`, count a
 * row's fallbacks with `answersFallbacks` over its answers' tools, and write a fallback's tools entry with
 * `fallbackTool` (`world.mjs` for the bench's trace; `fallbackToolsOf` for a sandbox turn's ledger steps). The run's
 * verdict over the rows is `scripts/tex-lab-run.mjs` `resultsOf` / `runVerdict` for both. Dependency-free.
 */
import { fallbacksIn } from "./fallbacks.mjs";

/**
 * A unit that could not run: out of the score, with why (`could not run: <the error>`, at most 300 characters of it).
 * `extra` carries what a runner already knows about the unit (its share of a spend that did happen, its world).
 */
export function couldNotRunRow(row, error, extra = {}) {
  return { ...row, right: false, ran: false, usd: 0, ...extra, why: `could not run: ${String(error?.message ?? error).slice(0, 300)}` };
}

/** One fallback as an answer's tools entry: `fallback: <model> after <status>`, as the bench's result notes say it. */
export function fallbackTool({ model, status } = {}) {
  return { tool: `fallback: ${model}${status === undefined ? "" : ` after ${status}`}`, ok: true };
}

/** Every answer's fallbacks summed (`fallbacks.mjs` `fallbacksIn` over each answer's tools). */
export function answersFallbacks(answers) {
  return (Array.isArray(answers) ? answers : []).reduce((n, a) => n + fallbacksIn(a?.tools), 0);
}

/**
 * A sandbox turn's fallbacks as tools entries: each ledger step the turn logged when its model failed and the setup's
 * fallback answered (`packages/tex/gateway/agent/turn.js`: `tell({ kind: "model", step: "fallback", model, input:
 * { from, status } })`, kept as a `step` entry named "fallback", `agent/ledger.js` STEP_NAMES).
 */
export function fallbackToolsOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.kind === "step" && e.step === "fallback")
    .map((e) => {
      const model = e.model ?? e.output?.model ?? e.out?.model ?? "another model";
      const status = e.input?.status ?? e.in?.status;
      return fallbackTool({ model, status: status === null ? undefined : status });
    });
}
