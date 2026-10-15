#!/usr/bin/env node
/**
 * No `${{ … }}` reaches a shell unless its value is constrained.
 *
 * GitHub substitutes an expression into a `run:` block **as text, before bash
 * sees the line**. So a free-text value that contains a quote closes the
 * string it was pasted into and the rest is a command. The jobs that read
 * free text are also the jobs that hold this product's deploy and model
 * credentials, which makes the substitution the shortest path from "may press
 * Run workflow" to "may read production's secrets" — without a commit, a
 * review, or anything in the diff to notice.
 *
 * The fix is one line of plumbing and it is already the house pattern:
 * `rollback-router.yml` passes its dispatch input through `env:` and quotes
 * `"$VERSION_ID"`, and validates the shape before using it. Doing that
 * everywhere is cheap; remembering to is not, which is what this file is for.
 *
 * ## The rule, and why it is an allowlist
 *
 * Every expression in a shell line must be one of:
 *
 *  - a value GitHub itself constrains — `SAFE_REFERENCES` below: run counters,
 *    a commit sha, the repository's own name;
 *  - `inputs.<name>` where **this workflow declares that input `type: boolean`
 *    or `type: choice`**, which GitHub validates at dispatch, so no other
 *    string can arrive;
 *  - `matrix.<…>` in a workflow whose matrices are written out in the file —
 *    those values are the author's, typed into the tree. A workflow that
 *    builds a matrix with `fromJSON` has values from somewhere this file
 *    cannot see, so its `matrix.*` uses need an entry in `REVIEWED` saying
 *    where they come from.
 *
 * Anything else fails, including shapes nobody has thought of yet. That is
 * deliberate: the sibling guard this file sits beside collected what it
 * checked *by name* and so passed the one construction that named nothing
 * (see `deployEnv.test.ts`). A denylist of today's dangerous expressions would
 * repeat that mistake.
 *
 * Note what the second case does **not** do: it does not take the author's
 * word that an input is typed. It re-reads the `inputs:` block and checks, so
 * deleting a `type: choice` line turns the exception off rather than leaving a
 * guard that agrees with a claim the file no longer makes.
 *
 * ## What it does not check
 *
 * Shell *syntax* (`check-workflow-shell.mjs`), triggers
 * (`check-workflow-triggers.mjs`), and secrets in `env:` — a secret passed
 * through `env:` is how it is supposed to travel, and this file has nothing to
 * say about it.
 *
 * Run `node scripts/check-workflow-interpolation.mjs --self-test` to prove the
 * checker still catches what it claims — including that it refuses an unknown
 * flag instead of quietly doing the default thing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
  Resolved from this file rather than the working directory — the same bug and
  the same fix as its siblings. The relative form works only because CI runs
  from the repo root; anywhere else it is an ENOENT about `scandir`, which
  reads as "the tool is broken" rather than "the tree is wrong".
*/
const DIR = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/**
 * Expressions GitHub constrains for us, so a shell cannot be surprised by one.
 *
 * Numbers, a hex sha, and names that cannot hold a quote or a semicolon. Short
 * on purpose: every addition is a claim that a value can never be chosen by
 * somebody who can reach the workflow.
 */
export const SAFE_REFERENCES = new Set([
  "github.run_number",
  "github.run_id",
  "github.run_attempt",
  "github.sha",
  "github.repository",
  "github.repository_owner",
  "github.workflow",
  "github.job",
  "github.ref_type",
  "github.server_url",
  "github.api_url",
  "runner.os",
  "runner.arch",
  "runner.temp",
  "strategy.job-index",
]);

/**
 * The handful of references read in a shell that are neither constrained by
 * GitHub nor literals in their own file, each with where its value comes from.
 *
 * Keyed by file and by the expression as written, so moving a line does not
 * silently retire an entry and a *different* expression in the same file is
 * still refused. Every entry is a sentence somebody has to be willing to
 * write; `interpolationProblems` ignores an entry whose reason is empty, so a
 * blank cannot be used to wave one through.
 */
