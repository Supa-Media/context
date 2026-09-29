import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildEvidence,
  parseCommitRecords,
  selectPreviousProductionRun,
  validateProductionRun,
} from "./release-communication-evidence.mjs";

const sha = (character) => character.repeat(40);
const run = (overrides = {}) => ({
  id: 42,
  name: "Deploy to Production",
  path: ".github/workflows/deploy-production.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: sha("b"),
  run_number: 12,
  html_url: "https://github.example/actions/runs/42",
  created_at: "2026-09-28T12:00:00Z",
  updated_at: "2026-09-28T12:10:00Z",
  ...overrides,
});

test("only a completed manual production promotion on main is evidence", () => {
  assert.doesNotThrow(() => validateProductionRun(run()));

  for (const [change, message] of [
    [{ name: "Deploy Staging" }, /production workflow/],
    [{ path: ".github/workflows/other.yml" }, /production workflow/],
    [{ event: "push" }, /manual production promotion/],
    [{ status: "in_progress" }, /completed successfully/],
    [{ conclusion: "failure" }, /completed successfully/],
    [{ head_branch: "feature" }, /main/],
    [{ head_sha: "not-a-sha" }, /commit/],
  ]) {
    assert.throws(() => validateProductionRun(run(change)), message);
  }
});

test("the baseline is the newest earlier successful production run", () => {
  const target = run();
  const previous = run({ id: 41, run_number: 11, head_sha: sha("a") });
  const runs = [
    run({ id: 44, run_number: 14, head_sha: sha("e") }),
    run({ id: 43, run_number: 13, conclusion: "failure", head_sha: sha("d") }),
    target,
    previous,
    run({ id: 40, run_number: 10, head_sha: sha("0") }),
  ];
  assert.equal(selectPreviousProductionRun(target, runs), previous);
  assert.throws(
    () => selectPreviousProductionRun(run({ run_number: 1 }), [run({ run_number: 1 })]),
    /earlier successful production run/,
  );
});

test("first-parent commit records retain direct commits and link pull requests", () => {
  const records = [
    `${sha("a")}\0${"2026-09-27T10:00:00Z"}\0Add the first thing (#123)\x1e`,
    `${sha("b")}\0${"2026-09-28T10:00:00Z"}\0Emergency direct fix\x1e`,
  ].join("");
  assert.deepEqual(parseCommitRecords(records), [
    {
      sha: sha("a"),
      committedAt: "2026-09-27T10:00:00Z",
      subject: "Add the first thing (#123)",
      pullRequest: 123,
    },
    {
      sha: sha("b"),
      committedAt: "2026-09-28T10:00:00Z",
      subject: "Emergency direct fix",
      pullRequest: null,
    },
  ]);
});

test("the artifact is evidence only and records the exact production interval", () => {
  const target = run();
  const previous = run({ id: 41, run_number: 11, head_sha: sha("a") });
  const commits = parseCommitRecords(
    `${sha("b")}\0${"2026-09-28T10:00:00Z"}\0A production change (#123)\x1e`,
  );
  const evidence = buildEvidence({
    repository: "example/context",
    target,
    previous,
    commits,
    jobs: [{ name: "gateway / deploy", conclusion: "success", html_url: "https://github.example/job/1" }],
    generatedAt: "2026-09-28T12:11:00Z",
  });

  assert.equal(evidence.kind, "production-release-evidence");
  assert.equal(evidence.publication.performed, false);
  assert.equal(evidence.interval.fromExclusive, sha("a"));
  assert.equal(evidence.interval.toInclusive, sha("b"));
  assert.deepEqual(evidence.commits, commits);
  assert.deepEqual(evidence.jobs, [
    { name: "gateway / deploy", conclusion: "success", url: "https://github.example/job/1" },
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /\"state\"|\"status\"|\"commitment\"/i);
});

test("the workflow can observe production but cannot publish or deploy", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release-communication-evidence.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_run:\s*\n\s+workflows: \["Deploy to Production"\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /contents:\s*write|wrangler|eas\s+deploy|gh\s+release|release\s+create/i);
});
