// A job paused at the daily limit starts again by itself once the limit resets (apps/agent/src/jobPause.ts), so a turn
// must be able to stop it ("never mind the trip plan") or it would restart anyway; a change can't reach it until then.
import assert from "node:assert/strict";
import { test } from "node:test";

import { STEER_JOB_TOOL, backgroundSession, runningJobsOf, startedJobs, withBackground } from "../src/agent/background.js";

const NOW = Date.UTC(2026, 10, 5, 3, 0);
const RESET = Date.UTC(2026, 10, 6, 0, 2);
const words = (result) => result.content.map((part) => part.text).join("");
const paused = { id: "job-trip-paused-1", title: "Morocco trip plan", state: "waiting", startedAt: NOW - 60_000, finishedAt: NOW, status: "Paused", resumeAt: RESET };

test("a paused job is read as paused only while it waits with a restart time", () => {
  const [read, other, gone] = runningJobsOf([paused, { ...paused, id: "job-other-wait-1", resumeAt: undefined }, { ...paused, id: "job-done-trip-1", state: "done" }]);
  assert.equal(read.paused, true);
  assert.equal(other.paused, false);
  assert.equal(gone.paused, false);
});

test("a paused job can be stopped, and only stopped", async () => {
  const background = backgroundSession({ running: runningJobsOf([paused]), job: null, now: NOW });
  assert.ok(background.tools.some((tool) => tool.name === STEER_JOB_TOOL), "with only a paused job, a turn can still stop it");
  const dispatch = withBackground(background, async () => ({ content: [{ type: "text", text: "other" }] }));

  const change = await dispatch(STEER_JOB_TOOL, { title: "Morocco trip plan" });
  assert.equal(change.isError, true);
  assert.match(words(change), /paused at today's limit[^]*starts again by itself/);
  assert.deepEqual(startedJobs(background, false), {}, "a change reaches nothing");

  const stopped = await dispatch(STEER_JOB_TOOL, { title: "morocco trip plan", stop: true });
  assert.match(words(stopped), /Stopped "Morocco trip plan": it won't start again by itself/);
  assert.deepEqual(startedJobs(background, false), { steers: [{ id: paused.id, stop: true }] });
});
