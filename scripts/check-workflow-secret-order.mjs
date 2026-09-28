#!/usr/bin/env node
/**
 * No deploy workflow may run `wrangler secret put` before `wrangler deploy`.
 *
 * ── WHAT WENT WRONG (#302) ───────────────────────────────────────────────────
 *
 * `wrangler secret put` acts on whatever version of a Worker's script is
 * CURRENTLY LIVE. While `infra/router/wrangler.jsonc` still committed
 * `CONTROL_PLANE_URL` as a plaintext `vars` entry, the account's live script
 * carried it that way too. `deploy-router.yml` ran the secret push BEFORE
 * `wrangler deploy`, so every run collided with that stale var — Cloudflare
 * 10053, "Binding name 'CONVEX_ORIGIN' already in use" — forever, because the
 * one step that would have retired the var (`wrangler deploy`) never got to
 * run. Deploying first retires the var immediately; the secret push then acts
 * on a script that no longer declares it. `deploy-router.yml` and
 * `deploy-email-worker.yml` were fixed to deploy-then-secrets; `deploy-mcp.yml`
 * and `deploy-transcribe-worker.yml` carried the same secrets-then-deploy
 * shape and had simply not hit a colliding var yet — nothing here proves they
 * never will.
 *
 * ── WHAT THIS CHECKER ENFORCES ───────────────────────────────────────────────
 *
 * Within each workflow file, comments stripped, the first `wrangler secret
 * put` must not appear before the first `wrangler deploy` (or `wrangler
 * versions upload`, the other command that publishes a new live version) —
 * when a file has neither, or only one of the two, there is nothing to order
 * and it passes. This is a textual, whole-file ordering check rather than a
 * per-job/per-step parse: every deploy workflow in this repository puts both
 * commands in the same job, in the sequence they run, so line order in the
 * file already reflects execution order. A workflow that split them across
 * parallel jobs would defeat this — nothing here does.
 *
 * Comments are stripped first because every deploy workflow's header narrates
 * this exact bug in prose, mentioning both commands — a checker that read
 * comments as code would flag its own explanation. That is not the only place
 * these words appear outside a real invocation: several deploy workflows'
 * Cloudflare-preflight steps print a diagnostic string containing "wrangler
 * deploy" (not a YAML comment, so stripping comments alone does not remove
 * it), which is why both patterns below require the `pnpm exec` prefix every
 * real invocation in this repository actually uses.
 *
 * Run: `node scripts/check-workflow-secret-order.mjs`
 * Self-test: `node scripts/check-workflow-secret-order.mjs --self-test`
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

// Anchored on `pnpm exec wrangler …` rather than a bare `wrangler …` anywhere
// in the line. Every real invocation in this repository goes through `pnpm
// exec`, and several deploy workflows carry a Cloudflare-preflight step whose
// diagnostic text — `console.error("... wrangler deploy below needs ...")` —
// says "wrangler deploy" in an ordinary string, well before the real deploy
// step. A bare match found THAT line first in deploy-mcp.yml (index 194
// against the real deploy at 229): this ordering check kept passing, but for
// the wrong reason — it was comparing the real secret push against a false
// "deploy" that happened to sit early, not against the command that actually
// runs. `pnpm exec` never appears inside that prose.
//
// ── AND `--dir` IS PART OF THE ANCHOR, BECAUSE IT WAS NOT ───────────────────
//
// `pnpm exec wrangler …` was the only form when this was written. The other
// form this repository uses is `pnpm --dir <path> exec wrangler …`, and
// requiring `pnpm` and `exec` to be adjacent matched none of it. Measured
// rather than argued: of the seven deploy workflows, five carried invocations
// this checker could not see, and `deploy-staging.yml` — which deploys every
// staging component — carried **nine** secret pushes and **two** deploys and
// matched *none* of them. It had been passing that file by reading nothing in
// it.
//
// `--dir` is spelled out rather than allowing any flags, so the anchor stays
// what it was written to be: a shape that appears in real invocations and
// never in the prose about them.
const PNPM_EXEC = String.raw`\bpnpm\s+(?:--dir\s+\S+\s+)?exec\s+wrangler\s+`;
/** Any of the three commands, however invoked — the coverage floor's half. */
const LOOSE_COMMAND = /wrangler\s+(?:secret\s+put|(?:pages\s+)?deploy|versions\s+upload)\b/;
const SECRET_PUT = new RegExp(`${PNPM_EXEC}secret\\s+put\\b`);
const DEPLOYS_LIVE = new RegExp(
  `${PNPM_EXEC}(?:pages\\s+)?deploy\\b|${PNPM_EXEC}versions\\s+upload\\b`,
);

function stripComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n");
}

/**
 * Each top-level block, as its lines and the file offset of its first line.
 *
 * ── WHY THE CHECK IS PER BLOCK, NOT PER FILE ────────────────────────────────
 *
 * This was a whole-file ordering check, and its own header said why that was
 * enough: *"every deploy workflow in this repository puts both commands in the
 * same job, in the sequence they run, so line order in the file already
 * reflects execution order. A workflow that split them across parallel jobs
 * would defeat this — nothing here does."*
 *
 * `deploy-staging.yml` then did. #1081 gave it a `router` job that pushes
 * `CONVEX_ORIGIN` and then deploys — the forbidden order, inside one job —
 * while the file's *first* deploy sits in the earlier `workers` job and its
 * first secret push a few lines below it. The whole-file comparison therefore
 * answered "deploy comes first" about two different jobs and passed.
 *
 * Per block is also the only rule that means anything once a workflow has more
 * than one deploying job: jobs run in parallel unless `needs:` orders them, so
 * the *file* order of two different jobs' commands says nothing at all about
 * which ran first. What is left unchecked is stated rather than papered over:
 * a secret pushed in one job against a deploy in another is ordered by
 * `needs:`, and nothing here reads that graph.
 *
 * A two-space key is a block start (`jobs:`'s children, and `on:`'s). Splitting
 * on those cannot hide a violation: a job's own steps are indented deeper, so
 * no split ever falls between a step and its neighbour.
 */
function topLevelBlocks(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) starts.push(i);
  }
  if (starts.length === 0) return [{ from: 0, lines }];
  return starts.map((from, index) => ({
    from,
    lines: lines.slice(from, starts[index + 1] ?? lines.length),
  }));
}

/**
 * @param {string} text a workflow file's full source
 * @returns {{secretPutLine: number, deployLine: number} | null} the two lines
 *   in violation, or null when no job has an ordering problem (including when
 *   a job has fewer than two of the relevant commands).
 */
export function findOutOfOrderSecretPut(text) {
  const lines = stripComments(text).split("\n");
  for (const block of topLevelBlocks(lines)) {
    let firstSecretPut = -1;
    let firstDeploy = -1;
    for (let i = 0; i < block.lines.length; i++) {
      if (firstSecretPut === -1 && SECRET_PUT.test(block.lines[i])) firstSecretPut = i;
      if (firstDeploy === -1 && DEPLOYS_LIVE.test(block.lines[i])) firstDeploy = i;
    }
    if (firstSecretPut === -1 || firstDeploy === -1) continue;
    if (firstSecretPut < firstDeploy) {
      return {
        secretPutLine: block.from + firstSecretPut + 1,
        deployLine: block.from + firstDeploy + 1,
      };
    }
  }
  return null;
}

function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

