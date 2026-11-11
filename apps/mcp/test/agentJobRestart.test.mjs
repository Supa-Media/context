/**
 * "Restart all 3" picks the stopped jobs back up where they stopped
 * (`background.js` `restart`, Dev2 2026-10-31). Before, the chat started one
 * brand-new job per text, each working from the restart text instead of the
 * task, and all three said "it's running again" until they stopped.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `restart` with no titles picking running and finished jobs too.
 *     → "no more than three run at once, counting the ones picked up" fails.
 *  2. `call` picking a stopped job back up when a new job is named like it.
 *     → "a new job named like one that stopped is a new job, with its own brief" fails.
 *  3. `startedJobs` leaving out the resumed jobs.
 *     → "restart with no titles picks up every job that stopped, in one call, and the turn ends at once" fails.
 *  4. `resume` past the running limit.
 *     → "no more than three run at once, counting the ones picked up" fails.
 *  5. `endsTurn` texting "On it" again for a start or restart.
 *     → "a start or restart texts nothing, ever" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RUNNING_JOBS, QUIET_ACK, RESTART_JOB_TOOL, START_JOB_TOOL, backgroundSession, startedJobs, withBackground } from "../src/agent/background.js";

const NOW = Date.UTC(2026, 9, 31, 17, 0, 0);
const job = (title, state, extra = {}) => ({ id: `job-${title.replace(/\W/g, "").toLowerCase()}-0001`, title, state, startedAt: NOW - 20 * 60_000, ...(state === "running" ? {} : { finishedAt: NOW - 60_000 }), steps: [], verdict: null, advice: "", result: "", status: "", ...extra });
const words = (result) => result.content.map((part) => part.text).join("");

const A16Z = job("a16z Speedrun application", "failed");
const YC = job("Y Combinator application", "stuck");
const TOLL = job("Total toll charges paid", "waiting");
const DONE = job("Trip plan", "done");

test("restart with no titles picks up every job that stopped, in one call, and the turn ends at once", async () => {
  const background = backgroundSession({ running: [A16Z, YC, TOLL, DONE], job: null, now: NOW });
  assert.ok(background.tools.some((tool) => tool.name === RESTART_JOB_TOOL));
  assert.match(background.runningNow, /a call to send with action restart_job, all of them in one call/);
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.match(words(await dispatch(RESTART_JOB_TOOL, {})), /Picking "a16z Speedrun application", "Y Combinator application", "Total toll charges paid" back up/);
  assert.equal(background.endsTurn(RESTART_JOB_TOOL), QUIET_ACK, "nothing is texted");
  assert.equal(background.endsTurn(RESTART_JOB_TOOL), null, "settled once");
  assert.deepEqual(startedJobs(background, false), { steers: [A16Z, YC, TOLL].map((entry) => ({ id: entry.id, resume: true })) }, "a finished job is not picked up; no new job starts");
});

test("named titles pick up only those, and a running or finished one is refused", async () => {
  const background = backgroundSession({ running: [A16Z, YC, job("Logo", "running"), DONE], job: null, now: NOW });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.equal((await dispatch(RESTART_JOB_TOOL, { titles: ["Trip plan", "Logo"] })).isError, true);
  await dispatch(RESTART_JOB_TOOL, { titles: ["y combinator application"] });
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: YC.id, resume: true }] });
});

test("a new job named like one that stopped is a new job, with its own brief", async () => {
  // Dev2, 2026-11-11: a stuck job's report turn started "… (retry with link)" with the link the job lacked; it was matched
  // to the stuck job, which resumed without the link, stuck again, and texted "On it: picking … back up" three times.
  const background = backgroundSession({ running: [YC], job: null, now: NOW });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.match(words(await dispatch(START_JOB_TOOL, { title: "Y Combinator application (retry with link)", brief: "The form is at https://example.com/apply." })), /Started in the background/);
  const handed = startedJobs(background, false);
  assert.equal(handed.steers, undefined, "the stopped job is not picked back up");
  assert.equal(handed.jobs.length, 1);
  assert.equal(handed.jobs[0].brief, "The form is at https://example.com/apply.", "the new brief is the job's");
  assert.equal(background.endsTurn(START_JOB_TOOL), QUIET_ACK);
});

test("no more than three run at once, counting the ones picked up", async () => {
  const background = backgroundSession({ running: [job("One", "running"), job("Two", "running"), A16Z, YC], job: null, now: NOW });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  const said = words(await dispatch(RESTART_JOB_TOOL, {}));
  assert.match(said, /No room for "Y Combinator application" yet: 3 run at once/);
  assert.equal(MAX_RUNNING_JOBS, 3);
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: A16Z.id, resume: true }] });
  const full = backgroundSession({ running: [job("One", "running"), job("Two", "running"), job("Three", "running"), A16Z], job: null, now: NOW });
  assert.equal((await withBackground(full, async () => ({ content: [] }))(RESTART_JOB_TOOL, {})).isError, true);
  assert.deepEqual(startedJobs(full, false), {});
});

test("nothing to restart: offered but refused in code, and a job's own turn never gets it", async () => {
  const none = backgroundSession({ running: [job("Logo", "running"), DONE], job: null, now: NOW });
  assert.ok(none.tools.some((tool) => tool.name === RESTART_JOB_TOOL), "offered every text, so the cached tool list never changes");
  const refused = await withBackground(none, async () => ({ content: [] }))(RESTART_JOB_TOOL, {});
  assert.equal(refused.isError, true);
  assert.match(words(refused), /No background job stopped before finishing/);
  assert.deepEqual(backgroundSession({ running: [A16Z], job: { id: "job-x-0001", title: "x" }, now: NOW }).tools, []);
});

test("a start or restart texts nothing, ever", async () => {
  // Dev2, 2026-11-11: "why does tex report back to us what its doing? No one actually cares". The text they sent gets a
  // tapback instead (`texEntryPoint/sendTheReply.js`); they hear the job's result and nothing before it.
  const restarted = backgroundSession({ running: [YC], job: null, now: NOW });
  assert.equal(restarted.tools.find((tool) => tool.name === RESTART_JOB_TOOL).inputSchema.properties.quiet, undefined, "no quiet switch: it always is");
  await withBackground(restarted, async () => ({ content: [] }))(RESTART_JOB_TOOL, { titles: ["Y Combinator application"] });
  assert.equal(restarted.endsTurn(RESTART_JOB_TOOL), QUIET_ACK);
  assert.deepEqual(startedJobs(restarted, false), { steers: [{ id: YC.id, resume: true }] }, "it still picks the job up");

  const started = backgroundSession({ running: [], job: null, now: NOW });
  assert.equal(started.tools.find((tool) => tool.name === START_JOB_TOOL).inputSchema.properties.quiet, undefined);
  assert.match(words(await withBackground(started, async () => ({ content: [] }))(START_JOB_TOOL, { title: "Haircut", brief: "Book it." })), /Nothing is texted for it/);
  assert.equal(started.endsTurn(START_JOB_TOOL), QUIET_ACK);
  assert.equal(started.endsTurn(START_JOB_TOOL), null, "settled once");
  assert.equal(started.endsTurn("search"), null, "no job, no settling");
});

test("a computer job picked back up gets the computer as its settings are now, not the folder it first ran in", async () => {
  // 2026-11-05: a GitHub sign-in restarted after its folder was cleared kept the old folder, and the gateway refused it.
  const SIGN_IN = job("Log in to GitHub on dev2", "failed", { machine: true, on: "mch_1", onName: "dev2", onTool: "claude" });
  const machines = async () => [{ workspaceId: "ws_a", id: "mch_1", name: "dev2", online: true, tools: ["claude"], folders: [], ownerId: "user_a" }];
  const background = backgroundSession({ running: [SIGN_IN], job: null, now: NOW, machines });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.match(words(await dispatch(RESTART_JOB_TOOL, { titles: ["Log in to GitHub on dev2"] })), /Picking "Log in to GitHub on dev2" back up/);
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: SIGN_IN.id, resume: true, machine: { workspaceId: "ws_a", machineId: "mch_1", name: "dev2", tool: "claude", folder: "@work" } }] });
  // A computer no longer listed: picked up as it was, and the computer's refusal says why.
  const gone = backgroundSession({ running: [SIGN_IN], job: null, now: NOW, machines: async () => [] });
  await withBackground(gone, async () => ({ content: [] }))(RESTART_JOB_TOOL, {});
  assert.deepEqual(startedJobs(gone, false), { steers: [{ id: SIGN_IN.id, resume: true }] });
});
