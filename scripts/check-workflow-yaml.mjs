#!/usr/bin/env node
/**
 * Every workflow file is one GitHub will actually load: it parses as YAML, it
 * declares jobs, and every `if:` and every `${{ }}` in a job's or a step's
 * `env:` names only contexts that position is allowed to name.
 *
 * A workflow file GitHub refuses is not a failing check — the file is ignored
 * entirely, so it produces no run, no error, and no status at all. The pull
 * request then goes green having never executed the jobs somebody just wrote,
 * which is this repository's most-repeated failure shape (see
 * `3-resources/engineering/false-green-patterns.md`).
 *
 * It has already happened three times.
 *
 * 1. `hook.yml` shipped with an unquoted `node:` inside a step name, which YAML
 *    reads as a mapping value. That package's whole suite was silently absent
 *    from CI.
 *
 * 2. `deploy-router.yml` shipped `if: ${{ secrets.CONTROL_PLANE_URL != '' }}`
 *    (#275). `secrets` is available in NO `if:` — not a step's, not a job's —
 *    and GitHub rejects the whole file for it:
 *
 *      HTTP 422: failed to parse workflow: (Line: 136, Col: 13):
 *      Unrecognized named-value: 'secrets'.
 *
 *    The router deploy was therefore unrunnable — not dispatchable, not
 *    triggerable by push — for as long as that line existed, and nothing went
 *    red to say so.
 *
 * 3. `ai-benchmark.yml` shipped `BENCH_RUNNER_TOKEN_FILE: ${{ runner.temp
 *    }}/bench-runner.json` in a JOB-level `env:` (#1482, 2026-10-10). `runner`
 *    is available to a step and not to a job, so the refusal is the same one
 *    #275 got, for the same reason, in a position this guard did not read:
 *
 *      Unrecognized named-value: 'runner'.
 *
 *    The AI Benchmark workflow was therefore undispatchable from the moment it
 *    merged, and the merge went green: eight workflows passed, and the one that
 *    had just been edited produced a run with no jobs that nothing required.
 *
 * ## The second one is why this file's subject had to widen
 *
 * This guard was already running, in two workflows, and it passed on that
 * file — as did the shell checker, the trigger checker, the preflight checker
 * and the whole of CI. Its own header claimed it answered "would GitHub run
 * anything from this file", and it answered only the YAML half of that, while
 * GitHub rejects a workflow at two layers and produces the identical silence at
 * both. A guard that answers half its stated question, and states the whole
 * one, is worse than an honest narrow guard: it is the reason nobody added the
 * other half.
 *
 * The third one widened it again, the same way: this guard read `if:` and
 * nothing else, while GitHub resolves contexts in every expression in the file
 * and rejects the whole document over any of them. `env:` is checked below
 * because it is where this repository actually writes them: twelve of its
 * thirty-eight files hand a job an expression that way, and this is how a
 * secret reaches a step at all. A WORKFLOW-level `env:` is deliberately NOT
 * checked: no file here has one with an expression in it, so
 * there is no corpus to confirm a closed set against, and a set guessed wrong
 * in the strict direction would refuse a file GitHub accepts. That is a narrow
 * guard stating its own edge, which is the opposite of the mistake above.
 *
 * `actionlint` catches this too and is what confirmed the exact message above.
 * It is not what runs here, because these guards deliberately take no
 * dependencies and must run on a bare runner. The rule enforced below is
 * closed and copied from GitHub's own context-availability table, so the two
 * agree on this class without this repository acquiring a binary.
 *
 * ## Why `check-workflow-secrets-in-if.mjs` is gone
 *
 * #300 fixed the router and added that file: one regex,
 * `/^\s*-?\s*if\s*:.*\bsecrets(?:\.|\[)/`, run over each LINE. It was right
 * about the bug and is strictly subsumed by the rule here, which parses the
 * document and checks every `if:` against the full table. Two guards for one
 * class are two things to drift — `mcp.yml` makes that argument about this
 * very file — so it is removed rather than left alongside, and both of its
 * distinctive cases (bracket access; `secrets` in `env:`/`with:` staying
 * legal) are in the self-test below so nothing it proved is lost.
 *
 * Two shapes it passed, both confirmed real rejections by actionlint, both
 * producing the same zero-jobs silence:
 *
 *   - a FOLDED `if:`, where the expression sits on the next line and the
 *     `if:` line contains no `secrets` at all;
 *   - any other unavailable context — `env.X` in a JOB-level `if:` is the
 *     obvious next move for someone told "read it through `env:` instead",
 *     and `env` is available to a step's `if:` but not a job's.
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
 * drift apart. So: a script, run from `fast-guards.yml` AND
 * `email-worker.yml`. Losing
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
 * Every context GitHub knows, and the subset each `if:` position may name.
 *
 * Copied from GitHub's context-availability table — the same list actionlint
 * prints when it refuses `secrets` in a step `if:`. Both sets are CLOSED: a
 * head identifier that is in neither is refused too, because GitHub refuses it
 * ("Unrecognized named-value: 'foo'") with exactly the same silence.
 *
 * `secrets` is in no set, which is the whole point. Nor is it available in a
 * job-level `if:`, so "move it up a level" is not the fix — the fix is to test
 * the value in the shell, where a missing secret can be a skip rather than a
 * failure. See the step in `.github/workflows/deploy-router.yml`.
 *
 * https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
 */