function main() {
  const files = readWorkflows(WORKFLOWS_DIR);

  // A floor, same reason every sibling checker has one: a wrong directory or
  // an empty checkout must not read as "nothing to report".
  if (files.length < 5) {
    console.error(`Only ${files.length} workflow files found in ${WORKFLOWS_DIR} — wrong root, or nothing checked out.`);
    process.exit(1);
  }

  /*
    A second floor, and the one that would have caught this checker going
    blind: every wrangler publish or secret command invoked through pnpm must
    be one the ordering patterns recognise. The file count above only proves
    there are workflows to read, and this checker spent its life reporting OK
    over `deploy-staging.yml`'s nine secret pushes because its anchor did not
    match the `pnpm --dir … exec` form all of them use. A checker whose
    patterns match nothing passes every repository it is pointed at — the
    failure `check-secrets-allowlist.mjs` and its siblings each carry a
    `--self-test` for, arriving here as a silent pass instead.

    Relative rather than a count, so it cannot drift with the repository's
    size: it compares what the anchors match against every line that both names
    one of these commands and runs `pnpm`. `pnpm` is what keeps the prose out —
    the Cloudflare-preflight diagnostics that say "wrangler deploy" in an
    ordinary string never say `pnpm`, which is the same property the anchors
    themselves rely on. All 27 such lines match today.
  */
  const unrecognised = [];
  for (const { name, text } of files) {
    stripComments(text)
      .split("\n")
      .forEach((line, index) => {
        if (!LOOSE_COMMAND.test(line) || !/\bpnpm\b/.test(line)) return;
        if (SECRET_PUT.test(line) || DEPLOYS_LIVE.test(line)) return;
        unrecognised.push(`${name}:${index + 1}: ${line.trim()}`);
      });
  }
  if (unrecognised.length > 0) {
    console.error(
      "These lines invoke wrangler through pnpm and the ordering patterns do not match them,\n" +
        "so this checker is not reading them at all:\n",
    );
    for (const line of unrecognised) console.error(`  - ${line}\n`);
    process.exit(1);
  }

  const problems = [];
  for (const { name, text } of files) {
    const hit = findOutOfOrderSecretPut(text);
    if (hit) {
      problems.push(
        `${name}: \`wrangler secret put\` at line ${hit.secretPutLine} runs before \`wrangler deploy\`/` +
          `\`wrangler versions upload\` at line ${hit.deployLine}. If the config ever declares that secret's ` +
          `name as a plaintext \`vars\` entry, the live script still carries it until the deploy step retires ` +
          `it — pushing the secret first collides with the stale var on every run (Cloudflare 10053). ` +
          `Move the secret push after the deploy step.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("Deploy workflows push secrets before deploying:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`OK — ${files.length} workflow file(s) checked, none push a wrangler secret before deploying.`);
}

/** The checker, checked — samples it must flag, and samples it must not. */
function selfTest() {
  const failures = [];
  // Counted rather than written down: the total used to be a literal, so it
  // said "10 checks" however many there were, and deleting nine of them would
  // have printed the same reassuring line.
  let checked = 0;
  const expect = (label, condition) => {
    checked += 1;
    if (!condition) failures.push(label);
  };

  const good = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler deploy",
    "      - run: |",
    "          printf '%s' \"$X\" | pnpm exec wrangler secret put X",
  ].join("\n");
  expect("deploy before secret put is not flagged", findOutOfOrderSecretPut(good) === null);

  const bad = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: |",
    "          printf '%s' \"$X\" | pnpm exec wrangler secret put X",
    "      - run: pnpm exec wrangler deploy",
  ].join("\n");
  const hit = findOutOfOrderSecretPut(bad);
  expect("secret put before deploy is flagged", hit !== null);
  expect("the reported secret-put line is line 5", hit?.secretPutLine === 5);
  expect("the reported deploy line is line 6", hit?.deployLine === 6);

  // The actual #302 regression fixture: prose in the header narrates both
  // commands, in the wrong order, well before either real step. A checker
  // reading comments as code would flag this file for its own explanation.
  const narratedButFixed = [
    "# AFTER deploy, not before: wrangler secret put collided with a stale var",
    "# when it ran ahead of wrangler deploy. See #302.",
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler deploy",
    "      - run: pnpm exec wrangler secret put X",
  ].join("\n");
  expect("prose narrating the bug is not itself flagged", findOutOfOrderSecretPut(narratedButFixed) === null);

  // A file with only one of the two commands has nothing to order.
  const deployOnly = "jobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler deploy\n";
  expect("a file with no secret put is not flagged", findOutOfOrderSecretPut(deployOnly) === null);

  /*
    THE TWO SHAPES THAT WERE INVISIBLE, ASSERTED AS THEMSELVES.

    `--dir`: the form `deploy-staging.yml` uses throughout and the reason this
    checker read nothing in it. Both directions, so an anchor that matched
    everything would fail the second.
  */
  const dirBad = [
    "jobs:",
    "  router:",
    "    steps:",
    '      - run: printf \'%s\' "$X" | pnpm --dir infra/router exec wrangler secret put X --env staging',
    "      - run: pnpm --dir infra/router exec wrangler deploy --env staging",
  ].join("\n");
  const dirHit = findOutOfOrderSecretPut(dirBad);
  expect("the `pnpm --dir … exec` form is seen at all", dirHit !== null);
  expect("…and reported at its own lines", dirHit?.secretPutLine === 4 && dirHit?.deployLine === 5);
  const dirGood = [
    "jobs:",
    "  router:",
    "    steps:",
    "      - run: pnpm --dir infra/router exec wrangler deploy --env staging",
    '      - run: printf \'%s\' "$X" | pnpm --dir infra/router exec wrangler secret put X --env staging',
  ].join("\n");
  expect("…and deploy-then-secret in that form is not flagged", findOutOfOrderSecretPut(dirGood) === null);

  /*
    Per job: the violation sits in the second job, while the first job's deploy
    is earlier in the file. That is exactly `deploy-staging.yml` after #1081,
    and it is what the whole-file comparison answered "fine" to.
  */
  const twoJobs = [
    "jobs:",
    "  workers:",
    "    steps:",
    '      - run: pnpm --dir "$D" exec wrangler deploy --env staging',
    '      - run: printf \'%s\' "$X" | pnpm --dir "$D" exec wrangler secret put X --env staging',
    "  router:",
    "    steps:",
    "      - run: pnpm --dir infra/router exec wrangler secret put Y --env staging",
    "      - run: pnpm --dir infra/router exec wrangler deploy --env staging",
  ].join("\n");
  const jobHit = findOutOfOrderSecretPut(twoJobs);
  expect("a second job's bad order is flagged despite an earlier job's deploy", jobHit !== null);
  expect("…at the offending job's own lines", jobHit?.secretPutLine === 8 && jobHit?.deployLine === 9);
  const secretOnly = "jobs:\n  d:\n    steps:\n      - run: pnpm exec wrangler secret put X\n";
  expect("a file with no deploy command is not flagged", findOutOfOrderSecretPut(secretOnly) === null);

  // `wrangler versions upload` is the other command that publishes a live
  // version and must be ordered the same way.
  const versionsUpload = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler secret put X",
    "      - run: pnpm exec wrangler versions upload",
  ].join("\n");
  expect("wrangler versions upload is ordered the same as deploy", findOutOfOrderSecretPut(versionsUpload) !== null);

  // Multiple secret puts, all after deploy, is the common real shape
  // (deploy-mcp.yml pushes four secrets in one step) and must pass clean.
  const multipleSecretsAfter = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: pnpm exec wrangler deploy",
    "      - run: |",
    "          printf a | pnpm exec wrangler secret put A",
    "          printf b | pnpm exec wrangler secret put B",
  ].join("\n");
  expect("multiple secret puts after deploy are not flagged", findOutOfOrderSecretPut(multipleSecretsAfter) === null);

  // The actual live shape this anchor was tightened for: every deploy
  // workflow's Cloudflare-preflight step prints diagnostic TEXT that mentions
  // "wrangler deploy" in an ordinary string, well before the real deploy
  // step — `console.error("... wrangler deploy below needs ...")`. A bare
  // `\bwrangler\s+deploy\b` match found that line FIRST in deploy-mcp.yml
  // (index 194 vs. the real deploy at 229) and this checker kept reporting
  // clean, but for the wrong reason: it was comparing the real secret push
  // against a false "deploy" that happened to sit early, not the command
  // that actually runs. If a real secret push ever landed between that
  // diagnostic text and the real deploy step, this bare match would have
  // missed it entirely.
  const preflightTextBeforeRealDeploy = [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - run: |",
    '          node -e \'console.error("wrangler deploy below needs Workers Scripts: Edit")\'',
    "      - run: |",
    "          printf '%s' \"$X\" | pnpm exec wrangler secret put X",
    "      - run: pnpm exec wrangler deploy",
  ].join("\n");
  const preflightHit = findOutOfOrderSecretPut(preflightTextBeforeRealDeploy);
  expect(
    "diagnostic text mentioning 'wrangler deploy' does not stand in for the real deploy step",
    preflightHit !== null && preflightHit.deployLine === 8,
  );

  // The live repository, post-fix, must have nothing left to report.
  const live = readWorkflows(WORKFLOWS_DIR);
  const liveHits = live
    .map(({ name, text }) => ({ name, hit: findOutOfOrderSecretPut(text) }))
    .filter(({ hit }) => hit !== null)
    .map(({ name, hit }) => `${name}:${hit.secretPutLine}`);
  expect(`the live workflow files have no out-of-order secret puts (found: ${liveHits.join(", ") || "none"})`, liveHits.length === 0);

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${checked} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
