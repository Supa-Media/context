/**
 * Tool rule 4 (Dev2, 2026-11-20): the refusals Tex hit most in production (the Lab's Tools tab, "Commonest failures")
 * each say what to do next. Measured with the same rating the Lab and CI use (`packages/tex/src/toolRules.cjs`).
 *
 * ## Sabotage record
 *
 *  1. `withNextStep` returning the result unchanged → "a note read's not found tells Tex what to try" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { withNextStep } from "../../../packages/tex/gateway/agent/nextSteps.js";
import { offerTarget } from "../src/tools/offerFor.js";
import { readCalendarChange } from "../src/tools/calendarWrite.js";
import { sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { fixedCarriers } from "../../../packages/tex/gateway/agent/sixToolsFixed.js";
import rules from "../../../packages/tex/src/toolRules.cjs";

const { rateError } = rules;
const text = (result) => result.content[0].text;

test("a note read's not found tells Tex what to try, the same words whether the note is hidden or missing", () => {
  for (const words of ["not found", "In @supa: not found"]) {
    const out = text(withNextStep({ isError: true, content: [{ type: "text", text: words }] }));
    assert.ok(out.startsWith(`${words}.`), "the gateway's own words come first, unchanged");
    assert.equal(rateError(out), "actionable", out);
  }
  const ok = { content: [{ type: "text", text: "not found" }] };
  assert.equal(withNextStep(ok), ok, "a result that is not an error is untouched");
  assert.equal(text(withNextStep({ isError: true, content: [{ type: "text", text: "conflict" }] })), "conflict");
});

test("the commonest production refusals say what to do next", () => {
  const solo = { egress: { group: null } };
  const group = { egress: { group: { from: "ada", people: ["ada", "bo"] } } };
  const refusals = [
    offerTarget(solo, { as: "bo" }, "calendar change").error,
    offerTarget(group, { as: "not a handle!" }, "calendar change").error,
    offerTarget(group, { as: "cy" }, "calendar change").error,
    readCalendarChange({ action: "create", title: "Dentist", start: "friday" }).error,
  ];
  const shown = fixedCarriers("one");
  const six = sixToolsOver([...shown.values()], { send: ["say_nothing"] });
  refusals.push(six.resolve("send", { action: "teleport" }).error);
  refusals.push(six.resolve("fetch", { id: "notes/a.md", args: { colour: "red" } }).error ?? "");
  for (const refusal of refusals.filter(Boolean)) assert.equal(rateError(refusal), "actionable", refusal);
});
