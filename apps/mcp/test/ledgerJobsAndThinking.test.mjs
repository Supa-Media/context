/**
 * WHAT A JOB, THE ADVISOR AND THE MAIL CHECKER DID, IN THE CHAT'S ONE HISTORY
 * (decided by the owner, 2026-11-02, on a decision card: "In the chat's
 * history, tagged"; and "'Its private reasoning isn't kept.' - why?").
 *
 *  - A job's turn writes into the chat's ledger like any turn, every entry
 *    marked with the job (`agent/ledger.js` `jobTagged`), so the history can
 *    show or hide a job's work and a job's page can show only its own.
 *  - The advisor is asked for its thinking in words and it is kept beside its
 *    answer: on the `ask_advisor` tool entry, and on a job check's `advisor`
 *    entry. It never reaches Tex or the texting Worker.
 *  - The Mail checker's whole answer is kept on its `mail_check` entry.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-02):
 *  1. `jobTagged` returning the writer unchanged → "a job's turn marks
 *     everything it writes" fails.
 *  2. The `jobs: false` clause dropped from `texLedger.read` → "a read keeps
 *     one job's work, or none" fails.
 *  3. `display: "summarized"` left off the advisor's request → "the advisor
 *     is asked for its thinking" fails.
 *  4. `jobChecked` passing `thinking` back with the fields → "a job check's
 *     thinking is kept in the history, never handed to the Worker" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { jobTagged, toolEntry } from "../src/agent/ledger.js";
import { advisorThinking, advisorTools } from "../src/agent/advisor.js";
import { checkJob, jobFields } from "../src/agent/jobCheck.js";
import { jobChecked, mailEntry, mailVerdict } from "../src/agent/workEntries.js";
import { mailCheckerFor } from "../src/agent/mailChecker.js";
import { texLedger } from "../src/texStore/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";
import { texEntryPointSource } from "./texEntryPointSource.mjs";

function fakeLedger() {
  const entries = [];
  return { entries, write: (list) => void entries.push(...(Array.isArray(list) ? list : [list]).filter(Boolean)), flush: async () => {} };
}

test("a job's turn marks everything it writes with the job; another turn's writer is left as it is", async () => {
  const base = fakeLedger();
  const tagged = jobTagged(base, { id: "job-7", title: "Code transactions" });
  tagged.write({ id: "a", kind: "tool", name: "browse" });
  tagged.write([{ id: "b", kind: "thinking", text: "next page" }, null]);
  await tagged.flush();
  assert.deepEqual(base.entries.map((e) => [e.id, e.jobId, e.jobTitle]), [["a", "job-7", "Code transactions"], ["b", "job-7", "Code transactions"]]);
  assert.equal(jobTagged(base, null), base);
  assert.equal(jobTagged(null, { id: "job-7" }), null);
});

test("a read keeps one job's work, or none, and leaves the chat's own lines", () => {
  const ledger = texLedger(durableSql());
  const at = 1_700_000_000_000;
  ledger.append("texts", [
    { id: "t1", kind: "text", at, text: "code these" },
    { id: "j0", kind: "job", at, job: "job-7", title: "Code", state: "started" },
    { id: "w1", kind: "tool", at, name: "browse", jobId: "job-7" },
    { id: "w2", kind: "tool", at, name: "browse", jobId: "job-8" },
    { id: "t2", kind: "text", at, text: "done" },
  ]);
  assert.deepEqual(ledger.read("texts", { job: "job-7" }).entries.map((e) => e.id), ["j0", "w1"]);
  assert.deepEqual(ledger.read("texts", { jobs: false }).entries.map((e) => e.id), ["t1", "j0", "t2"]);
  assert.deepEqual(ledger.read("texts").entries.map((e) => e.id), ["t1", "j0", "w1", "w2", "t2"]);
  assert.deepEqual(ledger.read("texts", { job: "x' OR 1=1 --" }).entries.length, 5, "a malformed job id is no filter, never SQL");
});

test("the advisor is asked for its thinking, and it is kept on its tool entry beside the answer", async () => {
  const asked = [];
  const [{ call }] = advisorTools({
    model: "claude-opus-5-5",
    history: [],
    question: "book now?",
    request: async (params) => (asked.push(params), { text: "Ask first.", content: [{ type: "thinking", thinking: "They said wait for Jo." }, { type: "text", text: "Ask first." }] }),
  });
  const result = await call({});
  assert.equal(asked[0].display, "summarized");
  assert.equal(result.content[0].text, "Ask first.", "Tex reads the answer only");
  assert.equal(result.thinking, "They said wait for Jo.");
  const entry = toolEntry({ name: "ask_advisor", args: {}, ok: true, ms: 5, result: "Ask first.", thinking: result.thinking }, { ownSlug: "seyi" });
  assert.equal(entry.thinking, "They said wait for Jo.");
  assert.equal(toolEntry({ name: "read_note", args: {}, ok: true, ms: 1, result: "x" }, { ownSlug: "seyi" }).thinking, undefined);
  assert.equal(advisorThinking({ content: null }), "");
});

test("a job check's thinking is kept in the history, never handed to the Worker", async () => {
  const check = await checkJob({
    job: { id: "job-7", title: "Code", brief: "b", finish: "f" },
    live: null,
    answer: "Did page one.",
    model: "claude-opus-5-5",
    request: async (params) => (assert.equal(params.display, "summarized"), { text: "VERDICT: keep_going\nADVICE: Page two.", content: [{ type: "thinking", thinking: "Only page one is done." }] }),
  });
  assert.equal(check.thinking, "Only page one is done.");
  const ledger = fakeLedger();
  const fields = await jobChecked({ ledger }, { job: { id: "job-7", title: "Code" } }, async () => jobFields(check, { exhausted: false, unfinished: false }));
  assert.equal(fields.thinking, undefined, "the Worker's answer carries no thinking");
  assert.equal(fields.verdict, "keep_going");
  const advisor = ledger.entries.find((e) => e.kind === "advisor");
  assert.equal(advisor.thinking, "Only page one is done.");
});

test("the Mail checker's whole answer is kept with its verdict", async () => {
  const check = mailCheckerFor({ history: [], question: "email Jo", config: {}, request: async () => ({ text: '{"verdict": "no", "reason": "they said Thursday"}' }) });
  const checked = await check({ to: ["jo@example.com"], cc: [], subject: "Fri", body: "See you Friday" });
  assert.equal(checked.answer, '{"verdict": "no", "reason": "they said Thursday"}');
  const verdict = mailVerdict(checked);
  assert.deepEqual(verdict, { verdict: "stopped", why: "they said Thursday", answer: checked.answer });
  assert.equal(mailEntry({ to: ["jo@example.com"] }, verdict).answer, checked.answer);
  assert.equal(mailEntry({ to: ["jo@example.com"] }, { verdict: "sent" }).answer, undefined);
});

test("the route marks a job's turn's ledger, the one its steps, answer and checks are written through", async () => {
  const route = texEntryPointSource();
  assert.match(route, /if \(job !== null && store\.ledger\) store\.ledger = session\.ledger = jobTagged\(store\.ledger, job\);/);
});
