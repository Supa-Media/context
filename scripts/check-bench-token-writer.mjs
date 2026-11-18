#!/usr/bin/env node
/**
 * The job that runs a branch's code must not be the job that holds a token
 * able to write production secrets.
 *
 * tex-lab-run.yml checks out the Lab draft's commit and runs that commit's
 * `pnpm install` and `pnpm ai spend check`. tex-replay.yml checks out the
 * branch it was dispatched on and runs that branch's install and sign-in.
 * Either can prepend to `$GITHUB_PATH`, or replace a binary the runner user
 * can write, before a later step in the same job. A later step that calls
 * `node` or `gh` with a secret in its environment then runs the branch's
 * program and hands it the secret.
 *
 * That is what the write-back did. The step that stored the rotated
 * benchmark refresh token sat in the same job as the branch, with the
 * repository admin token in the step's environment. The comment said the
 * token stayed off branch code. It did not: the boundary is the job, and
 * `$GITHUB_PATH` survives from one step to the next.
 *
 * The write now happens in a later job that checks out main and nothing
 * else, with BENCH_SECRET_WRITER_TOKEN. These two workflows must not name
 * the admin token at all. A job that checks out anything other than main
 * and then runs code must not name the writer token, and must not receive
 * the seal key's private half (`outputs.wrapped`).
 *
 * That write is `gh secret set` of BENCH_RUNNER_REFRESH_TOKEN_LIVE. The
 * command reads the value from `--body` or from stdin. It has no
 * `--body-file`. An unknown flag exits 1 before the API call, the rotated
 * token is never stored, and the next sign-in presents a retired token,
 * which revokes the grant.
 *
 *   node scripts/check-bench-token-writer.mjs
 *   node scripts/check-bench-token-writer.mjs --self-test
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TOKEN_PKEYOPTS, WRAP_CIPHER } from "./bench-token-open.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = join(ROOT, ".github/workflows");
const FILES = ["tex-lab-run.yml", "tex-replay.yml"];

/** What a branch job must not be able to see. The admin token is banned in the whole file. */
const BRANCH_FORBIDDEN = ["BENCH_SECRET_WRITER_TOKEN", "outputs.wrapped", "outputs.private"];

const SEAL_MARKERS = [...TOKEN_PKEYOPTS, WRAP_CIPHER.join(" ")];

/**
 * Flags `gh secret set` accepts in gh 2.103.0, plus the inherited `--repo`.
 * `true` means the next word is the flag's value, unless the flag is `--name=value`.
 */
const SECRET_SET_FLAGS = new Map([
  ["-a", true],
  ["--app", true],
  ["-b", true],
  ["--body", true],
  ["-e", true],
  ["--env", true],
  ["-f", true],
  ["--env-file", true],
  ["--no-repos-selected", false],
  ["--no-store", false],
  ["-o", true],
  ["--org", true],
  ["-r", true],
  ["--repos", true],
  ["-R", true],
  ["--repo", true],
  ["-u", false],
  ["--user", false],
  ["-v", true],
  ["--visibility", true],
  ["--help", false],
]);

/** Join backslash-continued lines and drop comments, so a flag is not hidden on the next line. */
function commandLines(text) {
  const lines = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("#")) {
      if (pending) {
        lines.push(pending);
        pending = "";
      }
      continue;
    }
    const continued = /\\$/.test(raw);
    const piece = continued ? raw.slice(0, -1) : raw;
    pending = pending ? `${pending} ${piece.trim()}` : piece;
    if (!continued) {
      lines.push(pending);
      pending = "";
    }
  }
  if (pending) lines.push(pending);
  return lines;
}

