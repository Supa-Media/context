#!/usr/bin/env node
/**
 * What a required check needs to know when the merge queue runs it.
 *
 * The queue builds a trial commit for each pull request (a merge group) on a
 * branch named `gh-readonly-queue/<base>/pr-<number>-<sha>` and asks for the
 * required checks on it (`merge_group`, `checks_requested`). That event
 * carries no pull request: no number, no description, no head commit. The
 * number is in the branch name, and the rest is read from it.
 *
 * `--check-passed` is for a check that cannot run on a merge group. The Tex
 * replay check is one: its verdict is a "Tex test set" status that main's
 * workflow sets on the pull request's head commit, after a capped, sealed run
 * that a trial commit must not spend again. It passes on a merge group only
 * when the same check concluded `success` on that head commit, read live, so
 * a pull request cannot pass in the queue what it did not pass on its own.
 * Anything else (no pull request in the branch name, a closed pull request,
 * no run, a newer run that failed or is still going) fails, and a failed
 * required check takes the pull request out of the queue.
 *
 *   node scripts/merge-group.mjs --self-test
 *   MERGE_GROUP_REF= node scripts/merge-group.mjs --pr-number
 *   MERGE_GROUP_REF= GH_TOKEN= GITHUB_REPOSITORY= node scripts/merge-group.mjs --check-passed "<check name>"
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The pull request a merge group's branch was built for, or "" when the ref is not one. */
export function mergeGroupPr(ref) {
  const match = /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-([1-9][0-9]*)-[0-9a-f]{7,64}$/.exec(String(ref ?? "").trim());
  return match ? match[1] : "";
}

/**
 * Null when the named check's newest run on the head commit succeeded, else
 * why not. `runs` are that commit's check runs with this name. Only a run
 * made by GitHub Actions counts: any app with `checks: write` can post a run
 * under any name. Newest is by id, which GitHub assigns in order, so a
 * re-run that failed outranks the pass before it.
 */
export function checkVerdict(runs, name) {
  const mine = runs
    .filter((run) => run.name === name && run.app?.slug === "github-actions")
    .sort((a, b) => b.id - a.id);
  const latest = mine[0];
  if (!latest) return `"${name}" has no run on the pull request's head commit`;
  if (latest.status !== "completed") return `"${name}" is still ${latest.status} on the pull request's head commit`;
  if (latest.conclusion !== "success") return `"${name}" concluded ${latest.conclusion} on the pull request's head commit`;
  return null;
}

function selfTest() {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const run = (id, conclusion, extra = {}) => ({ id, name: "Gate", status: "completed", conclusion, app: { slug: "github-actions" }, ...extra });
  const cases = [
    ["a queue branch names its pull request", mergeGroupPr(`refs/heads/gh-readonly-queue/main/pr-3620-${sha}`) === "3620"],
    ["the short ref form too", mergeGroupPr(`gh-readonly-queue/main/pr-7-${sha}`) === "7"],
    ["a base branch with a slash", mergeGroupPr(`refs/heads/gh-readonly-queue/release/2.0/pr-12-${sha}`) === "12"],
    ["an ordinary branch names none", mergeGroupPr("refs/heads/main") === ""],
    ["a pull request's merge ref names none", mergeGroupPr("refs/pull/3620/merge") === ""],
    ["a branch that only looks like one names none", mergeGroupPr(`refs/heads/feature/pr-3620-${sha}`) === ""],
    ["trailing text after the commit names none", mergeGroupPr(`refs/heads/gh-readonly-queue/main/pr-3620-${sha}/x`) === ""],
    ["a number that is not one names none", mergeGroupPr(`refs/heads/gh-readonly-queue/main/pr-0-${sha}`) === ""],
    ["an empty ref names none", mergeGroupPr("") === "" && mergeGroupPr(undefined) === ""],
    ["a passing run passes", checkVerdict([run(1, "success")], "Gate") === null],
    ["no run fails", checkVerdict([], "Gate") !== null],
    ["a failed run fails", checkVerdict([run(1, "failure")], "Gate") !== null],
    ["a skipped run is not a pass", checkVerdict([run(1, "skipped")], "Gate") !== null],
    ["a newer failure outranks an older pass", checkVerdict([run(1, "success"), run(2, "failure")], "Gate") !== null],
    ["a newer pass outranks an older failure", checkVerdict([run(2, "success"), run(1, "failure")], "Gate") === null],
    ["a run still going is not a pass", checkVerdict([run(1, "success"), run(2, null, { status: "in_progress" })], "Gate") !== null],
    ["another check's pass is not this one", checkVerdict([run(1, "success", { name: "Other" })], "Gate") !== null],
    ["another app's run under the name is not this one", checkVerdict([run(1, "success", { app: { slug: "someone-else" } })], "Gate") !== null],
  ];
  let failed = 0;
  for (const [name, good] of cases) {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function checkPassed(name) {
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = process.env.MERGE_GROUP_REF ?? "";
  const pr = mergeGroupPr(ref);
  if (!name || !repo) throw new Error("--check-passed needs a check name and GITHUB_REPOSITORY");
  if (!pr) throw new Error(`"${ref}" is not a merge group branch, so there is no pull request to read`);
  const pull = JSON.parse(gh(["api", `repos/${repo}/pulls/${pr}`]));
  if (pull.state !== "open") throw new Error(`pull request #${pr} is ${pull.state}`);
  const head = pull.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(head ?? "")) throw new Error(`pull request #${pr} has no head commit`);
  const pages = JSON.parse(
    gh(["api", "--paginate", "--slurp", "-X", "GET", `repos/${repo}/commits/${head}/check-runs`, "-f", `check_name=${name}`, "-f", "filter=all", "-f", "per_page=100"]),
  );
  const runs = pages.flatMap((page) => page.check_runs ?? []);
  const problem = checkVerdict(runs, name);
  if (problem) throw new Error(`${problem} (#${pr}, ${head.slice(0, 8)})`);
  console.log(`merge-group: "${name}" passed on #${pr}'s head commit ${head.slice(0, 8)}; this merge group does not run it again.`);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  const at = process.argv.indexOf("--check-passed");
  if (process.argv.includes("--self-test")) selfTest();
  else if (process.argv.includes("--pr-number")) process.stdout.write(mergeGroupPr(process.env.MERGE_GROUP_REF));
  else if (at !== -1) {
    try {
      checkPassed(process.argv[at + 1]);
    } catch (error) {
      console.error(`::error::merge-group: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else {
    console.error("merge-group: pass --self-test, --pr-number or --check-passed <check name>");
    process.exit(1);
  }
}
