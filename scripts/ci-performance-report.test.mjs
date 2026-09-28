import test from "node:test";
import assert from "node:assert/strict";

import { deployTimings, percentile, pullRequestTimings, regression, slowest, summarize } from "./ci-performance-report.mjs";

const at = (minutes) => new Date(Date.UTC(2026, 8, 28, 0, minutes)).toISOString();

test("percentiles use the nearest rank", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([5, 1], 0), 1);
});

test("a deploy's wait for the lock is separated from its running time", () => {
  // run_started_at equals created_at even while the lock holds the run.
  const run = { id: 1, status: "completed", conclusion: "success", created_at: at(0), run_started_at: at(0), updated_at: at(11) };
  const [t] = deployTimings([run], new Map([[1, at(3)]]));
  assert.equal(t.wait, 3 * 60_000);
  assert.equal(t.running, 8 * 60_000);
  assert.equal(t.total, 11 * 60_000);
  const [unknown] = deployTimings([run]);
  assert.equal(unknown.wait, undefined, "no jobs fetched means no claim about the wait");
  assert.equal(summarize([unknown]).waitMedian, null);
  assert.deepEqual(deployTimings([{ id: 2, status: "in_progress", created_at: at(0), run_started_at: at(0), updated_at: at(1) }]), []);
});

test("a pull request's time spans all its workflows for one commit", () => {
  const runs = [
    { event: "pull_request", head_sha: "a", status: "completed", conclusion: "success", created_at: at(0), updated_at: at(2) },
    { event: "pull_request", head_sha: "a", status: "completed", conclusion: "skipped", created_at: at(1), updated_at: at(5) },
    { event: "pull_request", head_sha: "b", status: "completed", conclusion: "failure", created_at: at(0), updated_at: at(1), run_attempt: 2 },
    { event: "pull_request", head_sha: "c", status: "in_progress", created_at: at(0), updated_at: at(1) },
    { event: "push", head_sha: "a", status: "completed", conclusion: "success", created_at: at(0), updated_at: at(30) },
  ];
  const timings = pullRequestTimings(runs);
  assert.deepEqual(timings.map((t) => [t.sha, t.total / 60_000, t.conclusion, t.rerun]), [["a", 5, "success", false], ["b", 1, "failure", true]]);
  const s = summarize(timings);
  assert.equal(s.runs, 2);
  assert.equal(s.failures, 1);
  assert.equal(s.reruns, 1);
  assert.equal(s.median, 5 * 60_000, "only successful commits count toward speed");
});

test("a regression needs a sustained slowdown, not one slow run", () => {
  const now = Date.UTC(2026, 8, 28);
  const run = (daysAgo, minutes) => ({ at: new Date(now - daysAgo * 86_400_000).toISOString(), conclusion: "success", total: minutes * 60_000 });
  const lastWeek = [8, 9, 10, 11, 12].map((d) => run(d, 10));
  assert.equal(regression([...lastWeek, run(1, 60)], now), null, "one slow run is not enough data");
  assert.equal(regression([...lastWeek, ...[1, 2, 3, 4, 5].map((d) => run(d, 11))], now).regressed, false);
  assert.equal(regression([...lastWeek, ...[1, 2, 3, 4, 5].map((d) => run(d, 13))], now).regressed, true);
});

test("the slowest job and step are ranked by median", () => {
  const job = (name, minutes, steps = []) => ({ name, conclusion: "success", started_at: at(0), completed_at: at(minutes), steps });
  const step = (name, minutes) => ({ name, conclusion: "success", started_at: at(0), completed_at: at(minutes) });
  const result = slowest([
    [job("web", 8, [step("Verify alias", 5)]), job("convex", 2)],
    [job("web", 6, [step("Verify alias", 4)]), job("convex", 1), { name: "broken", conclusion: "failure" }],
  ]);
  assert.equal(result.jobs[0].name, "web");
  assert.equal(result.steps[0].name, "web → Verify alias");
});
