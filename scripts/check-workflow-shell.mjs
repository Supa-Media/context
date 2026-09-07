#!/usr/bin/env node
/**
 * Syntax-check every `run:` block in every workflow.
 *
 * These blocks are shell scripts that frequently embed JavaScript via
 * `node -e '…'`. A single apostrophe inside that JavaScript closes the shell's
 * quote early and the rest of the program is handed to bash, which fails with
 * something like:
 *
 *   syntax error near unexpected token `('
 *
 * That shipped: `"this Worker's deliberately uniform refusals"` broke the email
 * deploy's routing check. It went unnoticed because an earlier step in the same
 * script always failed first, so the broken half never ran — a reminder that a
 * step which never executes is not a step that works.
 *
 * An unclosed control structure is the other shape this catches: a step whose
 * `if … then` (or `case`, or a `$( … )` command substitution) is missing its
 * closing keyword or paren leaves bash waiting for input that never comes, and
 * `bash -n` reports it as an unexpected end of file rather than executing the
 * truncated script. (An unterminated heredoc, by contrast, is only ever a
 * *warning* from `bash -n` — checked below so nobody "fixes" this file to rely
 * on catching that.)
 *
 * `bash -n` parses without executing, so this is cheap and side-effect free.
 * It checks shell SYNTAX only — whether the block would be accepted by bash at
 * all — not shell hygiene like a missing `set -euo pipefail`. A block missing
 * that still parses; catching it is a different, lint-shaped question this
 * script does not answer.
 *
 * Run `node scripts/check-workflow-shell.mjs --self-test` to prove the checker
 * still catches what it claims, and that it refuses a flag it does not
 * recognise instead of quietly doing the default thing — see `resolveMode`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
  Resolved from this file rather than the working directory — same bug and same
  fix as `check-workflow-yaml.mjs` and `check-workflow-triggers.mjs`. The
  relative form works only because CI runs from the repo root; anywhere else it
  is an ENOENT stack trace about `scandir`, which reads as "the tool is broken"
  rather than "the tree is wrong".
*/
const DIR = fileURLToPath(new URL("../.github/workflows", import.meta.url));

/** Minimal YAML reach-in: we only need `run:` blocks, not a full parse. */
export function runBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)-?\s*run:\s*\|\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() !== "" && line.search(/\S/) <= indent) break;
      body.push(line);
    }
    blocks.push({ line: i + 1, body: body.join("\n") });
    i = j - 1;
  }
  return blocks;
}

/**
 * @param {{name: string, text: string}[]} files
 * @returns {string[]} one entry per `run:` block bash refuses to parse
 */
export function shellProblems(files) {
  const problems = [];
  for (const { name, text } of files) {
    for (const { line, body } of runBlocks(text)) {
      const res = spawnSync("bash", ["-n"], { input: body, encoding: "utf8" });
      if (res.status !== 0) {
        problems.push(`${name}:${line}\n${(res.stderr || "").trim()}`);
      }
    }
  }
  return problems;
}

/**
 * argv → what to do, closed over the one flag this script understands.
 *
 * This is the fix for the loose end this file was written to close: the
 * script used to read `process.argv` nowhere at all, so `--self-test` — the
 * exact invocation every sibling `check-workflow-*.mjs` uses, and the one
 * `email-worker.yml` was already passing it — was silently ignored. It fell
 * through to the ordinary scan of `.github/workflows`, which passed (there was
 * nothing wrong with this repository's workflows that day), and printed an
 * "OK" that had verified nothing about the checker itself. A self-test that
 * can be typo'd or omitted and still exit 0 is not a self-test, it is a coin
 * that always lands heads.
 *
 * So both failure shapes are refused here rather than absorbed: an unknown
 * flag is an error, not a fall-through to the default `run` mode, and
 * `--self-test` is handled explicitly rather than being one of the things a
 * catch-all branch happens to accept.
 */
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

