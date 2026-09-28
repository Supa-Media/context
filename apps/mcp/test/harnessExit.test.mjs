/**
 * A FAILED CHECK HAS TO REACH THE SHELL, NOT ONLY THE LOG.
 *
 * `check()` counts a failure and prints `FAIL  <label>`; the entry file prints
 * `N FAILURES` at the end. Nothing in that chain ever set an exit status, so
 * `node test/test.mjs` exited 0 with a red suite behind it — and `mcp.yml`'s
 * "Test Gateway" step, `deploy-mcp.yml`'s pre-deploy run and `pnpm test`'s
 * `&&` all read the status and nothing else. A tenant-isolation check could
 * fail on every pull request and every one of them would be green.
 *
 * The harness's own comment on `suite()` already measured the neighbouring
 * case and said "It is not the exit code — the process does exit 1": true of a
 * throw that escapes the file, and false of every failure that goes through
 * `check()` or through `suite()`'s catch, which is nearly all of them.
 *
 * So the status is set where the failure is counted rather than at the end of
 * one entry file: `check()` and `fail()` are what every suite in this package
 * reaches for, including the suites imported by other entry points, and a
 * later entry file cannot forget to ask.
 *
 * Each case runs in a child process, because an exit status is a property of a
 * process and cannot be observed from inside the run it belongs to. The child
 * imports this package's real harness — not a copy of its logic.
 *
 * SABOTAGE RECORD
 *
 *   drop `process.exitCode = 1` from `check`   -> 1 check here failed
 *   drop it from `fail`                        -> 1 check here failed
 *   set it unconditionally in `check`          -> 1 check here failed
 *                                                 (the passing control)
 */

import { execFileSync } from "node:child_process";

const HARNESS = new URL("./harness.mjs", import.meta.url).href;

/**
 * Run `source` in a child and answer with its exit status and what it printed.
 *
 * `stdio: "pipe"` keeps the child's own PASS/FAIL lines out of this run's
 * output, where they would read as results of the suite rather than of a
 * deliberate fixture. A non-zero status arrives as a thrown error from
 * `execFileSync`, so both paths are read off the same object.
 *
 * **The output is returned because the status alone proves too little.** A
 * child that cannot even import the harness — a syntax error, a renamed export,
 * a module that throws on load — also exits non-zero, so a check reading only
 * the status would pass while demonstrating nothing. Every case below therefore
 * asserts the line the harness itself printed as well.
 */
function ranWith(source) {
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, output };
  } catch (error) {
    return { status: error.status ?? -1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

export async function runHarnessExitChecks(check) {
  const failed = ranWith(`import { check } from ${JSON.stringify(HARNESS)};
check("a deliberate failure, from the exit-status guard's fixture", false);`);
  check(
    "a failed check makes the process exit non-zero",
    failed.status !== 0 && failed.output.includes("FAIL  a deliberate failure"),
  );

  const threw = ranWith(`import { suite } from ${JSON.stringify(HARNESS)};
await suite("a deliberate thrower, from the exit-status guard's fixture", () => {
  throw new Error("boom");
});`);
  check(
    "...and a suite that throws does too, though its throw was caught",
    threw.status !== 0 && threw.output.includes("FAIL  a deliberate thrower"),
  );

  const passed = ranWith(`import { check } from ${JSON.stringify(HARNESS)};
check("a deliberate pass, from the exit-status guard's fixture", true);`);
  check(
    "...while a run whose checks all pass still exits zero",
    passed.status === 0 && passed.output.includes("PASS  a deliberate pass"),
  );
}
