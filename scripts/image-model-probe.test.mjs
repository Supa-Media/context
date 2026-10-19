/**
 * The probe prints the provider's error into a job log, and this repository
 * is public, so what it prints has to be bounded the way
 * `safeErrorDetail` bounds the forward sync's (`forwardSyncSupport.ts`): a
 * provider writes prose, and prose quotes identifiers.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   printing `body.error.message` raw → "a quoted identifier never reaches
 *     the log" fails.
 *   cutting on any quote character → "an apostrophe inside a word is not a
 *     quote" fails (the 403 that prompted the probe says "doesn't").
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { safeProviderMessage } from "./image-model-probe.mjs";

test("a quoted identifier never reaches the log", () => {
  const quota =
    "Quota exceeded for quota metric 'Generate requests' and limit " +
    "'Generate requests per minute per project' of service " +
    "'generativelanguage.googleapis.com' for consumer 'project_number:123456789012'.";
  const safe = safeProviderMessage(quota);
  assert.match(safe, /^Quota exceeded for quota metric/, "what it is still reads");
  assert.doesNotMatch(safe, /123456789012/, "the project number is cut");
  assert.doesNotMatch(safe, /generativelanguage/, "the service host is cut");
  assert.doesNotMatch(safe, /project_number/, "and so is the field naming it");
});

test("an apostrophe inside a word is not a quote", () => {
  // The 403 that sent us looking: it is the whole diagnosis, and it must survive.
  const refused =
    "Method doesn't allow unregistered callers (callers without established identity). " +
    "Please use API Key or other form of API consumer identity to call this API.";
  assert.equal(safeProviderMessage(refused), refused);

  // Two of them in one sentence is the case that tells a real quote apart from
  // an apostrophe: cutting between them eats the sentence and leaves nothing
  // said. (One apostrophe alone does not, which is why the line above cannot
  // carry this check by itself.)
  const twice = "Method doesn't allow this caller, and the project's quota isn't set.";
  assert.equal(safeProviderMessage(twice), twice);
});

test("a quote opening the message is still a quote", () => {
  assert.equal(safeProviderMessage("'project_number:123456789012' is not permitted."), "… is not permitted.");
});

test("an address, a path and a long number are cut wherever they sit", () => {
  const safe = safeProviderMessage(
    "Caller tex@example.test on projects/987654321098/locations/us lacks access; see https://cloud.example/help#x",
  );
  assert.doesNotMatch(safe, /example\.test|987654321098|projects\/|https/, safe);
  assert.match(safe, /lacks access/, "the sentence still says what happened");
});

test("nothing, and something enormous, both come back printable", () => {
  assert.equal(safeProviderMessage(undefined), "");
  assert.equal(safeProviderMessage(null), "");
  assert.ok(safeProviderMessage(`x${"y".repeat(5_000)}`).length <= 400);
});
