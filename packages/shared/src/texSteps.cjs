/**
 * Tex's model steps, read from `texConfig.json` (the Lab's source of truth):
 * every node whose model is not "code", in the file's order. The staff
 * console's AI costs page groups spend by these ids, so it follows the Lab
 * without a copy to drift.
 */

const config = require("./texConfig.json");

const TEX_STEPS = Object.freeze(
  config.nodes
    .filter((node) => node.model !== "code")
    .map((node) => Object.freeze({ id: node.id, label: node.label, model: node.model, on: node.on === true })),
);

/** The first step that is on and runs this texConfig model key; null when none does. */
function texStepForModel(model) {
  const step = TEX_STEPS.find((s) => s.on && s.model === model);
  return step ? step.id : null;
}

module.exports = { TEX_STEPS, texStepForModel };
