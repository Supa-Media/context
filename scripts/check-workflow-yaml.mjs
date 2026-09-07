#!/usr/bin/env node
/**
 * Every workflow file parses as YAML and declares jobs.
 *
 * A workflow file that does not parse is not a failing check — GitHub ignores
 * the file entirely, so it produces no run, no error, and no status at all.
 * The pull request then goes green having never executed the jobs somebody
 * just wrote, which is this repository's most-repeated failure shape (see
 * `3-resources/engineering/false-green-patterns.md`).
 *
 * It has already happened once: `hook.yml` shipped with an unquoted `node:`
 * inside a step name, which YAML reads as a mapping value. That package's whole
 * suite was silently absent from CI.
 *
 * ## Why this is a script and not an inline `run:` block
 *
 * It was one, inside `mcp.yml`, under a comment claiming it "deliberately
 * lives in a DIFFERENT workflow from the ones it checks, because a checker
 * inside the broken file cannot run either" — which was true of every workflow
 * except the one it was written in. A YAML break in `mcp.yml` took the only
 * copy of the checker down with the gateway suite, the meetings suite and
 * three guard jobs, silently, which is precisely the argument the comment was
 * making.
 *
 * Two hosts is the fix the trigger checker already uses, and two hosts want one
 * implementation rather than two copies of thirty lines of Python that can
 * drift apart. So: a script, run from `mcp.yml` AND `email-worker.yml`. Losing
 * either file still leaves a copy that runs; losing both is a diff nobody could
 * miss.
 *
 * ## Why Python
 *
 * Node has no YAML parser in its standard library and the guards in this repo
 * take no dependencies. `python3` with PyYAML is present on the runners and is
 * what the inline version used, so this spawns it — the same shape as
 * `check-workflow-shell.mjs` spawning `bash -n`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Resolved from this file, not from the working directory.
 *
 * It was `".github/workflows"`, which works because CI runs it from the repo
 * root — and crashes with `ENOENT` from anywhere else, before the floor check
 * below can say anything useful. A guard whose failure mode is a stack trace
 * about `scandir` is a guard that gets read as "the tool is broken" rather
 * than "the tree is wrong", and the two want different responses.
 */
const WORKFLOWS = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/**
 * What Python answers about one document: `null` when it is fine, else why not.
 *
 * A parse failure and a document with no `jobs` are one function because they
 * are one question — "would GitHub run anything from this file" — and because
 * a checker that answers half of it looks like it works.
 */
function problemWith(text) {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import sys, yaml",
        "raw = sys.stdin.read()",
        "try:",
        "    document = yaml.safe_load(raw)",
        "except Exception as error:",
        "    print(str(error).replace(chr(10), ' ')); sys.exit(0)",
        "if not isinstance(document, dict) or 'jobs' not in document:",
        "    print('parsed, but declares no jobs'); sys.exit(0)",
        "print('')",
      ].join("\n"),
    ],
    { input: text, encoding: "utf8" }
  );
  if (probe.error || probe.status !== 0) {
    // The parser itself failing is not "the file is fine". Without this the
    // whole guard reports OK on a runner with no python3 — green because it
    // never executed, the shape this file exists to stop.
    return `could not run the YAML parser: ${probe.error?.message ?? probe.stderr?.trim() ?? `exit ${probe.status}`}`;
  }
  const answer = probe.stdout.trim();
  return answer === "" ? null : answer;
}

/** The checker, checked. A sample it must flag, and one it must not. */
function selfTest() {
  const good = "name: ok\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n";
  const unparseable = "name: ok\njobs:\n  test:\n    steps:\n      - name: run node: the thing\n";
  const noJobs = "name: ok\non:\n  pull_request:\n";
  const aList = "- one\n- two\n";

  const cases = [
    ["a well-formed workflow passes", problemWith(good) === null],
    ["an unquoted colon in a step name is caught", problemWith(unparseable) !== null],
    ["a document with no jobs is caught", problemWith(noJobs) !== null],
    ["a YAML list is not a workflow", problemWith(aList) !== null],
  ];

  let failed = false;
  for (const [name, ok] of cases) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) failed = true;
  }
  if (failed) {
    console.error("\nThe checker does not agree with its own samples — fix it before trusting a run.");
    process.exit(1);
  }
  console.log(`ok   self-test passed (${cases.length} cases)`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const files = readdirSync(WORKFLOWS)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

// A floor, because every other way this can be wrong ends in "scanned nothing,
// printed ok, exited 0" — a renamed directory, a filter that stops matching, a
// checkout that did not happen.
if (files.length < 5) {
  console.error(`Only ${files.length} workflow files found in ${WORKFLOWS} — wrong root, or nothing checked out.`);
  process.exit(1);
}

const problems = [];
for (const file of files) {
  const problem = problemWith(readFileSync(join(WORKFLOWS, file), "utf8"));
  if (problem === null) {
    console.log(`ok   ${file}`);
  } else {
    console.log(`FAIL ${file}: ${problem}`);
    problems.push(file);
  }
}

if (problems.length > 0) {
  console.error("");
  console.error("A workflow that does not parse is ignored by GitHub — no run, no");
  console.error("failing check, and a pull request that goes green without it.");
  process.exit(1);
}
console.log(`OK — ${files.length} workflow files parse and declare jobs.`);