/** Words of one shell command, up to an unquoted `;` or `#`. Quotes are removed, not interpreted. */
function shellWords(line) {
  const words = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#") break;
    if (ch === ";") {
      if (current) words.push(current);
      return words;
    }
    if (ch === " " || ch === "\t") {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

/**
 * A production write that `gh secret set` will not perform. `--body-file` is
 * the case that shipped: gh exits 1 before the API call. The value has to
 * come from `--body` or from a stdin redirect. `--env-file` is a real flag
 * and the wrong shape: it parses dotenv, not the token file.
 */
function secretSetProblems(name, text) {
  const problems = [];
  for (const line of commandLines(text)) {
    if (!line.includes("gh secret set")) continue;
    const words = shellWords(line);
    const at = words.findIndex((word, index) => word === "gh" && words[index + 1] === "secret" && words[index + 2] === "set");
    if (at < 0) {
      problems.push(`${name} has a gh secret set the checker could not read: ${line.trim()}`);
      continue;
    }
    const secretName = words[at + 3];
    if (!secretName || secretName.startsWith("-")) {
      problems.push(`${name} has a gh secret set with no secret name.`);
      continue;
    }
    let readsBody = false;
    let readsStdin = false;
    const rest = words.slice(at + 4);
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i];
      if (word === "<" || (word.startsWith("<") && !word.startsWith("<<"))) {
        readsStdin = true;
        continue;
      }
      if (!word.startsWith("-")) continue;
      const flag = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      const takesValue = SECRET_SET_FLAGS.get(flag);
      if (takesValue === undefined) {
        problems.push(
          `${name} writes with \`gh secret set ${secretName}\` using ${flag}, which gh secret set does not have. The value comes from --body or from stdin.`,
        );
        continue;
      }
      if (flag === "--body" || flag === "-b") readsBody = true;
      if (takesValue && !word.includes("=")) i += 1;
    }
    if (secretName === "BENCH_RUNNER_REFRESH_TOKEN_LIVE" && !readsBody && !readsStdin) {
      problems.push(
        `${name} writes BENCH_RUNNER_REFRESH_TOKEN_LIVE without --body and without reading stdin. gh secret set would prompt, or store a dotenv file, instead of the token.`,
      );
    }
  }
  return problems;
}

function stripComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

