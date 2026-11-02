/**
 * THE ADVISOR IN THE SETUP NOTE (`models.advisor`, `models.advisor_effort`).
 *
 * A setup may name a second built-in model the everyday model can consult.
 * It must differ from `models.main`, is independent of the router, and its
 * effort (when set) is recorded in `efforts` under the advisor's model name,
 * as `think_effort` is under the think model. A file with an effort and no
 * advisor, or a word that is not an effort, is refused whole.
 *
 * Parsed with `parseSetup` from strings, as `agentThinkRounds.test.mjs` does.
 *
 * ## Sabotage record
 *
 *   `parse` dropping the `models.advisor === models.main` refusal
 *     → "an advisor equal to main refuses the whole file" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSetup } from "../src/agent/production.js";
import { ROUTER_MODEL } from "../src/agent/router.js";

const MAIN = "anthropic/claude-haiku-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const ADVISOR = "anthropic/claude-opus-5-5";

const file = (models) => `---\nmodels:\n${models}\n---\nYou are Tex.\n`;
const ROUTED = `  main: ${MAIN}\n  router: ${ROUTER_MODEL}\n  think: ${OPUS}`;

test("parseSetup reads models.advisor, and the advisor is null when absent", async () => {
  const setup = await parseSetup(file(`  main: ${MAIN}\n  advisor: ${ADVISOR}`));
  assert.equal(setup?.advisor, ADVISOR);
  assert.equal(setup?.model, MAIN, "the advisor does not replace main");
  assert.equal((await parseSetup(file(`  main: ${MAIN}`)))?.advisor, null);
});

test("an advisor equal to main refuses the whole file", async () => {
  assert.equal(await parseSetup(file(`  main: ${MAIN}\n  advisor: ${MAIN}`)), null);
});

test("an advisor that is not a built-in model refuses the file", async () => {
  assert.equal(await parseSetup(file(`  main: ${MAIN}\n  advisor: evil/model-x`)), null);
});

test("advisor_effort is recorded under the advisor's model name", async () => {
  const setup = await parseSetup(file(`  main: ${MAIN}\n  advisor: ${ADVISOR}\n  advisor_effort: high`));
  assert.equal(setup?.efforts[ADVISOR], "high");
  assert.equal(setup?.efforts[MAIN], undefined, "main has no effort of its own here");
});

test("advisor_effort without an advisor refuses the file", async () => {
  assert.equal(await parseSetup(file(`  main: ${MAIN}\n  advisor_effort: high`)), null);
});

test("advisor_effort that is not an effort word refuses the file", async () => {
  assert.equal(await parseSetup(file(`  main: ${MAIN}\n  advisor: ${ADVISOR}\n  advisor_effort: extreme`)), null);
});

test("an advisor sits alongside the router and the thinking model", async () => {
  const setup = await parseSetup(file(`${ROUTED}\n  advisor: ${ADVISOR}\n  advisor_effort: max`));
  assert.equal(setup?.advisor, ADVISOR);
  assert.equal(setup?.router?.think, OPUS);
  assert.equal(setup?.router?.model, ROUTER_MODEL);
  assert.equal(setup?.efforts[ADVISOR], "max");
});
