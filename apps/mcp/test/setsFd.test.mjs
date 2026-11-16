import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { LIVE_SETTINGS, cantRun, earlierLines, fdTest, frontFor, runFd } from "../bench/setsFd.mjs";
import { parseTest } from "../bench/load.mjs";
import { parseSetup } from "../src/agent/production.js";

const BENCH = new URL("../bench/ai", import.meta.url).pathname;
const TREE = new URL("../../..", import.meta.url).pathname;

const conv = (msgs, more = {}) => ({ id: "c1", set: "dev", kind: "one", members: ["Maya"], world: "maya", msgs, ...more });
const chat = conv([
  { id: "m1", who: "Maya", text: "morning" },
  { id: "m2", who: "Tex", tex: true, text: "Morning!" },
  { id: "m3", who: "Maya", kind: "react", to: "m2", text: "❤️" },
  { id: "m4", who: "Maya", kind: "reply", to: "m2", text: "quick one" },
  { id: "m5", who: "Maya", text: "When's my dentist appointment?", labels: { fd: { must: ["say Tuesday, October 13 at 3 pm"], never: ["make up a date"], star: true } } },
]);
const unit = (c, at) => ({ convo: c, at, label: c.msgs[at].labels.fd, row: { chat: c.id, msg: c.msgs[at].id, at, node: "fd" } });

test("the chat before a Front door test goes in as it was, texts and replies only, the person's and Tex's", () => {
  assert.deepEqual(earlierLines(chat, 4), [
    { from: "person", text: "morning" },
    { from: "tex", text: "Morning!" },
    { from: "person", text: "quick one" },
  ]);
});

test("a test runs one text with the chat before it and its must and never lines, as the bench parses it", () => {
  const raw = fdTest([unit(chat, 4)], "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-08\nruns: 1\nweb: scripted");
  const q = parseTest(raw).questions[0];
  assert.equal(q.texts, "When's my dentist appointment?");
  assert.equal(q.personStarts, null, "one text: nobody plays the person after it");
  assert.equal(q.kind, "task");
  assert.deepEqual(q.must, ["say Tuesday, October 13 at 3 pm"]);
  assert.deepEqual(q.mustNot, ["make up a date"]);
  assert.deepEqual(q.earlier.map((l) => l.from), ["person", "tex", "person"]);
});

test("a person's tests run in their bench world, on its day, once, on the scripted web", async () => {
  const front = await frontFor(BENCH, "Maya");
  assert.match(front, /^run_as: Maya$/m);
  assert.match(front, /^today: 2026-10-08$/m, "the core set's day, which the Maya conversation's facts are on");
  assert.match(front, /^runs: 1$/m);
  assert.match(front, /^web: scripted$/m);
  assert.equal(await frontFor(BENCH, "Nobody Here"), null);
});

test("what can't run says why: a group chat, a tapback, a picture", () => {
  assert.equal(cantRun(chat, 4), null);
  assert.match(cantRun({ ...chat, kind: "group" }, 4), /group chat/);
  assert.match(cantRun(chat, 2), /react/);
  assert.match(cantRun(conv([{ id: "m1", who: "Maya", text: "this?", pics: [{ url: "https://x.test/a.png" }] }]), 0), /pictures/);
});

test("the live setup's settings parse as a texting setup, its models and words from Tex's config", async () => {
  const setup = await parseSetup(`---\n${LIVE_SETTINGS}\n---\n\nTex's rules.\n`);
  assert.ok(setup, "the stand-in setup parses");
  assert.equal(setup.job, "texting-assistant");
  assert.equal(setup.maxSteps, 24);
  assert.ok(setup.prompts?.texts?.length > 0, "the prompt words come from the config");
});

test("the batch runs each person's tests as one bench test and maps each judged case back to its row", async () => {
  const seen = [];
  const runTests = async (tree, tests, { dir, fake }) => {
    seen.push({ tests, fake, setup: await readFile(join(dir, "setups/texting-assistant/production.md"), "utf8"), raw: await readFile(join(dir, "tests", `${tests[0]}.md`), "utf8") });
    return { rows: [{ id: "sets-1/q1", right: true }, { id: "sets-1/q2", right: false }], usd: 0.02, bars: {}, missing: [] };
  };
  const two = conv([...chat.msgs, { id: "m6", who: "Maya", text: "and the plumber?", labels: { fd: { must: ["say Friday"], star: true } } }]);
  const group = { ...two, id: "g1", kind: "group" };
  const rows = await runFd([unit(two, 4), unit(two, 5), unit(group, 4)], { tree: TREE, fake: true, runTests });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].tests, ["sets-1"]);
  assert.match(seen[0].setup, /max_steps: 24/, "an unpulled tree runs with the live settings");
  assert.equal(parseTest(seen[0].raw).questions.length, 2);
  assert.deepEqual(rows.map((r) => [r.chat, r.msg, r.ran, r.right]), [
    ["g1", "m5", false, false],
    ["c1", "m5", true, true],
    ["c1", "m6", true, false],
  ]);
  assert.equal(rows[1].usd, 0.01);
});

test("a case the bench gave no answer for did not run, and the scratch folder is gone after", async () => {
  let scratch = null;
  const runTests = async (_tree, _tests, opts) => {
    scratch = opts.scratch;
    return { rows: [], usd: 0, bars: {}, missing: [] };
  };
  const rows = await runFd([unit(chat, 4)], { tree: TREE, runTests });
  assert.deepEqual(rows.map((r) => [r.ran, r.why]), [[false, "the bench gave no judged answer"]]);
  await assert.rejects(readFile(join(scratch, "ai/tests/sets-1.md")), "nothing of a conversation is left on disk");
});

test("the batch runs through the real bench on fake models end to end", async () => {
  const rows = await runFd([unit(chat, 4)], { tree: TREE, fake: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ran, true, rows[0].why);
});
