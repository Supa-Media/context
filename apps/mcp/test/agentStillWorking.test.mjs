/**
 * A JOB THAT ENDS SAYING IT IS STILL WORKING (`stillWorking.js`; a tester's
 * 1:1 chat, 2026-10-31). A profile-filling job ended its only pass on "I'm
 * filling in the profile from your resume, and I'll text you each answer",
 * was marked done, and the chat's turn passed that on as "still filling it
 * in" until it admitted it couldn't see the job's answers.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-31).
 *
 *  1. `announcesNextStep` without `stillWorking`. → "a job ending on its own
 *     work still going is sent back, then given another part" fails.
 *  2. `finishNotice` ignoring `answer`. → "the notice is about doing the task,
 *     not pricing" fails.
 *  3. `jobEnded` without the `held === 0` check. → "a last part still working
 *     is incomplete; one holding their yes is not" fails.
 *  4. `statusLine` without a finished job's report. → "the chat's turn is
 *     shown a finished job's steps and report, and told it isn't running"
 *     fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_JOB_ATTEMPTS, backgroundSession, jobEnded, jobReportPrompt, runningJobsOf } from "../src/agent/background.js";
import { claimCheck } from "../src/agent/claimCheck.js";
import { stillWorking } from "../src/agent/stillWorking.js";
import { unfinishedJob } from "../src/agent/stopsShort.js";

const NOW = 1_800_000_000_000;
const MERCOR =
  "Got it, that's already in your notes. Nothing's submitted yet. I'm filling in the profile from your resume, and I'll text you each answer before anything goes in. Nothing goes in until you 👍 it.";

test("words that say the job's own work is still going are caught", () => {
  for (const said of [
    MERCOR,
    "Still filling in your profile. Nothing's submitted.",
    "I'm signed in and I'm on the profile step.",
    "I'm working through the application now.",
    "The application is still in progress.",
    "I’ll text you the answers once I finish the last section.",
    "I'll report back when it's done.",
  ]) {
    assert.ok(stillWorking(said), said);
  }
});

test("a finished report, or a promise a routine keeps, is not caught", () => {
  for (const said of [
    "Filled in all six fields (below) and stopped at Submit, waiting for your yes.",
    "Saved the comparison: https://context.lc/n/models. None of the three beat Haiku.",
    "I'll send it once you say yes.",
    "I set a daily routine, so I'll text you when the price drops.",
    "I couldn't sign in: the site wants a code sent to your phone.",
  ]) {
    assert.equal(stillWorking(said), false, said);
  }
});

test("a job ending on its own work still going is sent back, then given another part", () => {
  const watch = claimCheck({ question: "fill in the profile", job: { attempt: 1 } });
  assert.match(watch.check(MERCOR), /nothing of the job is running/);
  assert.equal(unfinishedJob({ attempt: 1 }, MERCOR), true);
  assert.equal(unfinishedJob({ attempt: MAX_JOB_ATTEMPTS }, MERCOR), false, "the last part ends; `jobEnded` says how");
  // A chat turn saying "on it" beside a job it started is not a job's last word.
  assert.equal(claimCheck({ question: "fill in the profile" }).unfinished(MERCOR), false);
});

test("the notice is about doing the task, not pricing", () => {
  const notice = claimCheck({ question: "fill in the profile", job: { attempt: 1 } }).check(MERCOR);
  assert.match(notice, /every answer or field you filled in, word for word/);
  assert.doesNotMatch(notice, /search_web/);
});

test("a last part still working is incomplete; one holding their yes is not", () => {
  assert.deepEqual(jobEnded({ attempt: MAX_JOB_ATTEMPTS }, MERCOR, 0), { incomplete: true });
  assert.deepEqual(jobEnded({ attempt: MAX_JOB_ATTEMPTS }, MERCOR, 1), {});
  assert.deepEqual(jobEnded({ attempt: 1 }, MERCOR, 0), {}, "an earlier part gets another turn instead");
  assert.deepEqual(jobEnded(null, MERCOR, 0), {});
  assert.deepEqual(jobEnded({ attempt: MAX_JOB_ATTEMPTS }, "Filled in all six fields and stopped at Submit.", 0), {});
});

test("the chat's turn is shown a finished job's steps and report, and told it isn't running", () => {
  const running = runningJobsOf([
    {
      id: "job-profile-0001",
      title: "Fill in the profile",
      state: "done",
      startedAt: NOW - 30 * 60_000,
      finishedAt: NOW - 18 * 60_000,
      status: "Filled six fields.",
      steps: [{ at: NOW - 19 * 60_000, text: "browse type: Headline" }],
      result: "Headline: Staff engineer.\n\nWork location: hybrid.",
    },
  ]);
  const { prompt } = backgroundSession({ running, job: null, now: NOW });
  assert.match(prompt, /finished 18 min ago, not running any more/);
  assert.match(prompt, /browse type: Headline/);
  assert.match(prompt, /Headline: Staff engineer\./);
  assert.match(prompt, /never tell them it is still going/);
});

test("only the newest two finished reports are shown, and never a running job's", () => {
  const entry = (n, state = "done") => ({ id: `job-profile-000${n}`, title: `Job ${n}`, state, startedAt: NOW, result: `report ${n}` });
  const read = runningJobsOf([entry(1, "running"), entry(2), entry(3), entry(4)]);
  assert.deepEqual(read.map((job) => job.result), ["", "report 2", "report 3", ""]);
});

test("the coordinator is told a finished job's words about still working are not true", () => {
  assert.match(jobReportPrompt({ title: "Fill in the profile", state: "done", texts: [MERCOR] }), /nothing of it is running now/);
  assert.doesNotMatch(jobReportPrompt({ title: "Fill in the profile", state: "running", texts: ["Sign in here: https://x.example"] }), /nothing of it is running now/);
});