const IF_CONTEXTS = {
  job: ["github", "needs", "vars", "inputs"],
  step: [
    "github",
    "needs",
    "strategy",
    "matrix",
    "job",
    "runner",
    "env",
    "vars",
    "steps",
    "inputs",
  ],
};

/**
 * The same table for an `env:` value, where the sets are WIDER, not narrower.
 *
 * `secrets` is legal in an `env:` — it is how every deploy in this repository
 * reads one, and it is the fix the `if:` rule above points at. So these sets
 * cannot be shared with `IF_CONTEXTS`, and a reader who assumes one table for
 * both positions is the person who deletes the distinction.
 *
 * A step's `env:` may name `runner`, `job`, `steps` and `env` as well, because
 * by then the runner exists and the earlier steps have run. A job's may not:
 * its values are resolved before a machine is picked.
 *
 * https://docs.github.com/en/actions/reference/workflows-and-actions/contexts
 */
const ENV_CONTEXTS = {
  job: ["github", "needs", "strategy", "matrix", "vars", "secrets", "inputs"],
  step: [
    "github",
    "needs",
    "strategy",
    "matrix",
    "job",
    "runner",
    "env",
    "vars",
    "secrets",
    "steps",
    "inputs",
  ],
};

/**
 * The `${{ }}` bodies in a value, and nothing else.
 *
 * An `if:` is an expression whole, so the rule above reads it directly. An
 * `env:` value is TEXT that may hold expressions, and reading it whole would
 * refuse `BENCH_RUNNER_ENDPOINT: https://mcp.context.lc/@context-lc/mcp` for
 * naming a context called `mcp`. Only what is inside the braces is resolved by
 * GitHub, so only that is checked here.
 */
function expressionsIn(value) {
  return [...String(value).matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]);
}

/**
 * The context names an expression reads, as GitHub resolves them: the HEAD of
 * each dotted or indexed access, and nothing else.
 *
 * Single-quoted string literals are removed first, so `'refs/heads/v1.2'`
 * cannot look like a context named `v1`. `always()`, `hashFiles(…)` and every
 * other call is a function, not a context, and is left alone because the head
 * has to be followed by `.` or `[` to count. Only the head matters:
 * `steps.probe.outputs.found` reads `steps`, and `probe` is data inside it.
 */
function contextsIn(expression) {
  const withoutStrings = String(expression).replace(/'(?:[^']|'')*'/g, "''");
  const heads = new Set();
  for (const match of withoutStrings.matchAll(
    /(?<![A-Za-z0-9_.\-])([A-Za-z_][A-Za-z0-9_-]*)(?=\s*[.[])/g
  )) {
    heads.add(match[1]);
  }
  return [...heads];
}

/**
 * What Python answers about one document: `null` when it is fine, else why not.
 *
 * A parse failure, a document with no `jobs`, and an `if:` GitHub will not
 * accept are one function because they are one question — "would GitHub run
 * anything from this file" — and because a checker that answers part of it
 * looks like it works. It looked like it worked for the whole life of #275.
 */
