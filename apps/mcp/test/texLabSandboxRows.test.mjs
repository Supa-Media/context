// Invalid-row and model-fallback accounting is one implementation for the GitHub Lab run and the Lab sandbox's bench
// run (apps/mcp/bench/rowAccounting.mjs, apps/mcp/bench/sandboxRows.mjs; plan products/tex/research/
// sandbox-bench-scoring-2026-11-19.md, must-have: "implemented through the same code paths").
//
// What these prove: the same units, answered the same way (one turn fell back to another model, one could not run, one
// ran clean, one ran out of credit), come out of the GitHub run's path (a result note with the bench's fallback tools
// line, `judgeFile`, `coreCases`, `collectConvo`, `resultsOf`) and the sandbox's path (`sandboxRow` from the gateway's
// turn, then `resultsOf`) with the same fallback count, the same validity and why, the same rows that could not run,
// and the same per-row `ran` and `fallbacks`. The judge is the bench's scripted one: no model is called.
//
// Sabotage (temporary local edits, reverted, 2026-11-24):
//   rowAccounting.mjs `fallbackToolsOf` keeping no entries               "the same units come out ..." fails
//   rowAccounting.mjs `couldNotRunRow` leaving `ran` unset               "the same units come out ..." fails
//   sandboxRows.mjs writing no assistant line for a quiet turn           "a sandbox turn that stayed quiet ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { fakeJudge, judgeFile } from "../bench/judge.mjs";
import { coreCases } from "../bench/coreArea.mjs";
import { frontMatter } from "../bench/resultNote.mjs";
import { keyMarkdown, keyPathFor, resultMarkdown } from "../bench/report.mjs";
import { fallbackTool } from "../bench/rowAccounting.mjs";
import { fdTest, frontFor } from "../bench/setsFd.mjs";
import { collectConvo } from "../bench/setsFdRows.mjs";
import { BENCH_DIR, sandboxRow } from "../bench/sandboxRows.mjs";
import { benchUnits } from "../../../packages/lab/src/labRunSets.mjs";
import { resultsOf } from "../../../scripts/tex-lab-run.mjs";

// A made-up 1:1 with four Front door tests, as a Training conversation is written (fake words only).
const CONV = {
  id: "fake-errands",
  title: "Errands",
  set: "training",
  kind: "one",
  members: ["Maya"],
  setting: "Maya texts Tex about errands.",
  msgs: [
    { id: "m1", who: "Maya", text: "remind me to buy batteries tomorrow", at: "Mon 10:00", labels: { fd: { must: ["says it will remind Maya about batteries"], star: true } } },
    { id: "m2", who: "Tex", tex: true, text: "Will do." },
    { id: "m3", who: "Maya", text: "what was the plumber's number again", at: "Mon 10:05", labels: { fd: { must: ["gives the plumber's number or says it can't find it"], star: true } } },
    { id: "m4", who: "Tex", tex: true, text: "I couldn't find it." },
    { id: "m5", who: "Maya", text: "add milk to the shopping list", at: "Mon 10:10", labels: { fd: { must: ["adds milk to the shopping list"], star: true } } },
    { id: "m6", who: "Tex", tex: true, text: "Added." },
    { id: "m7", who: "Maya", text: "thanks, also cancel the dentist", at: "Mon 10:15", labels: { fd: { must: ["says it cancelled the dentist"], star: true } } },
  ],
};
const UNITS = benchUnits([CONV], 1);
const CREDIT = "bench gateway keys out of credit: credit balance is too low";
// What happened to each unit's turn, on either runner.
const STORY = [
  { said: ["I'll remind you about the batteries tomorrow."], fallback: { model: "glm-example", status: 529 } },
  { error: "the turn failed: the model gateway answered 500" },
  { said: ["Added milk to the shopping list."] },
  { error: CREDIT },
];

/** The GitHub run's path: one test a unit, the bench's answer with its trace's fallback line, judged and collected. */
async function githubRows(scratch) {
  const rows = [];
  for (const [k, u] of UNITS.entries()) {
    const story = STORY[k];
    const row = { chat: u.chat, msg: u.msg, at: u.at, node: "fd", rep: u.rep };
    const name = `sets-${k + 1}`;
    if (story.error) {
      rows.push(...collectConvo({ rows: [], runDir: null, tests: [{ name, group: [{ row }], error: new Error(story.error) }] }));
      continue;
    }
    const ai = join(scratch, "gh", "ai");
    await mkdir(join(ai, "tests"), { recursive: true });
    const front = await frontFor(BENCH_DIR, "Maya", { today: "2026-11-24", setting: CONV.setting });
    const testRaw = fdTest([{ convo: CONV, at: u.at, label: CONV.msgs[u.at].labels.fd, row }], front, null);
    await writeFile(join(ai, "tests", `${name}.md`), testRaw);
    const path = join(scratch, "gh", `${name}.md`);
    const text = CONV.msgs[u.at].text;
    // `world.mjs` writes a trace's fallback with `fallbackTool`, as the sandbox's ledger step is written.
    const run = { setup: "production", question: 1, run: 1, questionText: text, as: "Maya", kind: "task", conversation: [{ from: "person", text }, ...story.said.map((t) => ({ from: "assistant", text: t }))], tools: story.fallback ? [fallbackTool(story.fallback)] : [], ms: 10, texts: story.said.length };
    const result = { job: "texting-assistant", test: name, testVersion: "t1", date: "2026-11-24", today: "2026-11-24", commit: "c1", setups: [{ name: "production", version: "v1", model: "claude-sonnet-5-5" }], runs: [run], keyFile: basename(keyPathFor(path)), resultFile: basename(path) };
    await writeFile(path, resultMarkdown(result));
    await writeFile(keyPathFor(path), keyMarkdown(result));
    await judgeFile({ path, dir: ai, send: fakeJudge() });
    const resultRaw = await readFile(path, "utf8");
    const keyRaw = await readFile(join(dirname(path), frontMatter(resultRaw).key), "utf8");
    rows.push(...collectConvo({ rows: [], runDir: null, tests: [{ name, group: [{ row }], got: coreCases({ test: name, testRaw, resultRaw, keyRaw }) }] }));
  }
  return rows;
}

