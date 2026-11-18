#!/usr/bin/env node
/**
 * No secret travels between jobs as a job output, or through a step's env: block.
 *
 * GitHub prints every step's `env:` block in the public log, so a value set there is readable by anyone who can
 * open the run. A job output used in env: is printed the same way, and GitHub refuses to store a masked value as a
 * job output, so a secret cannot safely cross a job boundary this way at all. `tex-lab-run.yml` did exactly that
 * with its seal key: an output of prep, then three steps' `env:`. Each step now derives the key itself.
 *
 * The rule, over every workflow file:
 *
 *  (a) an expression, in any position (env, with, run, if), that reads `needs.<job>.outputs.<name>` where `<name>`
 *      matches the credential pattern below;
 *  (b) a job's `outputs:` block that declares an output whose name matches the same pattern.
 *
 * The pattern is a name, so this is a tripwire for the shape. A name that merely contains "key" is refused too, and
 * a reviewer decides whether that was a false alarm. It does not follow `steps.<id>.outputs.*` values, and it never
 * prints a resolved value: only the expression as it is written, with its file and line.
 *
 * Run: `node scripts/check-workflow-output-secrets.mjs`
 * Self-test (proves the checks above catch what they claim, and refuse an unknown flag): `--self-test`
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
  Resolved from this file rather than the working directory, like its siblings: a run from anywhere else would
  otherwise be an ENOENT that reads as "the tool is broken" rather than "the tree is wrong".
*/
const DIR = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/** Output names that may hold a credential. Case-insensitive: `API_TOKEN` is as much a token as `api_token`. */
export const CREDENTIAL_NAME = /key|seal|token|secret|password|credential/i;

/** `${{ … }}` spans, which may run across lines. */
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/** A read of a job output: `needs.<job>.outputs.<name>` or `needs.<job>.outputs['<name>']`. */
const NEEDS_OUTPUT = /\bneeds\.[A-Za-z0-9_-]+\.outputs(?:\.([A-Za-z0-9_-]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;

/** A bare `if:` condition, which GitHub evaluates without `${{ }}`. */
const IF_LINE = /^\s*(?:-\s*)?if:\s*(\S.*)$/;

/** The 1-indexed line a character offset falls on. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Every span this file reads as an expression: `${{ … }}` anywhere, and the value of an `if:` line.
 * @returns {{line: number, text: string}[]}
 */
export function expressionSpans(text) {
  const spans = [];
  for (const match of text.matchAll(EXPRESSION)) {
    spans.push({ line: lineOf(text, match.index), text: match[0] });
  }
  text.split("\n").forEach((line, i) => {
    const condition = line.match(IF_LINE);
    if (condition && !condition[1].includes("${{")) spans.push({ line: i + 1, text: condition[1] });
  });
  return spans;
}

/**
 * Every `outputs:` declaration in a workflow: the output names a job or `workflow_call` declares.
 * A minimal reach-in, like `check-workflow-interpolation.mjs`'s `inputTypes`: find an `outputs:` mapping with no
 * value on its line, then read the keys one level beneath it.
 * @returns {{line: number, name: string, text: string}[]}
 */
export function declaredOutputs(text) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\s*)outputs:\s*(#.*)?$/);
    if (!head) continue;
    const base = head[1].length;
    let childIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const indent = line.search(/\S/);
      if (indent <= base) break;
      if (childIndent < 0) childIndent = indent;
      if (indent !== childIndent) continue;
      const key = line.match(/^\s*([A-Za-z0-9_.-]+):/);
      if (key) found.push({ line: j + 1, name: key[1], text: line.trim() });
    }
  }
  return found;
}

/**
 * @param {{name: string, text: string}[]} files
 * @returns {string[]} one entry per offending expression or declaration: `file:line: text — reason`
 */
