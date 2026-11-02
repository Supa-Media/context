/**
 * A JOB'S REPORT NEVER TEXTS A CONTROL WORD, AND AN ENDED JOB IS NEVER MET
 * WITH SILENCE (`jobReport.js`, 2026-10-31). Self-reviews fa3f7a and a0365e:
 * "SKIP" stood as Tex's reply to three job reports, two of them finished
 * jobs (a YC application, toll totals) whose results never reached the
 * person. Route checks: `agentBackgroundRoute.test.mjs`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `reportReply` treating every state as running.
 *     → "a finished job's bare SKIP becomes its status line" fails.
 *  2. `isControlWord` matching NONE in any case.
 *     → "None. answers a question and is a text" fails.
 *  3. `resultOf` cutting without carrying the link.
 *     → "a long result keeps its link" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isControlWord, jobReportPrompt, reportReply, reportStatusLine } from "../src/agent/jobReport.js";

const running = { title: "Trip plan", state: "running", texts: ["Saving now."] };
const done = { title: "Toll totals", state: "done", texts: ["You paid $84.50 in tolls since August."] };

test("control words alone are never a text, in any dress", () => {
  for (const word of ["SKIP", "skip.", "[SKIP]", "(skip)", "NOOP", "no-op", "NO_REPLY", "QUIET", "NONE", "null", " Skip! "]) assert.equal(isControlWord(word), true, word);
});

test("None. answers a question and is a text, as is a sentence that uses the word", () => {
  for (const words of ["None.", "none", "Skip the meeting today", "Done.", ""]) assert.equal(isControlWord(words), false, words);
});

test("a running job's report met with SKIP, or nothing, is quiet: a flag and no words", () => {
  assert.deepEqual(reportReply(running, "SKIP"), { answer: "", quiet: true });
  assert.deepEqual(reportReply(running, "Nothing new here. SKIP"), { answer: "", quiet: true });
  assert.deepEqual(reportReply(running, ""), { answer: "", quiet: true });
  assert.deepEqual(reportReply(running, "Still saving, one sec."), { answer: "Still saving, one sec.", quiet: false });
});

test("a finished job's bare SKIP becomes its status line, with its result", () => {
  assert.deepEqual(reportReply(done, "SKIP"), { answer: "Done: Toll totals. You paid $84.50 in tolls since August.", quiet: false });
  assert.deepEqual(reportReply(done, "NOOP"), { answer: "Done: Toll totals. You paid $84.50 in tolls since August.", quiet: false });
  assert.deepEqual(reportReply(done, ""), { answer: "Done: Toll totals. You paid $84.50 in tolls since August.", quiet: false });
});

test("an ended job's own words go without the control word around them", () => {
  assert.equal(reportReply(done, "Tolls came to $84.50. SKIP").answer, "Tolls came to $84.50.");
  assert.equal(reportReply(done, "SKIP: tolls came to $84.50.").answer, "tolls came to $84.50.");
});

test("every ended state names itself plainly", () => {
  assert.match(reportStatusLine({ title: "Mercor", state: "failed", texts: [] }), /^"Mercor" stopped before it finished\.$/);
  assert.match(reportStatusLine({ title: "Mercor", state: "waiting", texts: ["Needs your code."] }), /needs something from you[^]*Needs your code\./);
  assert.match(reportStatusLine({ title: "Mercor", state: "stuck", texts: [] }), /got stuck\.$/);
});

test("a long result keeps its link", () => {
  const link = "https://context.lc/note/@maya/tolls.page.md";
  const line = reportStatusLine({ title: "Tolls", state: "done", texts: [`${"word ".repeat(200)}${link}`] });
  assert.ok(line.length < 720 && line.endsWith(link), line);
});

test("only a running job's report is offered SKIP", () => {
  assert.match(jobReportPrompt(running), /answer exactly SKIP: nothing is texted/);
  for (const state of ["done", "failed", "waiting", "stuck"]) {
    const prompt = jobReportPrompt({ ...done, state });
    assert.match(prompt, /Never answer SKIP/);
    assert.doesNotMatch(prompt, /answer exactly SKIP/);
  }
});

test("any turn that is not a report keeps its answer exactly", () => {
  assert.deepEqual(reportReply(null, "SKIP"), { answer: "SKIP", quiet: false });
});