/** The checker, checked. Each case breaks exactly one thing bash -n must catch. */
function selfTest() {
  const good = [
    {
      name: "mcp.yml",
      text: "jobs:\n  a:\n    steps:\n      - run: |\n          echo hi\n          node -e 'console.log(\"fine\")'\n",
    },
  ];
  if (shellProblems(good).length !== 0) {
    throw new Error("self-test: a well-formed run block must not be flagged.");
  }

  // The actual bug this file exists for: an apostrophe inside a
  // single-quoted `node -e '…'` closes the shell's quote early.
  const apostropheInNodeE = [
    {
      name: "deploy-email-worker.yml",
      text:
        "jobs:\n  a:\n    steps:\n      - run: |\n" +
        "          node -e 'console.log(\"this Worker's deliberately uniform refusals\")'\n",
    },
  ];
  const apostropheProblems = shellProblems(apostropheInNodeE);
  if (apostropheProblems.length !== 1 || !apostropheProblems[0].startsWith("deploy-email-worker.yml:4")) {
    throw new Error(
      "self-test: an apostrophe breaking out of a single-quoted `node -e` must be caught at the right line, got " +
        JSON.stringify(apostropheProblems)
    );
  }

  // The same apostrophe, safely inside a double-quoted JS string, must not be
  // flagged — this is the shape the fix above actually produces.
  const apostropheSafe = [
    {
      name: "deploy-email-worker.yml",
      text:
        "jobs:\n  a:\n    steps:\n      - run: |\n" +
        '          node -e "console.log(\'this Worker\\\'s deliberately uniform refusals\')"\n',
    },
  ];
  if (shellProblems(apostropheSafe).length !== 0) {
    throw new Error("self-test: an apostrophe safely inside a double-quoted JS string must not be flagged.");
  }

  // A second real shape, distinct from quoting: an `if` step is missing its
  // `fi`, leaving bash waiting for input that never comes.
  const unclosedIf = [
    {
      name: "deploy-router.yml",
      text: "jobs:\n  a:\n    steps:\n      - run: |\n          if [ -n \"$FORCE\" ]; then\n            echo forced\n",
    },
  ];
  const ifProblems = shellProblems(unclosedIf);
  if (ifProblems.length !== 1) {
    throw new Error("self-test: an unclosed `if` block must be caught, got " + JSON.stringify(ifProblems));
  }

  // The same block, closed, must not be flagged.
  const closedIf = [
    {
      name: "deploy-router.yml",
      text:
        "jobs:\n  a:\n    steps:\n      - run: |\n          if [ -n \"$FORCE\" ]; then\n            echo forced\n          fi\n",
    },
  ];
  if (shellProblems(closedIf).length !== 0) {
    throw new Error("self-test: a correctly closed `if` block must not be flagged.");
  }

  // An unterminated heredoc is deliberately NOT treated as a problem here —
  // `bash -n` only warns about it, exit 0, so asserting otherwise would pin a
  // behaviour this script cannot actually deliver.
  const unterminatedHeredoc = [
    {
      name: "deploy-router.yml",
      text: "jobs:\n  a:\n    steps:\n      - run: |\n          cat <<EOF > out.txt\n          hello $NAME\n",
    },
  ];
  if (shellProblems(unterminatedHeredoc).length !== 0) {
    throw new Error(
      "self-test: bash -n only warns on an unterminated heredoc (exit 0) — if this now fails, bash's behaviour " +
        "changed and the header's caveat about heredocs needs updating, not this assertion."
    );
  }

  // Two blocks in one file: only the broken one is reported, at its own line
  // — a whole-file failure would mask which step actually breaks.
  const oneOfTwoBroken = [
    {
      name: "mcp.yml",
      text:
        "jobs:\n  a:\n    steps:\n      - run: |\n          echo fine\n" +
        "      - run: |\n          node -e 'broken's quote'\n",
    },
  ];
  const mixedProblems = shellProblems(oneOfTwoBroken);
  if (mixedProblems.length !== 1 || !mixedProblems[0].startsWith("mcp.yml:6")) {
    throw new Error("self-test: only the broken block should be reported, got " + JSON.stringify(mixedProblems));
  }

  // A broken block in one file must not leak into another file's result.
  const acrossFiles = [
    { name: "good.yml", text: "jobs:\n  a:\n    steps:\n      - run: |\n          echo fine\n" },
    { name: "bad.yml", text: "jobs:\n  a:\n    steps:\n      - run: |\n          node -e 'broken\n" },
  ];
  const acrossProblems = shellProblems(acrossFiles);
  if (acrossProblems.length !== 1 || !acrossProblems[0].startsWith("bad.yml:")) {
    throw new Error("self-test: a broken file must not implicate the file next to it, got " + JSON.stringify(acrossProblems));
  }

  // resolveMode: the actual loose end. `--self-test` must select self-test
  // mode, no flags must select the default scan, and anything else — a typo,
  // an unrelated flag — must be an error rather than silently falling back to
  // the default scan (which is what "ignores --self-test" looked like).
  const modeCases = [
    [[], "run"],
    [["--self-test"], "self-test"],
  ];
  for (const [argv, expected] of modeCases) {
    const got = resolveMode(argv);
    if (got.mode !== expected) {
      throw new Error(`self-test: resolveMode(${JSON.stringify(argv)}) expected mode ${expected}, got ${JSON.stringify(got)}`);
    }
  }
  const errorCases = [["--slef-test"], ["--self-test", "--extra"], ["--verbose"]];
  for (const argv of errorCases) {
    const got = resolveMode(argv);
    if (got.mode !== "error") {
      throw new Error(`self-test: resolveMode(${JSON.stringify(argv)}) must be an error, got ${JSON.stringify(got)}`);
    }
  }

  const fixedCases = 8; // good, apostrophe x2, if/fi x2, heredoc, mixed-block, across-files
  console.log(`ok   self-test passed (${fixedCases + modeCases.length + errorCases.length} cases)`);
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

  // A floor, for the same reason `check-workflow-yaml.mjs` has one: every way
  // this can be wrong short of a bad flag — a renamed directory, a checkout
  // that did not happen — ends in "scanned nothing, printed OK, exited 0".
  if (names.length < 5) {
    console.error(`Only ${names.length} workflow files found in ${DIR} — wrong root, or nothing checked out.`);
    process.exit(1);
  }

  const files = names.map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
  const problems = shellProblems(files);

  if (problems.length > 0) {
    console.error("Shell syntax errors in workflow run blocks:\n");
    for (const p of problems) console.error(p + "\n");
    console.error("A stray apostrophe inside an embedded node -e '…' is the usual cause.");
    process.exit(1);
  }
  console.log(`OK — every run block in ${files.length} workflow file(s) parses as shell.`);
}
