/**
 * THE JOB-START CASES AND THEIR SCORING (`bench/jobstart.mjs`; Dev2, 2026-11-12: whether a job's start gets a line is
 * judged from example chats, not a rule).
 *
 * Sabotage record (2026-11-12), each applied, suite run, named test failing, reverted:
 *  1. a case's text copied into `JOB_START_EXAMPLES` → "the cases are held out from the examples" fails.
 *  2. `passes` ignoring the tapback rate → "both bars count" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { JOB_START_EXAMPLES } from "../../src/agent/jobStart.js";
import { caseBody, jobstartCommand, loadCases, passes, readStart } from "../jobstart.mjs";

test("the cases have unique ids, both labels in both kinds of chat", async () => {
  const cases = await loadCases();
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  for (const want of ["line", "tap"]) assert.ok(cases.filter((item) => item.want === want).length >= 4, want);
  for (const chat of ["group", "1:1"]) assert.ok(cases.some((item) => item.chat === chat), chat);
});

test("the cases are held out from the examples", async () => {
  for (const item of await loadCases()) assert.ok(!JOB_START_EXAMPLES.includes(item.text.replace(/^@\w+: /, "")), item.id);
});

test("a case reaches Haiku with the front door's job rules and examples, made to start a job", async () => {
  const [item] = await loadCases();
  const body = caseBody(item);
  assert.match(body.system, /Some starts need a line, some don't/);
  assert.deepEqual(body.tools.map((tool) => tool.name).sort(), ["restart_background_job", "start_background_job"]);
  assert.ok(body.tools.every((tool) => tool.input_schema.properties.say), "every job tool offers a say");
  assert.deepEqual(body.tool_choice, { type: "any" });
  assert.match(body.messages[0].content, new RegExp(item.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a start is read as a line or a tapback by what is texted, not by whether say was sent", () => {
  assert.equal(readStart({ content: [{ type: "tool_use", name: "start_background_job", input: { say: "  " } }] }).said, "tap");
  assert.equal(readStart({ content: [{ type: "tool_use", name: "start_background_job", input: { say: "On it." } }] }).said, "line");
  assert.equal(readStart({ content: [{ type: "text", text: "On it." }] }), null);
});

test("both bars count", () => {
  assert.equal(passes({ lineRate: 1, tapRate: 0.5 }), false);
  assert.equal(passes({ lineRate: 0.5, tapRate: 1 }), false);
  assert.equal(passes({ lineRate: 0.8, tapRate: 0.8 }), true);
});

test("--fake runs the plumbing end to end and passes on its own labels", async () => {
  let out = "";
  const row = await jobstartCommand({ fake: true }, { write: (text) => (out += text) });
  assert.ok(passes(row));
  assert.match(out, /passes/);
});
