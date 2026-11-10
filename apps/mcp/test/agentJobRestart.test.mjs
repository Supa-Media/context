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
 *  2. `call` starting a new copy of a job that stopped.
 *     → "a new job named like one that stopped picks that one up instead" fails.
 *  3. `startedJobs` leaving out the resumed jobs.
 *     → "restart with no titles picks up every job that stopped, in one call, and the turn ends at once" fails.
 *  4. `resume` past the running limit.
 *     → "no more than three run at once, counting the ones picked up" fails.
 *  5. `endsTurn` ignoring `quiet`.
 *     → "asked to hear nothing until it's done: a start or restart texts nothing" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_RUNNING_JOBS, QUIET_ACK, RESTART_JOB_TOOL, START_JOB_TOOL, backgroundSession, resumedLine, startedJobs, withBackground } from "../src/agent/background.js";

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
  assert.equal(
    background.endsTurn(RESTART_JOB_TOOL),
    'On it: picking "a16z Speedrun application", "Y Combinator application" and "Total toll charges paid" back up.',
  );
  assert.equal(background.endsTurn(RESTART_JOB_TOOL), null, "said once");
  assert.deepEqual(startedJobs(background, false), { steers: [A16Z, YC, TOLL].map((entry) => ({ id: entry.id, resume: true })) }, "a finished job is not picked up; no new job starts");
});

test("named titles pick up only those, and a running or finished one is refused", async () => {
  const background = backgroundSession({ running: [A16Z, YC, job("Logo", "running"), DONE], job: null, now: NOW });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.equal((await dispatch(RESTART_JOB_TOOL, { titles: ["Trip plan", "Logo"] })).isError, true);
  await dispatch(RESTART_JOB_TOOL, { titles: ["y combinator application"] });
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: YC.id, resume: true }] });
  // One short line, no live link or card (Dev2, 2026-11-10: "Tex spams").
  assert.equal(resumedLine(["Y Combinator application"]), 'On it: picking "Y Combinator application" back up.');
});

test("a new job named like one that stopped picks that one up instead", async () => {
  const background = backgroundSession({ running: [YC], job: null, now: NOW });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.match(words(await dispatch(START_JOB_TOOL, { title: "Y Combinator application, restarted", brief: "Restart the YC application." })), /back up where it stopped/);
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: YC.id, resume: true }] }, "never a second copy from the restart text");
  assert.match(background.endsTurn(START_JOB_TOOL), /^On it: picking "Y Combinator application" back up/);
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

test("asked to hear nothing until it's done: a start or restart texts nothing", async () => {
  // Dev, 2026-11-03: "don't come back to me until you are done" was answered with "On it" three times.
  const restarted = backgroundSession({ running: [YC], job: null, now: NOW });
  assert.ok(restarted.tools.find((tool) => tool.name === RESTART_JOB_TOOL).inputSchema.properties.quiet);
  await withBackground(restarted, async () => ({ content: [] }))(RESTART_JOB_TOOL, { titles: ["Y Combinator application"], quiet: true });
  assert.equal(restarted.endsTurn(RESTART_JOB_TOOL), QUIET_ACK);
  assert.deepEqual(startedJobs(restarted, false), { steers: [{ id: YC.id, resume: true }] }, "it still picks the job up");

  const started = backgroundSession({ running: [], job: null, now: NOW });
  assert.ok(started.tools.find((tool) => tool.name === START_JOB_TOOL).inputSchema.properties.quiet);
  await withBackground(started, async () => ({ content: [] }))(START_JOB_TOOL, { title: "Haircut", brief: "Book it.", quiet: true });
  assert.equal(started.endsTurn(START_JOB_TOOL), QUIET_ACK);
  assert.equal(started.endsTurn(START_JOB_TOOL), null, "said once");

  const loud = backgroundSession({ running: [], job: null, now: NOW });
  await withBackground(loud, async () => ({ content: [] }))(START_JOB_TOOL, { title: "Haircut", brief: "Book it." });
  assert.match(loud.endsTurn(START_JOB_TOOL), /^On it: Haircut\./);
});

test("a computer job picked back up gets the computer as its settings are now, not the folder it first ran in", async () => {
  // 2026-11-05: a GitHub sign-in restarted after its folder was cleared kept the old folder, and the gateway refused it.
  const SIGN_IN = job("Log in to GitHub on dev2", "failed", { machine: true, on: "mch_1", onName: "dev2", onTool: "claude" });
  const machines = async () => [{ workspaceId: "ws_a", id: "mch_1", name: "dev2", online: true, tools: ["claude"], folders: [], ownerId: "user_a" }];
  const background = backgroundSession({ running: [SIGN_IN], job: null, now: NOW, machines });
  const dispatch = withBackground(background, async () => ({ content: [] }));
  assert.match(words(await dispatch(START_JOB_TOOL, { title: "Log in to GitHub on dev2", brief: "Sign in with gh.", on_computer: { name: "dev2" } })), /back up where it stopped/);
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: SIGN_IN.id, resume: true, machine: { workspaceId: "ws_a", machineId: "mch_1", name: "dev2", tool: "claude", folder: "@work" } }] });
  // A computer no longer listed: picked up as it was, and the computer's refusal says why.
  const gone = backgroundSession({ running: [SIGN_IN], job: null, now: NOW, machines: async () => [] });
  await withBackground(gone, async () => ({ content: [] }))(RESTART_JOB_TOOL, {});
  assert.deepEqual(startedJobs(gone, false), { steers: [{ id: SIGN_IN.id, resume: true }] });
});
