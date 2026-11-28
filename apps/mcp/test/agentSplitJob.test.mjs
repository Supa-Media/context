/**
 * A split job is one job (Architect item #7, option C of `@supa products/tex/research/split-jobs-one-job-2026-11-24.md`):
 * the planner's parts carry one split, the overview's path and the plan's title (`packages/shared/src/jobSplit.cjs`);
 * the chat's list shows it as one job with its parts under it; job_status on its title shows every part; and "try
 * again" on any part, or on the split, picks back up every unfinished part. 2026-11-06: a split's "try again" resumed
 * only the part that had ended, so the MacBook ran alone for twelve minutes waiting on a partner that never started.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `restart` using the jobs matched by title alone (no `restartSet`).
 *     → "try again on one part picks back up every unfinished part of its split, and nothing else" fails.
 *  2. `planCall` not passing the split to `background.call`.
 *     → "the planner's parts carry one split, and a job the model starts never does" fails.
 *  3. The list drawn job by job (no `listedJobs`).
 *     → "the list shows a split as one job with its parts under it, and job_status on its title shows them all" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { RESTART_JOB_TOOL, JOB_STATUS_TOOL, START_JOB_TOOL, backgroundSession, runningJobsOf, startedJobs, withBackground } from "../../../packages/tex/gateway/agent/background.js";
import { PLAN_TOOL, planCall } from "../../../packages/tex/gateway/agent/planBigAsk.js";
import { decideSplit, restartSet, splitOf } from "../../../packages/shared/src/jobSplit.cjs";

const NOW = Date.UTC(2026, 10, 28, 15, 0, 0);
const words = (result) => result.content.map((part) => part.text).join("");
const SPLIT = { id: "1-projects/lisbon-trip/overview.md", title: "Lisbon trip" };
const job = (id, title, state, extra = {}) => ({ id, title, state, startedAt: NOW - 20 * 60_000, ...(state === "running" ? {} : { finishedAt: NOW - 60_000 }), steps: [], status: "", ...extra });
const FLIGHTS = job("job-flights-0001", "Find flights", "done", { split: SPLIT });
const STAY = job("job-stay-0001", "Find a flat", "failed", { split: SPLIT });
const DAYS = job("job-days-0001", "Plan the days", "waiting", { split: SPLIT, on: "mch_studio" });
const OTHER = job("job-other-0001", "Y Combinator application", "stuck");

test("a split is read strictly", () => {
  assert.deepEqual(splitOf(SPLIT), SPLIT);
  for (const bad of [null, "x", { id: "notes/x.txt", title: "X" }, { id: SPLIT.id, title: "" }, { id: "a\u0000.md", title: "X" }]) assert.equal(splitOf(bad), null);
  assert.deepEqual(runningJobsOf([{ ...STAY, split: SPLIT }, { ...OTHER, split: { id: "x", title: "y" } }]).map((entry) => entry.split), [SPLIT, null]);
});

test("the planner's parts carry one split, and a job the model starts never does", async () => {
  const background = backgroundSession({ running: [], job: null, now: NOW });
  const plan = { split: true, title: "Lisbon trip", goal: "", parts: [{ name: "flights", title: "Find flights", brief: "Flights." }, { name: "stay", title: "Find a flat", brief: "A flat." }] };
  background.plan = planCall({ model: "m", request: async () => ({ text: JSON.stringify(plan) }), history: [], question: "plan my lisbon week", background });
  const notes = new Map();
  const callTool = async (name, args) => (name === "write_note" ? (notes.set(args.path, args.content), { content: [] }) : name === "read_note" ? { content: [], isError: true } : { content: [{ type: "text", text: "" }] });
  const call = withBackground(background, callTool);
  assert.equal((await call(PLAN_TOOL, { ask: "plan my lisbon week", folder: "1-projects/lisbon-trip" })).isError, undefined);
  assert.deepEqual(startedJobs(background, false).jobs.map((each) => each.mail), [
    { path: SPLIT.id, name: "flights", split: "Lisbon trip" },
    { path: SPLIT.id, name: "stay", split: "Lisbon trip" },
  ]);
  const own = backgroundSession({ running: [], job: null, now: NOW });
  await withBackground(own, callTool)(START_JOB_TOOL, { title: "Book dinner", brief: "Dinner.", mail: { path: SPLIT.id, name: "dinner" }, split: "Lisbon trip" });
  assert.deepEqual(startedJobs(own, false).jobs[0].mail, { path: SPLIT.id, name: "dinner" }, "only the planner makes a split");
});

test("the list shows a split as one job with its parts under it, and job_status on its title shows them all", async () => {
  const background = backgroundSession({ running: runningJobsOf([FLIGHTS, STAY, DAYS, OTHER]), job: null, now: NOW });
  const listed = background.runningNow;
  assert.match(listed, /- "Lisbon trip": 3 parts\n {2}- "Find flights": finished[^\n]*\n {2}- "Find a flat": stopped[^\n]*\n {2}- "Plan the days": ended waiting/);
  assert.match(listed, /\n- "Y Combinator application": ended stuck/);
  const status = words(await withBackground(background, async () => ({ content: [] }))(JOB_STATUS_TOOL, { title: "Lisbon trip" }));
  for (const title of ["Find flights", "Find a flat", "Plan the days"]) assert.match(status, new RegExp(`"${title}"`));
  assert.doesNotMatch(status, /Y Combinator/);
});

test("try again on one part picks back up every unfinished part of its split, and nothing else", async () => {
  const background = backgroundSession({ running: runningJobsOf([FLIGHTS, STAY, DAYS, OTHER]), job: null, now: NOW });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.match(words(await dispatch(RESTART_JOB_TOOL, { titles: ["Find a flat"] })), /Picking "Find a flat", "Plan the days" back up/);
  assert.deepEqual(startedJobs(background, false).steers.map((steer) => steer.id), [STAY.id, DAYS.id], "the done part stays done; the other job is not touched");
  const bySplit = backgroundSession({ running: runningJobsOf([FLIGHTS, STAY, DAYS, OTHER]), job: null, now: NOW });
  await withBackground(bySplit, async () => ({ content: [] }))(RESTART_JOB_TOOL, { titles: ["lisbon trip"] });
  assert.deepEqual(startedJobs(bySplit, false).steers.map((steer) => steer.id), [STAY.id, DAYS.id], "the split's own title names every part");
});

test("the Split job node's rule answers the same set", () => {
  const entries = [FLIGHTS, STAY, DAYS, OTHER];
  assert.deepEqual(restartSet(entries, [STAY], (entry) => entry.state !== "done").map((entry) => entry.id), [STAY.id, DAYS.id]);
  assert.deepEqual(decideSplit({ entries, picked: [{ id: DAYS.id }], resumable: [STAY.id, DAYS.id, OTHER.id] }), { restart: [STAY.id, DAYS.id] });
  assert.deepEqual(decideSplit({ entries, picked: [{ id: OTHER.id }], resumable: [OTHER.id] }), { restart: [OTHER.id] }, "a job on its own is itself");
});