function problemWith(text) {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "import sys, json, yaml",
        "raw = sys.stdin.read()",
        "try:",
        "    document = yaml.safe_load(raw)",
        "except Exception as error:",
        "    print(json.dumps({'error': str(error).replace(chr(10), ' ')})); sys.exit(0)",
        "if not isinstance(document, dict) or 'jobs' not in document:",
        "    print(json.dumps({'error': 'parsed, but declares no jobs'})); sys.exit(0)",
        "conditionals = []",
        "envs = []",
        "def collect_env(scope, where, holder):",
        "    block = holder.get('env')",
        "    for key, value in (block.items() if isinstance(block, dict) else []):",
        "        if isinstance(value, (str, int, float, bool)):",
        "            envs.append([scope, where, str(key), str(value)])",
        "jobs = document.get('jobs')",
        "for job_id, job in (jobs.items() if isinstance(jobs, dict) else []):",
        "    if not isinstance(job, dict):",
        "        continue",
        "    if 'if' in job:",
        "        conditionals.append(['job', str(job_id), str(job['if'])])",
        "    collect_env('job', str(job_id), job)",
        "    steps = job.get('steps')",
        "    for index, step in enumerate(steps if isinstance(steps, list) else []):",
        "        if not isinstance(step, dict):",
        "            continue",
        "        where = str(job_id) + '.' + str(step.get('name') or step.get('uses') or ('step ' + str(index + 1)))",
        "        if 'if' in step:",
        "            conditionals.append(['step', where, str(step['if'])])",
        "        collect_env('step', where, step)",
        "print(json.dumps({'error': None, 'ifs': conditionals, 'envs': envs}))",
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

  let answer;
  try {
    answer = JSON.parse(probe.stdout);
  } catch {
    return `the YAML probe printed something unreadable: ${probe.stdout.trim().slice(0, 200)}`;
  }
  if (answer.error) return answer.error;

  for (const [scope, where, expression] of answer.ifs ?? []) {
    const allowed = IF_CONTEXTS[scope];
    const refused = contextsIn(expression).filter((name) => !allowed.includes(name));
    if (refused.length > 0) {
      return (
        `${where}: \`if: ${expression}\` names ${refused.map((n) => `'${n}'`).join(", ")}, ` +
        `which a ${scope}-level \`if:\` may not use. GitHub rejects the WHOLE FILE ` +
        `("Unrecognized named-value"), so it produces no run at all. Available here: ` +
        `${allowed.join(", ")}. For a secret, test its value inside the \`run:\` shell instead.`
      );
    }
  }

  for (const [scope, where, key, value] of answer.envs ?? []) {
    const allowed = ENV_CONTEXTS[scope];
    for (const expression of expressionsIn(value)) {
      const refused = contextsIn(expression).filter((name) => !allowed.includes(name));
      if (refused.length === 0) continue;
      return (
        `${where}: \`env: ${key}\` names ${refused.map((n) => `'${n}'`).join(", ")}, ` +
        `which a ${scope}-level \`env:\` may not use. GitHub rejects the WHOLE FILE ` +
        `("Unrecognized named-value"), so it produces no run at all. Available here: ` +
        `${allowed.join(", ")}.` +
        (scope === "job" && refused.includes("runner")
          ? " The runner's own variables (`$RUNNER_TEMP`) are there in the `run:` shell, or move the `env:` onto the step."
          : "")
      );
    }
  }
  return null;
}

