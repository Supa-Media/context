/**
 * The no-shadow steps (Dev2, 2026-11-23: "we should not be having shadow code. Everything should live inside of a
 * node"; Lab draft vmwtgxyawavru): Finish the text, Claim checks, Reply reviewer, Still answers them? and Tool rules are
 * steps of Tex's config, each running the code that used to run unseen inside another step.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-24):
 *   finishTheText.js trimming flattery whatever its setting      "Finish the text trims ... only while its switch is on" fails
 *   nodes/finish.js finishing a routine's run                     "Finish the text leaves a routine's run" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { finishNode } from "../../../packages/tex/gateway/agent/graph/nodes/finish.js";
import { LAB_SANDBOX_KEY } from "../src/labSandbox/policy.js";

const src = (file) => readFileSync(new URL(`../../../packages/tex/gateway/agent/${file}`, import.meta.url), "utf8");
const node = (id) => TEX_CONFIG.nodes.find((n) => n.id === id);
const wired = (from, to, mode) => TEX_CONFIG.edges.some((e) => e.from === from && e.to === to && e.mode === mode);

/** A reply turn Text them would build, as `sendTheReply.js` reads it, with `answer` as the model's words. */
function replyTurn(answer, env = {}) {
  return {
    env,
    turn: { answer, steps: [], timing: {} },
    drafts: {},
    group: null,
    job: null,
    report: null,
    runner: false,
    claims: null,
    setAside: [],
    ledger: { asked: [], offered: null },
    outgoing: { take: (words) => ({ answer: words, pictures: [], captions: [] }) },
    tex: { step: (_name, run) => run() },
    opened: null,
    noteLinking: null,
    store: null,
    session: null,
  };
}
const draftEnv = (id, settings) => {
  const draft = JSON.parse(JSON.stringify(TEX_CONFIG));
  draft.nodes.find((n) => n.id === id).settings = settings;
  return { [LAB_SANDBOX_KEY]: { record: () => {}, config: draft } };
};

test("main's config draws the five steps on the wires the draft drew, with Text them after Finish the text", () => {
  for (const id of ["claimChecks", "reviewer", "finish", "recheck", "toolRules"]) assert.equal(node(id)?.on, true, `${id} is a step, on`);
  assert.ok(wired("answerCheck", "claimChecks", "uses") && wired("answerCheck", "reviewer", "uses"));
  assert.ok(wired("answerCheck", "finish", "wait") && wired("finish", "send", "wait"));
  assert.ok(!wired("answerCheck", "send", "wait"), "nothing goes from the checks to Text them without Finish the text");
  assert.ok(wired("send", "recheck", "uses") && wired("tools", "toolRules", "uses"));
  assert.equal(node("recheck").model, "clef");
  assert.equal(node("reviewer").model, "haiku-5-5");
});

test("Finish the text makes the reply's words, and Text them only delivers them", async () => {
  const t = replyTurn("Absolutely, 3pm works.");
  const out = await finishNode({}, { ctx: { turn: t } });
  assert.deepEqual(out.when, ["finished"]);
  assert.equal(t.finished.sent, "3pm works.", "main trims the opener, as Text them did");
  assert.equal(out.chars, "3pm works.".length);
  assert.ok(!JSON.stringify(out).includes("3pm"), "its row carries counts, never the words");
  const send = src("texEntryPoint/sendTheReply.js");
  assert.match(send, /t\.finished \?\? \(await tex\.step\("finish_text", \(\) => finishTheText\(t\)\)\)/);
  assert.doesNotMatch(send, /withoutFlattery|withSavedLink|answerWithAsk/);
});

test("Finish the text trims flattery only while its switch is on", async () => {
  const t = replyTurn("Absolutely, 3pm works.", draftEnv("finish", { trimFlattery: false, linkSavedNote: true, dropStaleAnswer: true }));
  await finishNode({}, { ctx: { turn: t } });
  assert.equal(t.finished.sent, "Absolutely, 3pm works.");
});

test("Finish the text leaves a routine's run, a check-in's look and an answer already made to Text them", async () => {
  for (const extra of [{ runner: true }, { finishCheckIn: () => {} }, { drafts: undefined }, { response: new Response("x") }]) {
    const t = { ...replyTurn("Absolutely."), ...extra };
    assert.deepEqual((await finishNode({}, { ctx: { turn: t } })).when, ["as-is"]);
    assert.equal(t.finished, undefined);
  }
});

test("Tool rules' switches decide whether each rule wraps the call", () => {
  const run = src("texEntryPoint/runTheModel.js");
  assert.match(run, /settingsOf\(env, "toolRules"\)/);
  assert.match(run, /withSameAsk\(\{ on: claims !== null && toolRules\.sameAsk === true,/);
  assert.match(run, /ruled\(toolRules\.noteLinks, withNoteLinks\)\(ruled\(toolRules\.folderFit, withFolderFit\)\(/);
});
