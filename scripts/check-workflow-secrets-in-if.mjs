#!/usr/bin/env node
/**
 * No `if:` condition (job- or step-level) may reference the `secrets` context.
 *
 * ── WHAT WENT WRONG, discovered 2026-09-07 ──────────────────────────────────
 *
 * `deploy-router.yml` gained a step:
 *
 *   - name: Set CONVEX_ORIGIN secret (Convex HTTP-actions origin)
 *     if: ${{ secrets.CONTROL_PLANE_URL != '' }}
 *     ...
 *
 * GitHub's own context-availability table
 * (https://docs.github.com/actions/learn-github-actions/contexts#context-availability)
 * does not list `jobs.<job_id>.if` or `jobs.<job_id>.steps.if` among the places
 * the `secrets` context may appear — only `env`, `with`, and a job's
 * `container`/`services`/`environment` can read it. Every trigger of that
 * workflow — push included — therefore failed to parse AT ALL:
 *
 *   Invalid Argument - failed to parse workflow: (Line: 162, Col: 13):
 *   Unrecognized named-value: 'secrets'. Located at position 1 within
 *   expression: secrets.CONTROL_PLANE_URL != ''
 *
 * A workflow that fails to parse runs ZERO jobs — not a failing job, none —
 * so every push to `main` touching `infra/router/**` since that step was
 * added deployed nothing, while the run showed as a single opaque failure
 * with no job to open and no log to read. It was found only by chance, while
 * chasing an unrelated Cloudflare permission failure that made someone
 * actually look at this workflow's runs.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 *
 * Move the check into the shell body instead: read the secret through `env:`
 * (which IS a valid place for `secrets` per the same table) and branch on it
 * with `if [ -z "$THE_VAR" ]; then ...; exit 0; fi` inside `run:`.
 *
 * ── WHAT THIS CHECKER ENFORCES ──────────────────────────────────────────────
 *
 * No `if:` line anywhere in a workflow may reference `secrets.` or
 * `secrets[`. It does not matter whether the condition is on a job or a step
 * — neither is a valid place for that context, and GitHub fails the entire
 * workflow's parse either way, on every trigger.
 *
 * Run: `node scripts/check-workflow-secrets-in-if.mjs`
 * Self-test (with sabotage): `node scripts/check-workflow-secrets-in-if.mjs --self-test`
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

/**
 * Matches an `if:` key (job- or step-level, any indent) whose value reads
 * `secrets`. The optional `-\s*` handles a step written as a YAML list item
 * (`- if: ...` on the same line as the dash, the common style in this repo).
 */
const SECRETS_IN_IF = /^\s*-?\s*if\s*:.*\bsecrets(?:\.|\[)/;

/**
 * @param {string} text a workflow file's full source
 * @returns {{line: number, snippet: string}[]} every offending `if:` line found
 */
export function findSecretsInIf(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (SECRETS_IN_IF.test(lines[i])) {
      hits.push({ line: i + 1, snippet: lines[i].trim() });
    }
  }
  return hits;
}

function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

function main() {
  const problems = [];
  for (const { name, text } of readWorkflows(WORKFLOWS_DIR)) {
    for (const { line, snippet } of findSecretsInIf(text)) {
      problems.push(
        `${name}:${line} reads the \`secrets\` context inside an \`if:\`:\n` +
          `    ${snippet}\n` +
          `    GitHub's context-availability table does not list jobs.<job_id>.if or\n` +
          `    jobs.<job_id>.steps.if for the secrets context. A workflow using it there\n` +
          `    fails to PARSE — every trigger runs zero jobs, push included — with\n` +
          `    "Unrecognized named-value: 'secrets'". Move the check into the shell\n` +
          `    body instead: read the secret through env: and branch on it with\n` +
          `    \`if [ -z "$THE_VAR" ]; then ...; exit 0; fi\` inside run:.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("A workflow `if:` reads the secrets context, which fails to parse:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log("OK — no workflow `if:` reads the secrets context.");
}

/**
 * Prove the checker catches the shape it claims to, by sabotaging a
 * known-good fixture back into the broken one. A self-test that only proves
 * the good corpus passes is a self-test a `return []` also passes.
 */
function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  const fixed = `
      - name: Set CONVEX_ORIGIN secret
        working-directory: infra/router
        env:
          CONTROL_PLANE_URL: \${{ secrets.CONTROL_PLANE_URL }}
        run: |
          if [ -z "\${CONTROL_PLANE_URL:-}" ]; then
            exit 0
          fi
          printf '%s' "$CONTROL_PLANE_URL" | pnpm exec wrangler secret put CONVEX_ORIGIN
`;
  expect("the fixed shape (secrets only in env:) is not flagged", findSecretsInIf(fixed).length === 0);

  // The sabotage: reintroduce the exact broken step-level `if:`, byte-for-byte
  // what deploy-router.yml carried before this checker existed.
  const sabotaged = `
      - name: Set CONVEX_ORIGIN secret
        if: \${{ secrets.CONTROL_PLANE_URL != '' }}
        working-directory: infra/router
        env:
          CONTROL_PLANE_URL: \${{ secrets.CONTROL_PLANE_URL }}
        run: printf '%s' "$CONTROL_PLANE_URL" | pnpm exec wrangler secret put CONVEX_ORIGIN
`;
  const hits = findSecretsInIf(sabotaged);
  expect("the sabotaged step-level if is flagged", hits.length === 1);
  expect("the reported line is the if: line", hits[0]?.snippet.startsWith("if:"));

  // A job-level `if:` reading secrets is exactly as invalid, and must be
  // caught the same way — this rule is not scoped to steps.
  const jobLevel = `
jobs:
  deploy:
    if: \${{ secrets.SOME_FLAG == 'true' }}
    runs-on: ubuntu-latest
`;
  expect("a job-level if reading secrets is caught too", findSecretsInIf(jobLevel).length === 1);

  // Bracket access (`secrets['X']`) must not be a loophole.
  const bracket = `      - if: \${{ secrets['CONTROL_PLANE_URL'] != '' }}\n`;
  expect("bracket-style secrets access is caught too", findSecretsInIf(bracket).length === 1);

  // `secrets` in env: or with: — valid per the context-availability table —
  // must never be flagged; this rule is about `if:` specifically.
  const envOnly = `      - env:\n          FOO: \${{ secrets.FOO }}\n        with:\n          bar: \${{ secrets.BAR }}\n`;
  expect("secrets in env: or with: is not flagged", findSecretsInIf(envOnly).length === 0);

  // `if:` conditions that reference something else entirely must stay clean.
  const unrelatedIf = `      - if: \${{ github.event_name == 'push' }}\n`;
  expect("an unrelated if: condition is not flagged", findSecretsInIf(unrelatedIf).length === 0);

  // The live repository, post-fix, must have nothing left to report.
  const live = readWorkflows(WORKFLOWS_DIR);
  const liveHits = live.flatMap(({ name, text }) =>
    findSecretsInIf(text).map((h) => `${name}:${h.line}`),
  );
  expect(`the live workflow files have no secrets-in-if (found: ${liveHits.join(", ") || "none"})`, liveHits.length === 0);

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${7} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
