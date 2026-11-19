/**
 * A FINISHED JOB'S REPORT IS HANDED OVER, NOT RE-WORKED (2026-11-19;
 * `src/agent/jobHandoff.js`). A report that asks to be presented leads with
 * its key fact and link; a brief that drops part of the ask, or a booking
 * with no live re-check, is sent back once a turn.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `presentNotice` returning null: "an answer with no link gets the notice" fails;
 *  - `briefNotice` returning null: "a thin brief is sent back once" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { backgroundSession } from "../src/agent/background.js";
import { jobReportPrompt } from "../src/agent/jobReport.js";
import {
  BRIEF_NOTICE_PREFIX,
  PRESENT_NOTICE,
  PRESENT_START_REFUSAL,
  briefNotice,
  presentCheck,
  presentNotice,
  presentsFinished,
  reportLinks,
} from "../src/agent/jobHandoff.js";

const LINK = "projects/oven-vendors/comparison.page.md";
const done = (texts, extra = {}) => ({ id: "job-1", title: "Oven vendors", state: "done", texts: [texts], ...extra });
const PRESENTING = done(`Page written: ${LINK}. Key fact: Hearthline is $4,200 installed, cheapest of three. Present to Marisol.`);
const NOW = Date.UTC(2026, 10, 19, 14, 0, 0);
const words = (result) => result.content.map((part) => part.text).join("");

test("a finished report with a page link that asks to be presented is handed over", () => {
  assert.deepEqual(reportLinks(PRESENTING), [LINK]);
  assert.deepEqual(presentsFinished(PRESENTING), [LINK]);
  assert.match(presentNotice(PRESENTING, "Which vendor should I pick?"), /Lead with the key fact/);
  assert.match(presentNotice(PRESENTING, "Hearthline is the cheapest, at $4,200 installed."), /Lead with the key fact/);
  assert.equal(presentNotice(PRESENTING, `Hearthline is cheapest at $4,200 installed: ${LINK}`), null);
});

test("a report that is not finished, or has no link, is never handed over", () => {
  for (const state of ["failed", "stuck", "waiting", "running"]) {
    const report = { ...PRESENTING, state };
    assert.equal(presentsFinished(report), null, state);
    assert.equal(presentNotice(report, "Which vendor?"), null, state);
  }
  const noLink = done("Key fact: Hearthline is cheapest. Present to Marisol.");
  assert.equal(presentsFinished(noLink), null);
  assert.equal(presentsFinished(null), null);
});

test("the coordinator prompt gets the handover line only on a presenting done report", () => {
  const line = /ready to present, with its page link/;
  assert.match(jobReportPrompt(PRESENTING), line);
  assert.doesNotMatch(jobReportPrompt({ ...PRESENTING, state: "running" }), line);
  assert.doesNotMatch(jobReportPrompt(done("Finished the list of ovens.")), line);
});

test("presentCheck fires once, then delegates to the inner check", () => {
  const seen = [];
  const inner = { takesFindings: true, wrap: (call) => call, check: (answer) => (seen.push(answer), "inner finding") };
  const checked = presentCheck(PRESENTING, inner);
  assert.equal(checked.takesFindings, true);
  assert.equal(checked.check("Which vendor?"), PRESENT_NOTICE);
  assert.equal(checked.check("Still nothing here."), "inner finding");
  assert.deepEqual(seen, ["Still nothing here."]);
  assert.equal(presentCheck({ ...PRESENTING, state: "running" }, inner), inner);
});

test("a presenting report's turn is refused a new job once, then the job goes through", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW, presenting: true, question: "" });
  const refused = await background.call({ title: "Oven follow-up", brief: "Compare two more vendors." });
  assert.equal(refused.isError, true);
  assert.equal(words(refused), PRESENT_START_REFUSAL);
  assert.equal(background.started.length, 0);
  assert.notEqual((await background.call({ title: "Oven follow-up", brief: "Compare two more vendors." })).isError, true);
});

test("briefNotice sends back a brief that drops a site, its login or a live re-check", () => {
  const question = "Book the 7am train to Albany for Dev on amtrak.com, log in with the team account";
  const thin = briefNotice({ question, brief: "Book the morning train to Albany." });
  assert.match(thin, new RegExp(`^${BRIEF_NOTICE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(thin, /amtrak\.com/);
  assert.match(thin, /login/);
  assert.match(thin, /live price/);
  assert.equal(briefNotice({ question, brief: "Log in to amtrak.com with the team account from the vault, re-check the live fare, then book the 7am train to Albany for Dev." }), null);
  assert.equal(briefNotice({ question: "Summarise the Q3 notes into a page", brief: "Write the summary of the Q3 notes." }), null);
});

test("a thin booking brief is sent back once a turn; the second identical call goes on", async () => {
  const question = "Book the 7am train to Albany for Dev on amtrak.com, log in with the team account";
  const background = backgroundSession({ running: [], job: null, now: NOW, question });
  const brief = "Book the morning train to Albany.";
  const first = await background.call({ title: "Albany train", brief });
  assert.equal(first.isError, true);
  assert.match(words(first), /amtrak\.com/);
  const second = await background.call({ title: "Albany train", brief });
  assert.notEqual(second.isError, true);
  assert.doesNotMatch(words(second), /Not started yet/);
});
