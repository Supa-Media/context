// `pnpm ai improve` (`bench/improve.mjs`): the step after a scored round that
// drafts one experiment from the failures, and never promotes or runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseSetup } from "../../src/agent/production.js";
import { parseTest } from "../load.mjs";
import { applyEdits, draftName, draftWith, experimentNote, failuresOf, improveFile, testNames } from "../improve.mjs";

const RUN = join(dirname(fileURLToPath(import.meta.url)), "..", "run.mjs");
const execFileAsync = promisify(execFile);

const LIVE = [
  "---",
  "job: texting-assistant",
  "models:",
  "  main: anthropic/claude-haiku-5-5",
  "from: guide-haiku",
  "live_since: 2026-10-14",
  "promoted_by: seyi",
  "---",
  "",
  "You are a test assistant.",
  "Answer from the notes.",
  "",
].join("\n");
const TEST = [
  "---",
  "run_as: Ana",
  "runs: 1",
  "good_enough:",
  "  score: 100%",
  "---",
  "",
  "## 1. When is my dentist appointment?",
  "",
  "- kind: task",
  "- must: say Tuesday at Harbor Dental",
  "- must not: send a text to Ruth",
  "",
].join("\n");

test("an edit applies only when its find is in the file exactly once, and changes something", () => {
  assert.equal(applyEdits(LIVE, [{ find: "Answer from the notes.", replace: "Answer from the notes, first." }]).text.includes("first."), true);
  assert.match(applyEdits(LIVE, [{ find: "Answer from the web.", replace: "x" }]).error, /not in the file/);
  assert.match(applyEdits("a\na\n", [{ find: "a", replace: "b" }]).error, /more than once/);
  assert.match(applyEdits(LIVE, [{ find: "Answer", replace: "Answer" }]).error, /change nothing/);
  assert.match(applyEdits(LIVE, []).error, /no edits/);
});

test("a draft that names the test's people or places is refused; a month, a weekday or a sentence's first word is not a name", () => {
  const names = testNames(parseTest(TEST).questions);
  assert.ok(names.has("Ruth") && names.has("Harbor") && names.has("Dental"), [...names].join(","));
  assert.ok(!names.has("Tuesday") && !names.has("When"), [...names].join(","));
  const leak = applyEdits(LIVE, [{ find: "Answer from the notes.", replace: "Answer from the notes. Ruth's dentist is Harbor Dental." }], names);
  assert.match(leak.error, /names (?=.*Ruth)(?=.*Harbor)(?=.*Dental)/);
  const general = applyEdits(LIVE, [{ find: "Answer from the notes.", replace: "Answer from the notes, and give the place with the time." }], names);
  assert.equal(general.error, undefined);
});

test("the improver is asked again with the reason, and its usable draft is the one kept", async () => {
  const asked = [];
  const replies = [
    { title: "Bad", change: "c", why: "w", edits: [{ find: "not there", replace: "x" }] },
    { title: "Model", change: "c", why: "w", edits: [{ find: "anthropic/claude-haiku-5-5", replace: "anthropic/not-a-model" }] },
    { title: "Good", change: "c", why: "w", edits: [{ find: "Answer from the notes.", replace: "Answer from the notes, with the place." }] },
  ];
  const ask = async (messages) => {
    asked.push(messages.map((m) => m.content).join("\n"));
    const draft = replies[asked.length - 1];
    return { draft, reply: JSON.stringify(draft), used: { input: 10, output: 5 } };
  };
  const request = { messages: [{ role: "user", content: "Draft one change." }] };
  const { draft, text, usage } = await draftWith({ ask, request, setupRaw: LIVE, names: new Set() });
  assert.equal(draft.title, "Good");
  assert.ok(text.includes("with the place"));
  assert.deepEqual(usage, { input: 30, output: 15 });
  assert.match(asked[1], /not in the file/, "the second ask says why the first draft was refused");
  assert.match(asked[2], /not a setup the gateway can read/, "a draft the gateway would refuse is sent back too");
});

test("three unusable drafts end the improve with the last reason, and nothing is written", async () => {
  const ask = async () => ({ draft: { title: "t", change: "c", why: "w", edits: [] }, reply: "{}", used: null });
  await assert.rejects(draftWith({ ask, request: { messages: [] }, setupRaw: LIVE, names: new Set() }), /no usable draft after 3 attempts: the draft has no edits/);
});