export const REVIEWED = {
  "deploy-staging.yml": {
    "${{ matrix.worker.package }}":
      "the matrix is fromJSON(needs.plan.outputs.workers), built by the plan job from this repository's own " +
      "package list; the values are package names in the tree, not text a caller supplies",
    "${{ matrix.worker.name == 'mcp' && '--filter \"@context/site-shots...\"' || '' }}":
      "same matrix, and the expression yields one of two literals written here",
  },
};

/**
 * Whether this workflow's matrices are literals.
 *
 * `fromJSON` anywhere in the file is read as "a matrix may be built from
 * something computed" and turns the blanket allowance off for the whole file,
 * which is blunt and fails closed: a reviewed use then needs a `REVIEWED`
 * entry naming its source, and an unreviewed one is reported.
 */
export function matrixIsLiteral(text) {
  return !/fromJSON\s*\(/.test(text);
}

/** The contexts an expression can read a value from; anything here is checked. */
const CONTEXT = /\b(?:github|inputs|env|secrets|vars|steps|needs|job|jobs|matrix|runner|strategy)(?:\.[A-Za-z0-9_-]+)+/g;

/** Input types GitHub validates at dispatch, so the value is one of a known set. */
const CONSTRAINED_TYPES = new Set(["boolean", "choice"]);

/**
 * Every line of shell in a workflow, with its line number.
 *
 * Both shapes count: a block scalar (`run: |`) and a one-line `run: …`. The
 * sibling `check-workflow-shell.mjs` exports a block-scalar reader, which is
 * right for handing a whole script to `bash -n` and wrong here — a single-line
 * `run: echo ${{ inputs.name }}` is exactly as substituted as a long one.
 */
export function shellLines(text) {
  const lines = text.split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i].match(/^(\s*)-?\s*run:\s*[|>][-+]?\s*$/);
    if (block) {
      const indent = block[1].length;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() !== "" && line.search(/\S/) <= indent) break;
        found.push({ line: j + 1, text: line });
      }
      i = j - 1;
      continue;
    }
    const inline = lines[i].match(/^\s*-?\s*run:\s*(\S.*)$/);
    if (inline) found.push({ line: i + 1, text: inline[1] });
  }
  return found;
}

/**
 * The input types a workflow declares, as `name → type`.
 *
 * A minimal reach-in rather than a YAML parse, like its siblings: find an
 * `inputs:` mapping, then read `name:` keys and the `type:` under each. An
 * input with no `type:` line is a string, which is what the absence means to
 * GitHub too, and is reported as `"string"` rather than left undefined so a
 * caller cannot mistake "declared as free text" for "not declared here".
 */
export function inputTypes(text) {
  const lines = text.split("\n");
  const types = new Map();
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(\s*)inputs:\s*$/);
    if (!head) continue;
    const base = head[1].length;
    let name = null;
    let nameIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const indent = line.search(/\S/);
      if (indent <= base) break;
      const key = line.match(/^\s*([A-Za-z0-9_-]+):\s*(\S.*)?$/);
      if (!key) continue;
      if (name === null || indent <= nameIndent) {
        name = key[1];
        nameIndent = indent;
        if (!types.has(name)) types.set(name, "string");
        continue;
      }
      if (key[1] === "type" && key[2]) types.set(name, key[2].trim().replace(/^["']|["']$/g, ""));
    }
  }
  return types;
}

/** Whether one context reference may be substituted into a shell line. */
export function referenceAllowed(reference, types, literalMatrix = false) {
  if (SAFE_REFERENCES.has(reference)) return true;
  if (literalMatrix && /^matrix\./.test(reference)) return true;
  const input = reference.match(/^inputs\.([A-Za-z0-9_-]+)$/);
  return input !== null && CONSTRAINED_TYPES.has(types.get(input[1]) ?? "string");
}

/**
 * @param {{name: string, text: string}[]} files
 * @returns {string[]} one entry per expression that must not be in a shell line
 */
