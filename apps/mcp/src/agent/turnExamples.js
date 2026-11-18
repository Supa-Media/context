/**
 * The front door's examples for this text, awaited once (`turn.js` runTurn). The node that finds them (`graph/nodes/examples.js`)
 * starts when the front door starts, so by the first prompt its answer is usually there; a slower answer waits only the
 * budget, and then the front door's fixed examples stand instead (`texExamples.cjs` `fallbackText`).
 *
 * Every outcome is traced (`kind: "examples"`): whether the nearest examples were found, how many, how long the wait
 * took, why not, and whether the fixed ones were used instead. Never throws: a broken node costs the examples, not the turn.
 */
import { EXAMPLES_BUDGET_MS, EXAMPLES_NODE, fallbackText } from "../../../../packages/shared/src/texExamples.cjs";

const TIMED_OUT = Object.freeze({ when: ["fallback"], why: "timeout" });

/**
 * The text the front door's preamble gets for `examples` (a promise of the node's output, or null): the nearest examples'
 * text when found, else `fallback`. Records one trace entry when there was a promise to wait for.
 */
export async function awaitExamples(examples, { budgetMs, fallback = "", trace = null, clock = Date.now } = {}) {
  if (!examples || typeof examples.then !== "function") return "";
  const asked = clock();
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : EXAMPLES_BUDGET_MS;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), budget);
  });
  const settled = Promise.resolve(examples).then(
    (out) => out ?? { when: ["fallback"], why: "empty" },
    () => ({ when: ["fallback"], why: "error" }),
  );
  let out;
  try {
    out = await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
  const found = out?.when?.includes("found") === true && typeof out.text === "string" && out.text !== "";
  const ms = clock() - asked;
  trace?.push({
    kind: "examples",
    found,
    n: found && Array.isArray(out.ids) ? out.ids.length : 0,
    ms,
    ...(found ? {} : { why: typeof out?.why === "string" ? out.why : "error" }),
    fellBack: !found,
  });
  return found ? out.text : fallback;
}

/**
 * The options `runTurn` takes for a turn whose front door was wired to the examples node (`examples` is its promise, or
 * null): the promise, the budget the config gives the node (`ms`, else the default), and the fixed examples that stand
 * when the nearest ones are not there. Nothing when null, so an unwired turn's options are as they were.
 */
export function examplesOptions(examples, config, training, index = null) {
  if (!examples) return {};
  // A bench index embeds over the network and builds on first use, so its wait is its own (`bench/texExamplesIndex.mjs`):
  // the bench scores what the examples do, and production's speed is measured in production.
  const ms = Number.isFinite(index?.budgetMs) && index.budgetMs > 0 ? index.budgetMs : config.nodes.find((node) => node.id === "examples")?.ms;
  const fd = config.nodes.find((node) => node.id === EXAMPLES_NODE);
  return {
    examples,
    examplesBudgetMs: Number.isFinite(ms) && ms > 0 ? ms : EXAMPLES_BUDGET_MS,
    examplesFallback: fallbackText(fd, training),
  };
}
