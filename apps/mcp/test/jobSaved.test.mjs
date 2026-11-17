/**
 * A job's progress saved between parts, on the gateway's side (`src/agent/jobSaved.js`; Dev2's "jobs as config"
 * plan, part B, 2026-11-17): every return streamed with its result and whether it is held, each draft streamed before
 * its checks, a died turn's cause typed, and the next part told to start from what was saved.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `withJobSteps` dropping `result` → "a job's tool step carries what it returned, held and outside".
 *  2. `diedOf` always "crash" → "a turn whose send-back loop ran out dies as check_limit".
 *  3. `savedPrompt` leaving out the held line → "the next part is told to use what was saved, not redo it".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { jobOf, jobPrompt, jobStatusText, runningJobsOf, withJobSteps } from "../src/agent/background.js";
import { diedOf, streamTurn } from "../src/agent/progress.js";
import { endsOf, savedOf, withJobDrafts } from "../src/agent/jobSaved.js";

const JOB = { id: "job-1234-abcd", title: "Timecards", brief: "Check the timecards.", attempt: 2 };

async function lines(response) {
  return (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("a job's tool step carries what it returned, held and outside", async () => {
  const sent = [];
  let outside = false;
  const observe = withJobSteps(JOB, async (text, how) => void sent.push({ text, how }), null, () => outside);
  observe({ kind: "tool", name: "search", args: { query: "timecards" }, ok: true, result: "2 emails from payroll" });
  outside = true;
  observe({ kind: "tool", name: "send_email", args: { to: "boss@example.com" }, ok: true, held: true, result: "Held for their yes" });
  observe({ kind: "thinking", text: "hmm" });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].how.result, "2 emails from payroll");
  assert.equal(sent[0].how.outside, undefined);
  assert.deepEqual({ held: sent[1].how.held, outside: sent[1].how.outside, failed: sent[1].how.failed }, { held: true, outside: true, failed: undefined });
  // Any other turn is unchanged.
  assert.equal(withJobSteps(null, async () => {}, null), null);
});

test("each draft goes down a job's stream before its checks, and a check is otherwise untouched", async () => {
  const sent = [];
  const check = async (draft) => (draft === "bad" ? "send it back" : null);
  const wrapped = withJobDrafts(JOB, async (text, how) => void sent.push({ text, how }), check);
  assert.equal(await wrapped("bad", {}), "send it back");
  assert.equal(await wrapped("No rows this week.", {}), null);
  assert.deepEqual(sent, [{ text: "", how: { draft: "bad" } }, { text: "", how: { draft: "No rows this week." } }]);
  assert.equal(withJobDrafts(null, async () => {}, check), check);
});

test("the stream carries results, held marks and drafts as lines of their own", async () => {
  const out = await lines(
    streamTurn(async (_progress, step) => {
      await step("Searched mail", { result: "2 emails", held: false });
      await step("Sent an email", { held: true, result: "Held", outside: true });
      await step("", { draft: "No rows." });
      await step("", {});
      return Response.json({ answer: "Done." });
    }),
  );
  assert.deepEqual(out.filter((line) => !("tick" in line)), [
    { step: "Searched mail", result: "2 emails" },
    { step: "Sent an email", result: "Held", held: true, outside: true },
    { draft: "No rows." },
    { status: 200, body: { answer: "Done." } },
  ]);
});

test("a turn whose send-back loop ran out dies as check_limit; anything else as crash", async () => {
  const loop = Object.assign(new Error('texGraph: "answerCheck" sent work back to "fd" more than 2 times'), { name: "GraphError" });
  assert.equal(diedOf(loop), "check_limit");
  assert.equal(diedOf(Object.assign(new Error("texGraph: no node"), { name: "GraphError" })), "crash");
  assert.equal(diedOf(new Error("x")), "crash");
  const out = await lines(
    streamTurn(async () => {
      throw loop;
    }),
  );
  assert.deepEqual(out, [{ status: 500, body: { error: "server_error", cause: "check_limit" } }]);
});

test("the next part is told to use what was saved, not redo it", () => {
  const job = jobOf({
    ...JOB,
    saved: {
      calls: [
        { part: 1, step: "Searched mail for timecards", result: "2 emails" },
        { part: 1, step: "Sent an email to boss@example.com", held: true, result: "Held for their yes" },
        { part: 1, step: "" },
        "junk",
      ],
      draft: "No timecard rows this week.",
    },
  });
  assert.equal(job.saved.calls.length, 2);
  const prompt = jobPrompt(job);
  assert.match(prompt, /already made these calls/);
  assert.match(prompt, /part 1: Searched mail for timecards\n {2}returned: <<<2 emails>>>/);
  assert.match(prompt, /HELD for their yes/);
  assert.match(prompt, /don't make it again/);
  assert.match(prompt, /wrote this draft before it ended, never sent:\n<<<\nNo timecard rows this week\.\n>>>/);
  // A replaced or unfinished draft (`draft`) is the one it builds on; the saved one is not said twice.
  assert.doesNotMatch(jobPrompt(jobOf({ ...JOB, draft: "Earlier answer.", saved: { calls: [], draft: "Other." } })), /Other\./);
  assert.equal(savedOf({ calls: [] }), null);
  assert.equal(jobPrompt(jobOf(JOB)).includes("already made these calls"), false);
});

test("job_status says the part it is on and how each part ended", () => {
  const [job] = runningJobsOf([{ id: "job-1234-abcd", title: "Timecards", state: "running", startedAt: 1, part: 3, ends: [{ part: 1, cause: "check_limit" }, { part: 2, cause: "crash" }, { part: 9, cause: "bogus" }] }]);
  assert.equal(job.part, 3);
  assert.deepEqual(job.ends, [{ part: 1, cause: "check_limit" }, { part: 2, cause: "crash" }]);
  const said = jobStatusText(job, 2);
  assert.match(said, /On part 3\. How its parts ended: part 1: ran out of answer-check rounds .*; part 2: crashed before it answered\./);
  const [plain] = runningJobsOf([{ id: "job-1234-abcd", title: "Timecards", state: "running", startedAt: 1 }]);
  assert.doesNotMatch(jobStatusText(plain, 2), /part/i);
  assert.deepEqual(endsOf("x"), []);
});