export function interpolationProblems(files) {
  const problems = [];
  for (const { name, text } of files) {
    const types = inputTypes(text);
    const literalMatrix = matrixIsLiteral(text);
    const reviewed = REVIEWED[name] ?? {};
    for (const { line, text: shell } of shellLines(text)) {
      for (const expression of shell.match(/\$\{\{[^}]*\}\}/g) ?? []) {
        if ((reviewed[expression] ?? "") !== "") continue;
        const inner = expression.slice(3, -2);
        const referenced = inner.match(CONTEXT) ?? [];
        // An expression naming no context is a literal; GitHub still rewrites
        // it, but there is nothing in it a caller chose.
        const unsafe = referenced.filter((reference) => !referenceAllowed(reference, types, literalMatrix));
        if (referenced.length === 0 || unsafe.length === 0) continue;
        problems.push(
          `${name}:${line}: ${expression} — ${unsafe.join(", ")} ` +
            `${unsafe.length === 1 ? "is" : "are"} substituted into shell before bash reads the line. ` +
            `Pass it through the step's env: and use "$NAME".`
        );
      }
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

const file = (name, body) => ({ name, text: body });
const steps = (body) => `on:\n  workflow_dispatch:\n    inputs:\n${body.inputs ?? ""}jobs:\n  a:\n    steps:\n${body.steps}`;

/** The checker, checked. Each case breaks exactly one thing this must catch. */
function selfTest() {
  const cases = [];
  /*
    Compared by file and expression, with the line dropped: the fixtures below
    are built by `steps()` and their line numbers are an artefact of that
    helper rather than of the thing being checked. That a problem is reported
    at the line it is on is asserted once, on a fixture written out by hand —
    "the right line" is a real claim and is made where it can be read.
  */
  const check = (what, got, want) => {
    cases.push(what);
    const seen = got.map((p) => p.split(" — ")[0].replace(/:\d+:/, ":"));
    if (JSON.stringify(seen) !== JSON.stringify(want)) {
      throw new Error(`self-test: ${what} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  };

  // The shape that prompted this file: a free-text dispatch input pasted into
  // a block scalar. Caught, at the line it is on.
  const freeText = [
    file(
      "ai-benchmark.yml",
      steps({
        inputs: '      setups:\n        required: false\n        default: ""\n',
        steps: '      - run: |\n          pnpm ai run --setups "${{ inputs.setups }}"\n',
      })
    ),
  ];
  check("a free-text input in a block scalar", interpolationProblems(freeText), ['ai-benchmark.yml: ${{ inputs.setups }}']);

  // The same value, passed the way it should be: nothing to report.
  const viaEnv = [
    file(
      "ai-benchmark.yml",
      steps({
        inputs: '      setups:\n        required: false\n        default: ""\n',
        steps: '      - env:\n          SETUPS: ${{ inputs.setups }}\n        run: |\n          pnpm ai run --setups "$SETUPS"\n',
      })
    ),
  ];
  check("the same input through env:", interpolationProblems(viaEnv), []);

  // A one-line `run:`, which the block-scalar reader next door does not see.
  const inline = [file("devlog.yml", steps({ steps: '      - run: echo ${{ github.event.issue.title }}\n' }))];
  check("an event field in a one-line run", interpolationProblems(inline), ['devlog.yml: ${{ github.event.issue.title }}']);

  // A branch name: no spaces or quotes, but `;` and backticks are legal in a
  // git ref, which is the classic Actions injection.
  const ref = [file("ci.yml", steps({ steps: '      - run: |\n          echo "${{ github.head_ref }}"\n' }))];
  check("a head ref", interpolationProblems(ref), ['ci.yml: ${{ github.head_ref }}']);

  // A run counter is GitHub's own integer.
  const counter = [file("ai-benchmark.yml", steps({ steps: '      - run: |\n          echo "gh-${{ github.run_number }}"\n' }))];
  check("a run number", interpolationProblems(counter), []);

  // A typed input is validated at dispatch, so it is allowed …
  const typed = [
    file(
      "deploy-mobile-native.yml",
      steps({
        inputs: "      profile:\n        type: choice\n        options: [production, staging]\n",
        steps: '      - run: |\n          echo "profile ${{ inputs.profile }}"\n',
      })
    ),
  ];
  check("a type: choice input", interpolationProblems(typed), []);

  // … and the exception is checked, not trusted: drop the `type:` line and the
  // same file fails. This is the half that makes the allowlist honest.
  const untyped = [
    file(
      "deploy-mobile-native.yml",
      steps({
        inputs: "      profile:\n        options: [production, staging]\n",
        steps: '      - run: |\n          echo "profile ${{ inputs.profile }}"\n',
      })
    ),
  ];
  check("the same input with its type removed", interpolationProblems(untyped), ['deploy-mobile-native.yml: ${{ inputs.profile }}']);

  // A boolean, the other constrained type.
  const boolean = [
    file(
      "publish-cli.yml",
      steps({
        inputs: "      dry_run:\n        type: boolean\n        default: false\n",
        steps: '      - run: |\n          if [ "${{ inputs.dry_run }}" = "true" ]; then echo dry; fi\n',
      })
    ),
  ];
  check("a type: boolean input", interpolationProblems(boolean), []);

  // A step output: derived from something, and this file cannot see from what.
  const output = [file("ai-benchmark.yml", steps({ steps: '      - run: |\n          pnpm ai score "${{ steps.name.outputs.result }}"\n' }))];
  check("a step output", interpolationProblems(output), ['ai-benchmark.yml: ${{ steps.name.outputs.result }}']);

  // An `if:` on a step is an expression GitHub evaluates, not text handed to a
  // shell, so it is none of this file's business.
  const condition = [
    file(
      "publish-cli.yml",
      steps({
        inputs: "      dry_run:\n        type: boolean\n",
        steps: '      - if: ${{ inputs.dry_run != true }}\n        run: |\n          echo publishing\n',
      })
    ),
  ];
  check("an if: condition", interpolationProblems(condition), []);

  // One bad file must not implicate the file beside it.
  const two = [
    file("good.yml", steps({ steps: '      - run: |\n          echo fine\n' })),
    file("bad.yml", steps({ inputs: "      name:\n", steps: '      - run: |\n          echo ${{ inputs.name }}\n' })),
  ];
  check("a bad file does not implicate its neighbour", interpolationProblems(two), ['bad.yml: ${{ inputs.name }}']);

  // A matrix written out in the file is the author's own list.
  const literal = [
    file(
      "browser.yml",
      "jobs:\n  a:\n    strategy:\n      matrix:\n        shard: [\"1/2\", \"2/2\"]\n    steps:\n" +
        '      - run: |\n          pnpm test --shard "${{ matrix.shard }}"\n'
    ),
  ];
  check("a literal matrix", interpolationProblems(literal), []);

  // The same reference in a file that builds a matrix from JSON: the values
  // come from somewhere this file cannot see, so it needs a reviewed entry.
  const dynamic = [
    file(
      "workers.yml",
      "jobs:\n  a:\n    strategy:\n      matrix:\n        worker: ${{ fromJSON(needs.plan.outputs.workers) }}\n    steps:\n" +
        '      - run: |\n          pnpm --filter "${{ matrix.worker.package }}" test\n'
    ),
  ];
  check("a matrix built with fromJSON", interpolationProblems(dynamic), [
    "workers.yml: ${{ matrix.worker.package }}",
  ]);

  // And `REVIEWED` covers exactly what it names: the entry for one file's
  // expression does not cover the same expression elsewhere, nor a different
  // expression in the file it belongs to.
  const elsewhere = [
    file(
      "another.yml",
      "jobs:\n  a:\n    strategy:\n      matrix:\n        worker: ${{ fromJSON(needs.plan.outputs.workers) }}\n    steps:\n" +
        '      - run: |\n          pnpm --filter "${{ matrix.worker.package }}" test\n'
    ),
    file(
      "deploy-staging.yml",
      "jobs:\n  a:\n    strategy:\n      matrix:\n        worker: ${{ fromJSON(needs.plan.outputs.workers) }}\n    steps:\n" +
        '      - run: |\n          pnpm --filter "${{ matrix.worker.package }}" test\n          echo "${{ matrix.worker.dir }}"\n'
    ),
  ];
  check("a reviewed entry covers only its own file and expression", interpolationProblems(elsewhere), [
    "another.yml: ${{ matrix.worker.package }}",
    "deploy-staging.yml: ${{ matrix.worker.dir }}",
  ]);

  cases.push("every REVIEWED entry carries a reason");
  for (const [where, entries] of Object.entries(REVIEWED)) {
    for (const [expression, reason] of Object.entries(entries)) {
      if (typeof reason !== "string" || reason.trim().length < 20) {
        throw new Error(`self-test: ${where} ${expression} needs a reason saying where the value comes from.`);
      }
    }
  }

  // The line a problem is reported at, on a fixture written out by hand so the
  // count can be read rather than worked out.
  const counted = [
    file(
      "devlog-draft.yml",
      [
        "jobs:", // 1
        "  a:", // 2
        "    steps:", // 3
        "      - run: |", // 4
        "          echo fine", // 5
        '          echo "${{ github.event.issue.title }}"', // 6
        "", // 7
      ].join("\n")
    ),
  ];
  cases.push("a problem names the line it is on");
  const countedProblems = interpolationProblems(counted);
  if (countedProblems.length !== 1 || !countedProblems[0].startsWith("devlog-draft.yml:6: ")) {
    throw new Error(`self-test: expected devlog-draft.yml:6, got ${JSON.stringify(countedProblems)}`);
  }

  // inputTypes, directly: the reach-in has to tell the two shapes apart.
  const declared = inputTypes(
    steps({
      inputs:
        "      job:\n        required: false\n        default: x\n      fake:\n        type: boolean\n        default: false\n",
      steps: "      - run: true\n",
    })
  );
  cases.push("inputTypes reads a declaration");
  if (declared.get("job") !== "string" || declared.get("fake") !== "boolean" || declared.size !== 2) {
    throw new Error(`self-test: inputTypes expected {job: string, fake: boolean}, got ${JSON.stringify([...declared])}`);
  }

  // resolveMode: an unknown flag is an error, never a silent fall-through to
  // the default scan — the shape that made a sibling's --self-test a no-op.
  for (const [argv, expected] of [[[], "run"], [["--self-test"], "self-test"]]) {
    cases.push(`resolveMode(${JSON.stringify(argv)})`);
    if (resolveMode(argv).mode !== expected) {
      throw new Error(`self-test: resolveMode(${JSON.stringify(argv)}) expected ${expected}`);
    }
  }
  for (const argv of [["--slef-test"], ["--self-test", "--extra"], ["--verbose"]]) {
    cases.push(`resolveMode(${JSON.stringify(argv)}) refuses`);
    if (resolveMode(argv).mode !== "error") {
      throw new Error(`self-test: resolveMode(${JSON.stringify(argv)}) must be an error`);
    }
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

  // A floor, for the same reason every sibling has one: a renamed directory or
  // a checkout that did not happen otherwise ends in "scanned nothing, printed
  // OK, exited 0".
  if (names.length < 5) {
    console.error(`Only ${names.length} workflow files found in ${DIR} — wrong root, or nothing checked out.`);
    process.exit(1);
  }

  const files = names.map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
  const problems = interpolationProblems(files);

  if (problems.length > 0) {
    console.error("Expressions substituted straight into a shell:\n");
    for (const p of problems) console.error(p + "\n");
    console.error(
      "GitHub pastes an expression into the line as text before bash parses it, so a value holding a quote " +
        "becomes a command. `rollback-router.yml` shows the fix: env: NAME: ${{ … }}, then \"$NAME\"."
    );
    process.exit(1);
  }
  console.log(`OK — no workflow substitutes an unconstrained value into a shell (${files.length} file(s)).`);
}