test("the experiment note drops how live got there and says what it changed, who made it and from what", async () => {
  const text = applyEdits(LIVE, [{ find: "Answer from the notes.", replace: "Answer from the notes, with the place." }]).text;
  const note = experimentNote(text, { job: "texting-assistant", basedOn: "production", draft: { title: "Give the place", change: "Adds the place.", why: "Case 1 left it out." }, by: "improver (claude-opus-5-5, from r)" });
  for (const gone of ["from: guide-haiku", "live_since:", "promoted_by:"]) assert.ok(!note.includes(gone), `${gone} is live's bookkeeping`);
  for (const kept of ["based_on: production", "change: Adds the place.", "why: Case 1 left it out.", "made_by: improver (claude-opus-5-5, from r)", "title: Give the place", "main: anthropic/claude-haiku-5-5"]) {
    assert.ok(note.includes(kept), `${kept} in\n${note}`);
  }
  assert.ok(await parseSetup(note), "the gateway reads the experiment");
  assert.equal(draftName("Give the place first", new Set(["give-the-place-first"])), "give-the-place-first-2");
});

test("only the failed lines of the setup's own runs are shown, never a judge line or another setup's", () => {
  const questions = new Map(parseTest(TEST).questions.map((q) => [q.n, q]));
  const key = [
    { id: "a", setup: "production", question: 1, run: 1 },
    { id: "b", setup: "other", question: 1, run: 1 },
  ];
  const verdict = (pass) => ({ skipped: null, verdicts: [{ kind: "must", line: "say Tuesday at Harbor Dental", pass, reason: "said Monday" }, { kind: "judge", line: "warm", pass: false, reason: "cold" }] });
  const judged = new Map([["a", verdict(false)], ["b", verdict(false)]]);
  const answer = { conversation: [{ from: "person", text: "dentist?" }, { from: "assistant", text: "Monday." }], toolsLine: "Tools: search_notes", changes: [] };
  const answers = new Map([["a", answer], ["b", answer]]);
  const failures = failuresOf({ setup: "production", key, judged, answers, questions });
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].runs[0].failed, [{ kind: "must", line: "say Tuesday at Harbor Dental", reason: "said Monday" }]);
  assert.equal(JSON.stringify(failures).includes('"a"'), false, "no answer id");
  judged.set("a", verdict(true));
  assert.equal(failuresOf({ setup: "production", key, judged, answers, questions }).length, 0);
});

/** An invented folder, the round run, judged and scored with the scripted model. */
async function scoredRound(testText = TEST) {
  const dir = await mkdtemp(join(tmpdir(), "bench-improve-"));
  const files = {
    "README.md": "# Bench\n",
    "workspaces/people.md": "| Person | Workspace | Role |\n|---|---|---|\n| Ana | ana (personal) | owner |\n",
    "workspaces/ana/health/dentist.md": "Dentist Tuesday 3 pm at Harbor Dental\n",
    "tests/texting-assistant.md": testText,
    "setups/texting-assistant/production.md": LIVE,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  const out = join(dir, "result.md");
  for (const args of [["run", "texting-assistant", "--out", out], ["judge", out], ["score", out]]) {
    await execFileAsync(process.execPath, [RUN, ...args, "--dir", dir, "--fake"], { timeout: 120000 });
  }
  return { dir, out };
}

test("a scored round's failures become one experiment beside live, read by the gateway; live is untouched", async () => {
  const { dir, out } = await scoredRound();
  try {
    const { stdout } = await execFileAsync(process.execPath, [RUN, "improve", out, "--dir", dir, "--fake"], { timeout: 120000 });
    const name = stdout.trim();
    assert.equal(name, "say-the-answer-first");
    const folder = join(dir, "setups", "texting-assistant");
    assert.deepEqual((await readdir(folder)).sort(), ["production.md", `${name}.md`]);
    assert.equal(await readFile(join(folder, "production.md"), "utf8"), LIVE, "the improver never edits live");
    const draft = await readFile(join(folder, `${name}.md`), "utf8");
    assert.ok(draft.includes("based_on: production") && draft.includes("made_by: improver (scripted, from result)"), draft);
    assert.ok(await parseSetup(draft));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a draft over --max-usd is refused before any call", async () => {
  const { dir, out } = await scoredRound();
  try {
    const send = async () => assert.fail("no call over the cap");
    await assert.rejects(improveFile({ path: out, dir, maxUsd: 0.0001, send, log: () => {} }), /over --max-usd 0.0001/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a setup that failed nothing and met every bar has nothing to improve, and spends nothing", async () => {
  const easy = "---\nrun_as: Ana\nruns: 1\ngood_enough:\n  score: 0%\n  price: under $10 a question\n  speed: under 1000 s\n  texts: 10 or fewer\n---\n\n## 1. Hello?\n\n- kind: lookup\n";
  const { dir, out } = await scoredRound(easy);
  try {
    const send = async () => assert.fail("nothing to improve is never a call");
    assert.equal(await improveFile({ path: out, dir, send, log: () => {} }), null);
    assert.deepEqual(await readdir(join(dir, "setups", "texting-assistant")), ["production.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