/** The sandbox's path: the gateway's turns (`benchTurn.js` `turnOf` shapes), each made a row by `sandboxRow`. */
async function sandboxRows(scratch) {
  const rows = [];
  for (const [k, u] of UNITS.entries()) {
    const story = STORY[k];
    const turn = story.error
      ? { ran: false, error: story.error, ms: 3 }
      : { ran: true, said: story.said, tools: [], changes: [], usage: [], fallbacks: story.fallback ? [{ kind: "step", step: "fallback", model: story.fallback.model, input: { status: story.fallback.status } }] : [], ms: 10, at: Date.parse("2026-11-24T12:00:00Z") };
    rows.push(await sandboxRow({ unit: u, conv: CONV, turn, scratch: join(scratch, "sb"), send: fakeJudge() }));
  }
  return rows;
}

test("the same units come out of the GitHub path and the sandbox path with the same invalid and fallback accounting", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lab-rows-"));
  try {
    assert.equal(UNITS.length, STORY.length);
    const gh = await githubRows(scratch);
    const sb = await sandboxRows(scratch);
    const per = (rows) => rows.map((r) => ({ chat: r.chat, at: r.at, rep: r.rep, ran: r.ran, fallbacks: r.fallbacks ?? 0, why: r.why ?? null }));
    assert.deepEqual(per(sb), per(gh), "row by row: ran, fallbacks and why");
    const a = resultsOf(gh, 1000, null, { models: "gw" });
    const b = resultsOf(sb, 1000, null, { models: "gw" });
    assert.equal(a.fallbacks, 1);
    assert.equal(b.fallbacks, a.fallbacks, "the same fallback count");
    assert.equal(a.valid, false);
    assert.equal(b.valid, a.valid, "the same validity");
    assert.equal(b.invalid, a.invalid, "the same reason it is not Tex's score");
    assert.match(a.invalid, /Claude calls could not run/, "the out-of-credit row marks the run, on both");
    assert.deepEqual(b.couldNotRun.map((c) => [c.convId, c.msgIndex, c.why]), a.couldNotRun.map((c) => [c.convId, c.msgIndex, c.why]));
    assert.equal(b.couldNotRun.length, 2);
    assert.equal(b.total, a.total, "the same rows counted");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a sandbox turn that stayed quiet is judged as the bench judges a quiet turn, never as an answer the judge skips", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lab-rows-"));
  try {
    const quiet = { ran: true, said: [], quiet: true, quietWhy: "The chat object took the text (queued) and Tex sent nothing.", tools: [], changes: [], usage: [], fallbacks: [], ms: 5, at: Date.now() };
    // A test whose right answer is to stay quiet: the judge must see the quiet marker to pass it.
    const hush = { ...CONV, id: "fake-hush", msgs: [{ id: "h1", who: "Maya", text: "ok thanks", labels: { fd: { must: ["stayed quiet"], star: true } } }] };
    const row = await sandboxRow({ unit: { i: 0, chat: "fake-hush", msg: "h1", at: 0, node: "fd", rep: 0 }, conv: hush, turn: quiet, scratch, send: fakeJudge() });
    assert.equal(row.ran, true, `judged (${row.why ?? ""})`);
    assert.equal(row.right, true, `the judge read the quiet marker (${row.got ?? ""})`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a fallback-free sandbox run is valid exactly when the GitHub run on the same rows is", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "lab-rows-"));
  try {
    const clean = { ran: true, said: ["Added milk to the shopping list."], tools: [], changes: [], usage: [{ model: "claude-sonnet-5-5", input: 1000, output: 100 }], fallbacks: [], ms: 5, at: Date.now() };
    const row = await sandboxRow({ unit: UNITS[2], conv: CONV, turn: clean, scratch, send: fakeJudge() });
    assert.equal(row.ran, true);
    assert.equal(row.fallbacks, undefined);
    assert.ok(row.usd > 0, "Tex's usage is priced as the bench prices an answer");
    const results = resultsOf([row], 10, null, { models: "gw" });
    assert.equal(results.valid, true);
    assert.equal(results.fallbacks, 0);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