export function outputSecretProblems(files) {
  const problems = [];
  for (const { name, text } of files) {
    for (const span of expressionSpans(text)) {
      for (const read of span.text.matchAll(NEEDS_OUTPUT)) {
        const output = read[1] ?? read[2];
        if (!CREDENTIAL_NAME.test(output)) continue;
        problems.push(
          `${name}:${span.line}: ${span.text.trim()} — reads the job output "${output}", which is printed in the log ` +
            "wherever it is used. Derive the value inside the step that needs it instead."
        );
      }
    }
    for (const out of declaredOutputs(text)) {
      if (!CREDENTIAL_NAME.test(out.name)) continue;
      problems.push(
        `${name}:${out.line}: ${out.text} — declares the job output "${out.name}", which GitHub prints in the log ` +
          "and will not hold as a masked value. Derive the value inside the step that needs it instead."
      );
    }
  }
  return problems;
}

/** argv → what to do, closed over the one flag this script understands. */
export function resolveMode(argv) {
  const known = new Set(["--self-test"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    return {
      mode: "error",
      message: `Unknown flag(s): ${unknown.join(", ")}. This script accepts only --self-test.`,
    };
  }
  return { mode: argv.includes("--self-test") ? "self-test" : "run" };
}

/** A workflow with one job, whose steps are given as text. */
const workflow = (steps, extra = "") => `on:\n  workflow_dispatch:\njobs:\n  a:\n${extra}    steps:\n${steps}`;

/** The checker, checked. Each case breaks exactly one thing this must catch. */
function selfTest() {
  const cases = [];
  // Compared by file and expression, without the line: the line is asserted once, on a hand-written fixture.
  const check = (what, got, want) => {
    cases.push(what);
    const seen = got.map((p) => p.split(" — ")[0].replace(/^([^:]+):\d+: /, "$1: "));
    if (JSON.stringify(seen) !== JSON.stringify(want)) {
      throw new Error(`self-test: ${what} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  };
  const one = (name, text) => [{ name, text }];

  // The shape that prompted this file: a seal key passed as a job output and read into a step's env.
  check(
    "a credential job output read in env",
    outputSecretProblems(
      one("seal.yml", workflow('      - env:\n          SEAL: ${{ needs.prep.outputs.key }}\n        run: echo x\n'))
    ),
    ["seal.yml: ${{ needs.prep.outputs.key }}"]
  );

  check(
    "a credential job output read in with:",
    outputSecretProblems(
      one("with.yml", workflow('      - uses: x/y@v1\n        with:\n          token: ${{ needs.prep.outputs.token }}\n'))
    ),
    ["with.yml: ${{ needs.prep.outputs.token }}"]
  );

  check(
    "a credential job output read in run:",
    outputSecretProblems(one("run.yml", workflow('      - run: echo "${{ needs.prep.outputs.secret }}"\n'))),
    ["run.yml: ${{ needs.prep.outputs.secret }}"]
  );

  check(
    "a credential job output read in an if: condition",
    outputSecretProblems(one("cond.yml", workflow("      - if: needs.prep.outputs.password != ''\n        run: echo x\n"))),
    ["cond.yml: needs.prep.outputs.password != ''"]
  );

  check(
    "a credential job output declared under outputs:",
    outputSecretProblems(
      one(
        "decl.yml",
        workflow(
          "      - run: echo x\n",
          "    outputs:\n      key: ${{ steps.job.outputs.key }}\n"
        )
      )
    ),
    ["decl.yml: key: ${{ steps.job.outputs.key }}"]
  );

  check(
    "an upper-case credential name is still a credential",
    outputSecretProblems(one("case.yml", workflow('      - env:\n          T: ${{ needs.a.outputs.API_TOKEN }}\n        run: x\n'))),
    ["case.yml: ${{ needs.a.outputs.API_TOKEN }}"]
  );

  check(
    "a bracketed credential name is still a credential",
    outputSecretProblems(one("brk.yml", workflow("      - env:\n          T: ${{ needs.a.outputs['db_password'] }}\n        run: x\n"))),
    ["brk.yml: ${{ needs.a.outputs['db_password'] }}"]
  );

  // Output names that carry no credential, in every position the rule reads.
  check(
    "ordinary job outputs pass",
    outputSecretProblems(
      one(
        "ok.yml",
        workflow(
          "      - env:\n" +
            "          MODELS: ${{ needs.prep.outputs.models }}\n" +
            "          PUB: ${{ needs.publish-pub.outputs.public }}\n" +
            "          WRAPPED: ${{ needs.token-key.outputs.wrapped }}\n" +
            "        run: echo x\n",
          "    outputs:\n      public: ${{ needs.token-key.outputs.public }}\n      wrapped: ${{ steps.w.outputs.wrapped }}\n"
        )
      )
    ),
    []
  );

  // A step's own output is not a needs output, so it passes rule (a) even where it names a credential word.
  check(
    "a step output read inside a step's env passes",
    outputSecretProblems(one("step.yml", workflow('      - id: key\n        run: echo x\n      - env:\n          K: ${{ steps.key.outputs.key }}\n        run: echo y\n'))),
    []
  );

  // A multi-line expression is still read: the span is the whole `${{ … }}`, not one line of it.
  check(
    "a credential job output across two lines",
    outputSecretProblems(one("multi.yml", workflow("      - env:\n          K: ${{\n            needs.a.outputs.key\n          }}\n        run: x\n"))),
    ["multi.yml: ${{\n            needs.a.outputs.key\n          }}"]
  );

  // A problem names the line it is on, on a fixture written out by hand.
  const counted = one("counted.yml", ["jobs:", "  a:", "    steps:", "      - env:", "          K: ${{ needs.a.outputs.token }}", ""].join("\n"));
  const countedProblems = outputSecretProblems(counted);
  cases.push("a problem names the line it is on");
  if (countedProblems.length !== 1 || !countedProblems[0].startsWith("counted.yml:5: ")) {
    throw new Error(`self-test: expected counted.yml:5, got ${JSON.stringify(countedProblems)}`);
  }

  // The flag handling: an unknown flag is an error, never a silent fall-through to the scan.
  for (const [argv, expected] of [[[], "run"], [["--self-test"], "self-test"]]) {
    cases.push(`resolveMode(${JSON.stringify(argv)})`);
    if (resolveMode(argv).mode !== expected) throw new Error(`self-test: resolveMode(${JSON.stringify(argv)}) expected ${expected}`);
  }
  for (const argv of [["--slef-test"], ["--self-test", "--extra"], ["--verbose"]]) {
    cases.push(`resolveMode(${JSON.stringify(argv)}) refuses`);
    if (resolveMode(argv).mode !== "error") throw new Error(`self-test: resolveMode(${JSON.stringify(argv)}) must be an error`);
  }

  console.log(`ok   self-test passed (${cases.length} cases)`);
}

let invokedAs = null;
try {
  invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
} catch {
  invokedAs = null;
}
if (invokedAs === import.meta.url) {
  const mode = resolveMode(process.argv.slice(2));

  if (mode.mode === "error") {
    console.error(mode.message);
    process.exit(1);
  }

  if (mode.mode === "self-test") {
    selfTest();
    process.exit(0);
  }

  const names = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  // A floor, so a renamed directory or a checkout that did not happen cannot end in "scanned nothing, exited 0".
  if (names.length < 5) {
    console.error(`Only ${names.length} workflow files found in ${DIR} — wrong root, or nothing checked out.`);
    process.exit(1);
  }

  const files = names.map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
  const problems = outputSecretProblems(files);

  if (problems.length > 0) {
    console.error("Credential-named values passed between jobs or through env:\n");
    for (const p of problems) console.error(p + "\n");
    console.error(
      "The public log prints a step's env: block and a job output used in env:, so neither may carry a secret. " +
        "tex-lab-run.yml shows the fix: each step derives its value from a secret it reads itself."
    );
    process.exit(1);
  }
  console.log(`OK — no credential-named job output crosses a job or reaches a step's env (${files.length} file(s)).`);
}
