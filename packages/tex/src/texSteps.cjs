/**
 * Tex's model steps, read from `texConfig.json` (the Lab's source of truth):
 * every node whose model is not "code", in the file's order. The staff
 * console's AI costs page groups spend by these ids, so it follows the Lab
 * without a copy to drift.
 */

const { TEX_CONFIG: config } = require("./texConfig.cjs");

const TEX_STEPS = Object.freeze(
  config.nodes
    .filter((node) => node.model !== "code")
    .map((node) => Object.freeze({ id: node.id, label: node.label, model: node.model, on: node.on === true })),
);

/** Each step that is on and the model key it falls back to (`fallback`, a Front door setting since 2026-11-16). */
const FALLBACKS = Object.freeze(config.nodes.filter((node) => node.on === true && typeof node.fallback === "string").map((node) => [node.id, node.fallback]));

/**
 * The first step that is on and runs this texConfig model key, or else falls
 * back to it, or else any step (off included) that runs it, so spend from
 * before a step was turned off still lands on Tex; null when none does.
 */
function texStepForModel(model) {
  const step = TEX_STEPS.find((s) => s.on && s.model === model);
  if (step) return step.id;
  const falls = FALLBACKS.find(([, key]) => key === model);
  if (falls) return falls[0];
  const off = TEX_STEPS.find((s) => s.model === model);
  return off ? off.id : null;
}

module.exports = { TEX_STEPS, texStepForModel };
