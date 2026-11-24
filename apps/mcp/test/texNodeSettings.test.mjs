/**
 * A code step declares its own settings, and the config holds their values (Dev2, 2026-11-23: "code nodes should be
 * able to define their own parameters ... display that in the UI, and agents are able to tweak those parameters";
 * `packages/tex/src/texNodeSettings.cjs`, docs/decisions/texting-assistant/step-settings.md).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-23):
 *   stepSettingsProblems call removed from configProblems     "a setting nothing declares is refused" fails
 *   draftStep no longer copying settings                      "a Lab draft's setting is the one a test chat runs on" fails
 *   tooWordy back to MAX_PROSE_WORDS                          "the prose limit is Answer check's setting" fails
 *   sendTheReply calling withoutFlattery unconditionally      "Text them reads its own two settings" fails (now Finish the text)
 *   draftProblems no longer calling stepSettingsProblems      "tex_dev check names a step setting" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { STEP_SETTINGS, declarationProblems, stepSettingProblem, stepSettings } from "../../../packages/tex/src/texNodeSettings.cjs";
import { configProblems } from "../../../packages/tex/src/texConfigSchema.cjs";
import { TEX_CONFIG, withDraft } from "../../../packages/tex/gateway/agent/texConfig.js";
import { replyFindings } from "../../../packages/tex/gateway/agent/replyChecks.js";
import { draftProblems } from "../../../packages/lab/gateway/texDev/check.js";

const src = (file) => readFileSync(new URL(`../../../packages/tex/gateway/agent/${file}`, import.meta.url), "utf8");
const copy = (x) => JSON.parse(JSON.stringify(x));
const withSettings = (id, settings) => {
  const config = copy(TEX_CONFIG);
  config.nodes.find((n) => n.id === id).settings = settings;
  return config;
};

test("every declaration is sound: a kind, words for the Lab, and a default its own bounds allow", () => {
  assert.deepEqual(declarationProblems(), []);
  assert.ok(declarationProblems({ x: { n: { type: "number", default: 9, min: 1, max: 5, label: "N", tip: "t" } } }).length > 0, "a default out of bounds is caught");
});

test("main's config gives each declared setting a value, and only declared ones", () => {
  assert.deepEqual(configProblems(TEX_CONFIG), []);
  for (const [id, declared] of Object.entries(STEP_SETTINGS)) {
    const node = TEX_CONFIG.nodes.find((n) => n.id === id);
    assert.ok(node, `${id} is a step`);
    assert.deepEqual(Object.keys(node.settings ?? {}).sort(), Object.keys(declared).sort(), `${id} names every setting it declares`);
    for (const [name, decl] of Object.entries(declared)) assert.equal(node.settings[name], decl.default, `${id}.${name} ships on its default`);
  }
});

test("a setting nothing declares is refused, and so is a value outside its declaration", () => {
  assert.match(configProblems(withSettings("finish", { trimFlattery: true, linkSavedNote: true, made_up: 1 })).join("; "), /setting nothing reads: made_up/);
  assert.match(configProblems(withSettings("finish", { trimFlattery: "yes" })).join("; "), /trimFlattery must be true or false/);
  assert.match(configProblems(withSettings("claimChecks", { proseWords: 5 })).join("; "), /proseWords must be from 20 to 400/);
  assert.match(configProblems(withSettings("claimChecks", { proseWords: 70.5 })).join("; "), /proseWords must be a whole number/);
  assert.match(configProblems(withSettings("fd", { anything: true })).join("; "), /step "fd" has a setting nothing reads/);
  assert.equal(stepSettingProblem("claimChecks", "proseWords", 120), null);
});

test("a step's settings fill in each default, and a bad value reads as its default", () => {
  assert.deepEqual(stepSettings(withSettings("finish", {}), "finish"), { trimFlattery: true, linkSavedNote: true, dropStaleAnswer: true });
  assert.deepEqual(stepSettings(withSettings("finish", { trimFlattery: false }), "finish"), { trimFlattery: false, linkSavedNote: true, dropStaleAnswer: true });
  assert.equal(stepSettings(withSettings("claimChecks", { proseWords: 9999 }), "claimChecks").proseWords, 70);
  assert.deepEqual(stepSettings(TEX_CONFIG, "fd"), {}, "a step that declares none has none");
});

test("a Lab draft's setting is the one a test chat runs on; a value its declaration refuses is dropped", () => {
  const draft = copy(TEX_CONFIG);
  draft.nodes.find((n) => n.id === "finish").settings = { trimFlattery: false, linkSavedNote: "nope", dropStaleAnswer: true };
  const ran = withDraft(TEX_CONFIG, draft);
  assert.deepEqual(stepSettings(ran, "finish"), { trimFlattery: false, linkSavedNote: true, dropStaleAnswer: true });
});

test("the prose limit and the words beside a page are Answer check's settings", () => {
  const essay = Array.from({ length: 12 }, () => "This sentence has exactly eight words in it.").join(" ");
  const fails = (words) => replyFindings({ question: "what's up", words })(essay, []).some((f) => f.kind === "wordy");
  assert.equal(fails({}), true, "96 words is over the default 70");
  assert.equal(fails({ proseWords: 120 }), false, "a limit of 120 lets it through");
  assert.equal(fails({ proseWords: 40 }), true);
});

test("Finish the text reads its own settings before it trims, links or drops (no constant does it unasked)", () => {
  const finish = src("texEntryPoint/finishTheText.js");
  assert.match(finish, /settingsOf\(env, "finish"\)/);
  assert.match(finish, /finishSet\.trimFlattery === true \? withoutFlattery\(replied\) : replied/);
  assert.match(finish, /finishSet\.linkSavedNote !== true \|\|/);
  assert.match(finish, /finishSet\.dropStaleAnswer === true && claims\?\.stale\(\) === true/);
  assert.doesNotMatch(src("texEntryPoint/sendTheReply.js"), /withoutFlattery|withSavedLink/, "Text them only delivers");
  const prepare = src("texEntryPoint/prepareTheAnswer.js");
  assert.match(prepare, /settingsOf\(env, "claimChecks"\)/);
  assert.match(prepare, /words: claimSet/);
  assert.match(prepare, /claimSet\.onTexts === true/);
});

test("tex_dev check names a step setting its code refuses, and passes one it declares", () => {
  const ok = copy(TEX_CONFIG);
  ok.nodes.find((n) => n.id === "claimChecks").settings = { proseWords: 120, besideResultWords: 30 };
  assert.deepEqual(draftProblems(ok), []);
  const bad = copy(TEX_CONFIG);
  bad.nodes.find((n) => n.id === "claimChecks").settings = { proseWords: 1000, besideResultWords: 30 };
  assert.match(draftProblems(bad).join("; "), /promote: step "claimChecks" setting proseWords must be from 20 to 400/);
});
