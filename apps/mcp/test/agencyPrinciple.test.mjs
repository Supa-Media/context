/**
 * WHO DOES THE WORK lives in one place (`texPrompt/rules.md`).
 *
 * The check-in case was missing: an ask does the work, a check-in offers the
 * next step and does not start it. The other prompt files point at that
 * block instead of repeating the hand-over list.
 *
 * Sabotage: delete the check-in sentence from rules.md. This test fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

test("the check-in split is named once, in rules, and the other files point at it", () => {
  const rules = read("packages/shared/src/texPrompt/rules.md");
  const talk = read("packages/shared/src/texPrompt/how-you-talk.md");
  const tools = read("packages/shared/src/texPrompt/tools.md");
  assert.match(rules, /On a check-in, say what came in and offer the next step, and don't start it/);
  assert.match(rules, /password change after a possible break-in/);
  assert.equal((rules.match(/a code, a captcha, a payment/g) ?? []).length, 1, "the hand-over list is written once");
  assert.match(talk, /Who does the work/);
  assert.match(tools, /Who does the work/);
  assert.equal(talk.includes("a code, a captcha"), false);
  assert.equal(tools.includes("a code, a captcha"), false);
});