/** Top-level jobs, as `{ id, text }`. A two-space key under `jobs:` starts one. */
export function jobsOf(yaml) {
  const lines = yaml.split("\n");
  const jobs = [];
  let inJobs = false;
  let current = null;
  for (const line of lines) {
    if (!inJobs) {
      if (line === "jobs:") inJobs = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) break;
    const header = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      current = { id: header[1], lines: [line] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs.map((job) => ({ id: job.id, text: job.lines.join("\n") }));
}

function stepsOf(jobText) {
  return jobText.split(/^      - /m).slice(1).map((step) => `      - ${step}`);
}

/**
 * A checkout runs non-main code when its ref is not the literal `main`.
 * No ref means the triggering ref, which for these two workflows is the
 * branch. One such checkout taints the job: `$GITHUB_PATH` is the job's.
 */
export function checksOutNonMain(jobText) {
  for (const step of stepsOf(jobText)) {
    if (!step.includes("actions/checkout@")) continue;
    const ref = step.match(/^\s+ref:\s*(.+)$/m);
    if (!ref) return true;
    const value = ref[1].trim().replace(/^['"]|['"]$/g, "");
    if (value !== "main") return true;
  }
  return false;
}

function runsCode(jobText) {
  return /^\s+run:/m.test(jobText);
}

/**
 * Problems in one workflow's text. `name` is the file name, for the message.
 * Comments count for the admin-token ban and not for the per-job scan: a
 * sentence must be able to name the writer token, and must not be able to
 * put the admin token back into the file under the excuse that it is prose.
 */
export function problemsIn(name, text) {
  const problems = [];
  if (text.includes("GH_ADMIN_TOKEN")) {
    problems.push(`${name} names GH_ADMIN_TOKEN. The writer job uses BENCH_SECRET_WRITER_TOKEN, and this file does not name the admin token.`);
  }
  const jobs = jobsOf(stripComments(text));
  if (jobs.length === 0) problems.push(`${name} has no jobs. The checker read nothing, which is not a pass.`);
  let writerOnMain = false;
  for (const job of jobs) {
    const branch = checksOutNonMain(job.text) && runsCode(job.text);
    if (branch) {
      for (const needle of BRANCH_FORBIDDEN) {
        if (job.text.includes(needle)) {
          problems.push(`${name} job ${job.id} checks out non-main code and names ${needle}.`);
        }
      }
      if (job.text.includes("GH_ADMIN_TOKEN")) {
        problems.push(`${name} job ${job.id} checks out non-main code and names GH_ADMIN_TOKEN.`);
      }
    }
    const namesWriter = job.text.includes("secrets.BENCH_SECRET_WRITER_TOKEN");
    if (namesWriter && !branch && !checksOutNonMain(job.text) && /^\s+ref:\s*['"]?main['"]?\s*$/m.test(job.text)) writerOnMain = true;
    if (namesWriter && branch) {
      problems.push(`${name} job ${job.id} reads BENCH_SECRET_WRITER_TOKEN while running non-main code.`);
    }
  }
  for (const marker of SEAL_MARKERS) {
    const seen = text.split(marker).length - 1;
    if (seen < 2) problems.push(`${name} uses ${marker} ${seen} time(s); the seal and the open both need it, twice (two seals, or a wrap and an unwrap).`);
  }
  if (!writerOnMain) {
    problems.push(`${name} does not read BENCH_SECRET_WRITER_TOKEN from a job whose checkout is main.`);
  }
  problems.push(...secretSetProblems(name, text));
  return problems;
}

function scan(dir = WORKFLOWS) {
  const problems = [];
  for (const name of FILES) {
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (error) {
      problems.push(`${name} could not be read (${error.code ?? error.message}).`);
      continue;
    }
    problems.push(...problemsIn(name, text));
  }
  return problems;
}

function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  const branchAndAdmin = `
name: Example
jobs:
  run:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: \${{ needs.prep.outputs.sha }}
      - run: pnpm install --frozen-lockfile
      - name: Keep the token
        env:
          GH_TOKEN: \${{ secrets.GH_ADMIN_TOKEN }}
        run: gh secret set BENCH_RUNNER_REFRESH_TOKEN_LIVE --env production --body "$next"
`;
  const found = problemsIn("example.yml", branchAndAdmin);
  expect("a branch checkout with the admin token fails", found.some((line) => line.includes("GH_ADMIN_TOKEN")));

  const commentOnly = "name: Example\n# the admin token is GH_ADMIN_TOKEN\njobs:\n  stay:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          ref: main\n      - run: echo hi\n      - env:\n          GH_TOKEN: ${{ secrets.BENCH_SECRET_WRITER_TOKEN }}\n        run: echo Using secret BENCH_SECRET_WRITER_TOKEN\n" +
    SEAL_MARKERS.map((marker) => `# ${marker}\n# ${marker}\n`).join("");
  // The markers have to be in the file twice as real lines. A comment is still
  // the file, and the marker scan does not strip comments: the workflows name
  // the flags in the run blocks, which are not comments.
  const commentedAdmin = problemsIn("comment.yml", commentOnly);
  expect("the admin token in a comment still fails", commentedAdmin.some((line) => line.includes("GH_ADMIN_TOKEN")));

  const good = `name: Example
jobs:
  token-key:
    steps:
      - run: echo wrap
  run:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: \${{ needs.prep.outputs.sha }}
      - run: pnpm install
  write-token:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: main
      - env:
          GH_TOKEN: \${{ secrets.BENCH_SECRET_WRITER_TOKEN }}
        run: echo Using secret BENCH_SECRET_WRITER_TOKEN
${SEAL_MARKERS.map((marker) => `      # keep\n      - run: echo ${marker}\n      - run: echo ${marker}`).join("\n")}
`;
  expect("main checkout may hold the writer token", problemsIn("good.yml", good).length === 0);

  const leakedKey = `name: Example
jobs:
  run:
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - env:
          KEY: \${{ needs.token-key.outputs.wrapped }}
        run: echo "$KEY"
  write-token:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: main
      - env:
          GH_TOKEN: \${{ secrets.BENCH_SECRET_WRITER_TOKEN }}
        run: echo Using secret BENCH_SECRET_WRITER_TOKEN
${SEAL_MARKERS.map((marker) => `      - run: echo ${marker} ${marker}`).join("\n")}
`;
  const leaked = problemsIn("leaked.yml", leakedKey);
  expect("a branch job that receives the wrapped key fails", leaked.some((line) => line.includes("outputs.wrapped")));

  const noRef = `name: Example
jobs:
  replay:
    steps:
      - uses: actions/checkout@v5
        with:
          sparse-checkout: scripts
      - env:
          GH_TOKEN: \${{ secrets.BENCH_SECRET_WRITER_TOKEN }}
        run: gh secret set X
  write-token:
    steps:
      - uses: actions/checkout@v5
        with:
          ref: main
      - env:
          GH_TOKEN: \${{ secrets.BENCH_SECRET_WRITER_TOKEN }}
        run: echo ok
${SEAL_MARKERS.map((marker) => `      - run: echo ${marker}\n      - run: echo ${marker}`).join("\n")}
`;
  expect("a checkout with no ref is the triggering branch", problemsIn("noref.yml", noRef).some((line) => line.includes("non-main")));

  const onMain = jobsOf("jobs:\n  prep:\n    steps:\n      - uses: actions/checkout@v5\n        with:\n          ref: main\n");
  expect("parses a job", onMain.length === 1 && onMain[0].id === "prep");
  expect("main is not a branch checkout", checksOutNonMain(onMain[0].text) === false);

  const stdinWrite = good.replace(
    "run: echo Using secret BENCH_SECRET_WRITER_TOKEN",
    'run: gh secret set BENCH_RUNNER_REFRESH_TOKEN_LIVE --env production --repo "$GITHUB_REPOSITORY" < "$RUNNER_TEMP/refresh-token"',
  );
  expect("stdin is how the production secret is written", problemsIn("stdin.yml", stdinWrite).length === 0);

  const bodyWrite = good.replace(
    "run: echo Using secret BENCH_SECRET_WRITER_TOKEN",
    'run: gh secret set BENCH_RUNNER_REFRESH_TOKEN_LIVE --env production --repo "$GITHUB_REPOSITORY" --body "$next"',
  );
  expect("--body is how the production secret is written", problemsIn("body.yml", bodyWrite).length === 0);

  const brokenWrite = good.replace(
    "run: echo Using secret BENCH_SECRET_WRITER_TOKEN",
    'run: |\n          if ! gh secret set BENCH_RUNNER_REFRESH_TOKEN_LIVE --env production --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/refresh-token"; then\n            exit 1\n          fi',
  );
  const brokenProblems = problemsIn("broken.yml", brokenWrite);
  expect(
    "gh secret set --body-file fails",
    brokenProblems.some((line) => line.includes("--body-file") && line.includes("does not have")),
  );

  const envFile = good.replace(
    "run: echo Using secret BENCH_SECRET_WRITER_TOKEN",
    'run: gh secret set BENCH_RUNNER_REFRESH_TOKEN_LIVE --env production --env-file "$RUNNER_TEMP/refresh-token"',
  );
  expect(
    "a dotenv file is not the token",
    problemsIn("envfile.yml", envFile).some((line) => line.includes("without --body")),
  );

  const commentedFlag = `${stdinWrite}\n# gh secret set BENCH_RUNNER_REFRESH_TOKEN_LIVE --body-file "$RUNNER_TEMP/refresh-token"\n`;
  expect("a comment may name --body-file", problemsIn("comment-flag.yml", commentedFlag).length === 0);

  const live = scan();
  // Before the fix this list is non-empty. The self-test does not require the
  // live files to be clean: that is what running the checker without
  // --self-test is for, and a self-test that demanded today's files would not
  // run on the tree it is supposed to reject.
  expect("the live scan returns a list", Array.isArray(live));

  if (failures.length) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("Self-test passed.");
}

function run() {
  const names = readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));
  if (names.length < 5) {
    console.error(`Only ${names.length} workflow files in ${WORKFLOWS}. Wrong root, or nothing checked out.`);
    process.exit(1);
  }
  const problems = scan();
  if (problems.length) {
    console.error("The benchmark token writer check failed:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`OK — ${FILES.join(" and ")} keep the writer token on main's checkout, and the refresh-token write is stdin or --body.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const flag = process.argv[2];
  if (flag && flag !== "--self-test") {
    console.error(`unexpected argument ${flag}`);
    process.exit(1);
  }
  if (flag === "--self-test") selfTest();
  else run();
}