/** The checker, checked. Samples it must flag, and samples it must not. */
function selfTest() {
  const good = "name: ok\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n";
  const unparseable = "name: ok\njobs:\n  test:\n    steps:\n      - name: run node: the thing\n";
  const noJobs = "name: ok\non:\n  pull_request:\n";
  const aList = "- one\n- two\n";

  /** The exact shape #275 shipped, restored, so a run proves the guard sees it. */
  const wf = (body) => `name: ok\non:\n  push:\n    branches: [main]\njobs:\n${body}`;
  const secretsInStepIf = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - name: Set CONVEX_ORIGIN secret\n" +
      "        if: ${{ secrets.CONTROL_PLANE_URL != '' }}\n" +
      "        run: echo hi\n"
  );
  const secretsInJobIf = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    if: ${{ secrets.CONTROL_PLANE_URL != '' }}\n" +
      "    steps:\n      - run: echo hi\n"
  );
  const envInStepIf = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - if: ${{ env.THING != '' }}\n        run: echo hi\n"
  );
  const envInJobIf = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    if: ${{ env.THING != '' }}\n" +
      "    steps:\n      - run: echo hi\n"
  );
  const stepsAndFunctions = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - if: always() && steps.probe.outputs.found == 'true'\n        run: echo hi\n"
  );
  const dottedStringLiteral = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - if: ${{ github.event.head_commit.message != 'v1.2 shipped' }}\n        run: echo hi\n"
  );
  const unknownName = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - if: ${{ secret.THING != '' }}\n        run: echo hi\n"
  );

  // ── The three cases below are why this rule parses instead of grepping ────
  //
  // `check-workflow-secrets-in-if.mjs` (#300) tested one LINE against
  // /^\s*-?\s*if\s*:.*\bsecrets(?:\.|\[)/. That is a strictly narrower rule,
  // and these are the shapes it let through — both confirmed real rejections
  // by actionlint, both producing the same zero-jobs silence as #275.
  //
  // A folded scalar puts the expression on the NEXT line, so the `if:` line
  // carries no `secrets` at all. PyYAML resolves it to the same string, so
  // reading the parsed VALUE sees it and a line regex cannot.
  const foldedScalarIf = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - name: s\n        if: >-\n" +
      "          ${{ secrets.CONTROL_PLANE_URL != '' }}\n        run: echo hi\n"
  );
  // Ported from #300's self-test, so retiring that file loses no coverage:
  // bracket access must not be a loophole, and `secrets` in `env:`/`with:` —
  // which IS valid, and is what the fix relies on — must never be flagged.
  const bracketAccess = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - if: ${{ secrets['CONTROL_PLANE_URL'] != '' }}\n        run: echo hi\n"
  );
  const secretsInEnvAndWith = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - if: ${{ github.event_name == 'push' }}\n" +
      "        env:\n          FOO: ${{ secrets.FOO }}\n" +
      "        run: echo hi\n" +
      "      - uses: some/action@v1\n        with:\n          bar: ${{ secrets.BAR }}\n"
  );

  // ── `env:` is the other position GitHub rejects the file over ────────────
  //
  // Third instance of this exact shape, 2026-10-10: ai-benchmark.yml shipped
  // `BENCH_RUNNER_TOKEN_FILE: ${{ runner.temp }}/bench-runner.json` in a
  // JOB-level `env:`. `runner` is available to a step and not to a job, so
  // GitHub refused the whole file and the benchmark became undispatchable —
  // the same zero-jobs silence as #275, and this guard passed because it read
  // only `if:`. `secrets` must stay legal here, which is why the sets differ
  // from the `if:` ones rather than being shared.
  const runnerInJobEnv = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n" +
      "    env:\n      TOKEN_FILE: ${{ runner.temp }}/x.json\n" +
      "    steps:\n      - run: echo hi\n"
  );
  const runnerInStepEnv = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n    steps:\n" +
      "      - env:\n          TOKEN_FILE: ${{ runner.temp }}/x.json\n        run: echo hi\n"
  );
  const envInJobEnv = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n" +
      "    env:\n      COPY: ${{ env.THING }}\n" +
      "    steps:\n      - run: echo hi\n"
  );
  const secretsInJobEnv = wf(
    "  deploy:\n    runs-on: ubuntu-latest\n" +
      "    env:\n      TOKEN: ${{ secrets.TOKEN }}\n      JOB: ${{ inputs.job || 'x' }}\n" +
      "    steps:\n      - run: echo hi\n"
  );

  const cases = [
    ["a well-formed workflow passes", problemWith(good) === null],
    ["an unquoted colon in a step name is caught", problemWith(unparseable) !== null],
    ["a document with no jobs is caught", problemWith(noJobs) !== null],
    ["a YAML list is not a workflow", problemWith(aList) !== null],
    ["`secrets` in a step `if:` is caught (the #275 line)", problemWith(secretsInStepIf) !== null],
    ["`secrets` in a job `if:` is caught too", problemWith(secretsInJobIf) !== null],
    ["`env` in a step `if:` is allowed", problemWith(envInStepIf) === null],
    ["`env` in a job `if:` is caught", problemWith(envInJobIf) !== null],
    ["`steps.…` and `always()` are allowed", problemWith(stepsAndFunctions) === null],
    ["a dot inside a string literal is not a context", problemWith(dottedStringLiteral) === null],
    ["a name GitHub does not know is caught", problemWith(unknownName) !== null],
    ["`secrets` in a FOLDED `if:` is caught (a line regex misses it)", problemWith(foldedScalarIf) !== null],
    ["bracket access `secrets['X']` is caught", problemWith(bracketAccess) !== null],
    ["`secrets` in `env:` and `with:` is never flagged", problemWith(secretsInEnvAndWith) === null],
    ["`runner` in a job `env:` is caught (the 2026-10-10 line)", problemWith(runnerInJobEnv) !== null],
    ["`runner` in a step `env:` is allowed", problemWith(runnerInStepEnv) === null],
    ["`env` in a job `env:` is caught", problemWith(envInJobEnv) !== null],
    ["`secrets` and `inputs` in a job `env:` are allowed", problemWith(secretsInJobEnv) === null],
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
  console.error("A workflow GitHub refuses is ignored — no run, no failing check, and a");
  console.error("pull request that goes green without it. It refuses a file that does not");
  console.error("parse AND a file whose `if:` or `env:` names a context that position");
  console.error("cannot use;");
  console.error("both are silent, so both are checked here.");
  process.exit(1);
}
console.log(
  `OK — ${files.length} workflow files parse, declare jobs, and use only contexts their ` +
    "`if:` and their jobs' and steps' `env:` allow."
);
