/**
 * What a chat's turn was handed when a job reported back is kept in the chat's
 * history before the model reads it (`workEntries.js` `reportEntry`): on
 * 2026-11-05 Tex texted that it "can't read" a computer job's report, and the
 * history held nothing to show what the turn had been given.
 *
 * Sabotage: `jobReportOf` dropping `id` fails the first check; `reportEntry`
 * dropping the job's words fails the second.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { jobReportOf } from "../src/agent/jobReport.js";
import { reportEntry } from "../src/agent/workEntries.js";

const body = (jobReport) => ({ event: "job_report", jobReport });

test("a report names its job, read strictly", () => {
  const report = jobReportOf(body({ id: "j25dcf950", title: "Log in to GitHub", state: "failed", texts: ["I couldn't start it: that folder isn't on it."] }), { chatTurn: true, job: null });
  assert.equal(report.id, "j25dcf950");
  assert.equal(jobReportOf(body({ id: "../x y", title: "T", state: "done", texts: ["ok"] }), { chatTurn: true, job: null }).id, undefined);
});

test("the history keeps the report's job, title, state and the job's own words", () => {
  const entry = reportEntry({ id: "j25dcf950", title: "Log in to GitHub", state: "failed", texts: ["I couldn't start it.", "Fix the folder."] }, { turn: "86b27c3f-1a6d-4d7f", at: 1 });
  assert.equal(entry.kind, "job");
  assert.equal(entry.job, "j25dcf950");
  assert.equal(entry.state, "failed");
  assert.equal(entry.turn, "86b27c3f-1a6d-4d7f");
  assert.equal(entry.report, "I couldn't start it.\n\nFix the folder.");
});
