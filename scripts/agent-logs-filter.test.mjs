/**
 * What the two log-reading workflows may publish.
 *
 * Both print production log values somewhere the public can read: an issue on
 * this repository (`tex-alert.yml`) and a run page (`agent-logs.yml`). Their
 * headers promise codes and counts only. This holds them to it — and runs
 * `agent-logs.yml`'s own inline copies of the filter, because that step has
 * no checkout and cannot import `log-codes.mjs`.
 *
 * Sabotage: put the stripping filter back (`String(v).replace(/[^\w.:-]/g,
 * "").slice(0, 60)`) and "a phone number, a name and a sentence are never
 * published" fails on the inline copies; print the exception message again
 * and "an exception publishes its class, never its message" fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { code, exceptionClass } from "./log-codes.mjs";

const WORKFLOW = readFileSync(new URL("../.github/workflows/agent-logs.yml", import.meta.url), "utf8");

/** The filters as the workflow ships them, pulled out of the YAML and made callable. */
function inlineShows() {
  const blocks = [...WORKFLOW.matchAll(/const NUMERIC = [\s\S]*?const show = \([\s\S]*?\);\n/g)].map((m) => m[0]);
  assert.equal(blocks.length, 2, `both steps should carry the filter inline; found ${blocks.length}`);
  // eslint-disable-next-line no-new-func
  return blocks.map((source) => new Function(`${source}\nreturn show;`)());
}

/** Values that must never reach a public page, whatever key they arrive under. */
const LEAKY = [
  "+1 (555) 123-4567",
  "Seyi Ogundipe",
  "could not read Bobs note about the divorce",
  "sk_live_9f2c1 rejected",
  "15551234567",
  "000000",
];
const CODES = ["group_decide", "no_group", "workflow_gave_up", "http_503", "whapi", "unbound"];

test("a phone number, a name, a sentence and a six-digit code are never published", () => {
  for (const value of LEAKY) {
    assert.equal(code(value), "other", `${value} must not be published`);
    for (const show of inlineShows()) assert.equal(show("reason", value), "other", `${value} must not be published`);
  }
});

test("the codes a Worker chose pass through unchanged", () => {
  for (const value of CODES) {
    assert.equal(code(value), value);
    for (const show of inlineShows()) assert.equal(show("reason", value), value);
  }
});

test("a duration, a count and a status still read as numbers, and only under their own keys", () => {
  for (const show of inlineShows()) {
    assert.equal(show("ms", 15032), "15032");
    assert.equal(show("ms", 12.5), "12.5");
    assert.equal(show("attempts", 3), "3");
    assert.equal(show("status", 503), "503");
    // The same digits under a key that carries words are not a number.
    assert.equal(show("reason", 503), "other");
  }
});

test("an exception publishes its class, never its message", () => {
  assert.equal(exceptionClass("TypeError: failed to fetch https://x/?token=sk_live_9f2c1"), "TypeError");
  assert.equal(exceptionClass("+1 555 123 4567 did not answer"), "unknown");
  // The first word of a thrown string is not a class, and can be a person.
  assert.equal(exceptionClass("Seyi Ogundipe could not be reached"), "unknown");
  assert.equal(exceptionClass("DOMException: aborted"), "DOMException");
  assert.equal(exceptionClass("Error: no group for this chat"), "Error");
  assert.doesNotMatch(WORKFLOW, /\$metadata\.error\)\.slice/, "the exception message must not be sliced and printed");
  assert.match(WORKFLOW, /exception \$\{\(String\(e\.\$metadata\.error\)\.match\(/, "the exception line should name the class only");
});

test("neither step strips characters out of a value instead of refusing it", () => {
  assert.doesNotMatch(WORKFLOW, /replace\(\/\[\^\\w ?\.:-\]\/g/, "a stripping filter publishes a readable phone number");
});
