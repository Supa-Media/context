/**
 * TEX'S TOOLS MAY ONLY GET BETTER AGAINST THE FOUR TOOL RULES (Dev2, 2026-11-20; `packages/tex/src/toolRules.cjs`,
 * audit: Context @supa projects/tex/tool-rules-audit.md).
 *
 * `baseline.json` is today's measure, read off real turns (`toolRules/report.mjs`). Nothing may get worse than it,
 * and anything new must pass outright. A fix that makes a number better rewrites the baseline with
 * `node scripts/tool-rules.mjs --write`, so the ceiling comes down with it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { toolRulesReport } from "./toolRules/report.mjs";
import rules from "../../../packages/tex/src/toolRules.cjs";

const BASELINE = JSON.parse(readFileSync(new URL("./toolRules/baseline.json", import.meta.url), "utf8"));
const FIX = "fix it, or after a fix that makes it better run `node scripts/tool-rules.mjs --write`";
let report;
before(async () => {
  report = await toolRulesReport();
});

test("rule 1: one chat's kinds of turn are never shown more tool lists than they are today", () => {
  for (const [chat, now] of Object.entries(report.fixedList)) {
    const was = BASELINE.fixedList[chat] ?? { lists: 1, differ: [] };
    assert.ok(now.lists <= was.lists, `${chat}: its turns (${now.kinds.join(", ")}) were shown ${now.lists} different tool lists, more than ${was.lists}; ${FIX}`);
    const newlyDiffer = now.differ.filter((tool) => !was.differ.includes(tool));
    assert.deepEqual(newlyDiffer, [], `${chat}: these tools now differ between its kinds of turn: ${newlyDiffer.join(", ")}. A tool a turn can't use returns a clear error instead (rule 1)`);
  }
});

test("rule 2: no tool a model is shown grows, and a new one stays under the limit", () => {
  const check = (where, tools, was) => {
    for (const [tool, chars] of Object.entries(tools)) {
      const ceiling = Math.max(rules.TOOL_CHAR_LIMIT, was?.[tool] ?? 0);
      assert.ok(chars <= ceiling, `${where} ${tool}: ${chars} characters of description and schema, over ${ceiling} (limit ${rules.TOOL_CHAR_LIMIT}); ${FIX}`);
    }
  };
  for (const [surface, tools] of Object.entries(report.sizes)) check(surface, tools, BASELINE.sizes[surface]);
  check("MCP", report.mcp, BASELINE.mcp);
});

test("rule 3: no shell tool, and no more of Tex's state saved by a plain note write", () => {
  assert.deepEqual(report.state.shells, [], `a Tex tool or send action is named like a shell: ${report.state.shells.join(", ")}`);
  const added = report.state.generic.filter((file) => !BASELINE.state.generic.includes(file));
  assert.deepEqual(added, [], `these state files have no dedicated action: ${added.join(", ")}`);
});

test("rule 4: no file has more errors that don't say what to do next", () => {
  const grew = Object.entries(report.errors.notActionableByFile)
    .filter(([file, count]) => count > (BASELINE.notActionableByFile[file] ?? 0))
    .map(([file, count]) => `${file}: ${count} (was ${BASELINE.notActionableByFile[file] ?? 0})`);
  assert.deepEqual(grew, [], `errors that don't say what to do next grew (end each with the step to take, e.g. "Use X, then try again."): ${grew.join("; ")}`);
});

test("the error rating reads the audit's examples as Dev2's rule does", () => {
  assert.equal(rules.rateError("The computer is asleep. Use Shell or Read to wake it, then try again."), "actionable");
  assert.equal(rules.rateError("not found"), "not");
  assert.equal(rules.rateError("not one of the actions it was given"), "not");
  assert.equal(rules.rateError("send has no action X for you. Yours: say_nothing."), "partial");
  assert.equal(rules.rateError("A check-in looks in their own workspace only."), "not");
  assert.equal(rules.rateError("write_note can't pass context from a group chat."), "not");
  assert.equal(rules.rateError("this workspace is busy right now; try again in a few seconds"), "actionable");
});

test("the measure is the model's: a tool's description plus its schema", () => {
  assert.equal(rules.toolChars({ description: "abc", input_schema: { type: "object" } }), 3 + JSON.stringify({ type: "object" }).length);
  assert.equal(rules.toolChars({ description: "abc", inputSchema: { a: 1 } }), 3 + 7);
  assert.equal(rules.stateFileOf("tex/routines/daily/brief.md")?.file, "tex/routines/");
  assert.equal(rules.stateFileOf("projects/x.md"), null);
});
