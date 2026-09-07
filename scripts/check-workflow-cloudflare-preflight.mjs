#!/usr/bin/env node
/**
 * No deploy workflow's Cloudflare preflight may call bare `GET /accounts/{id}`.
 *
 * ── WHAT WENT WRONG, 2026-09-07 ─────────────────────────────────────────────
 *
 * All four deploy workflows (`deploy-router.yml`, `deploy-email-worker.yml`,
 * `deploy-mcp.yml`, `deploy-transcribe-worker.yml`) carried an identical
 * "Verify Cloudflare credentials (preflight)" step whose only purpose is to
 * fail fast, with a readable message, before `wrangler deploy`'s opaque
 * `Could not route ... [code: 7003]`. It did that by calling:
 *
 *   GET https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID
 *
 * That bare form needs the **`Account Settings: Read`** permission — a
 * permission none of the four deploys otherwise uses for anything. Between
 * 07:15 and 08:08 UTC that day, while the token's permission set was being
 * edited in the Cloudflare dashboard, it lost exactly that scope. Every other
 * scope the deploys actually need (`Workers Scripts: Edit`, `Zone: Read`,
 * `Email Routing Rules: Read`, `Workers AI`, …) was untouched, so `wrangler
 * deploy` itself would have worked — but the preflight died first, on Cloudflare
 * error 9109 ("Unauthorized to access requested resource"), for a permission
 * the deploy never needed to spend in the first place. Re-running "Sync
 * Secrets" cannot fix a permission gap: the token's *value* was never wrong,
 * only what it is scoped to do.
 *
 * `deploy-router.yml` and `deploy-email-worker.yml` failed first because they
 * were the two whose paths touched that day. `deploy-mcp.yml` and
 * `deploy-transcribe-worker.yml` carried the byte-identical step and were
 * equally broken; they simply had not been triggered yet.
 *
 * ── THE FIX, AND WHY IT IS SAFE TO GENERALIZE ───────────────────────────────
 *
 * Every one of these four deploys calls `wrangler deploy`, which needs
 * `Workers Scripts: Edit` no matter what. Reading the account's scripts list
 * — `GET /accounts/{id}/workers/scripts` — needs only `Workers Scripts: Read`,
 * a strict subset of a permission already required, and it proves the exact
 * same fact the bare call did: this token can act on this account id.
 * `deploy-email-worker.yml` already called this endpoint later in the same
 * job ("Verify the Worker exists and was just modified"), so the preflight
 * moving to it is not a new dependency, only an earlier check of one that
 * already existed.
 *
 * ── WHAT THIS CHECKER ENFORCES ──────────────────────────────────────────────
 *
 * No workflow may call the bare account endpoint
 * (`/accounts/{id}` with nothing after the id) at all. It does not matter
 * whether the call is in a step named "preflight" — the bare shape is the
 * problem, full stop, because it spends a permission none of these deploys
 * otherwise need. `/accounts/{id}/workers/scripts`, `/accounts/{id}/tokens/…`,
 * and every other longer path are unaffected; only the id-and-nothing-else
 * form is refused.
 *
 * Run: `node scripts/check-workflow-cloudflare-preflight.mjs`
 * Self-test (with sabotage): `node scripts/check-workflow-cloudflare-preflight.mjs --self-test`
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS_DIR = join(ROOT, ".github/workflows");

/**
 * Matches `GET https://api.cloudflare.com/client/v4/accounts/{id}` where
 * `{id}` is the LAST path segment — an optional trailing slash before the
 * closing quote is allowed, but any further segment (`/workers/scripts`,
 * `/tokens/verify`, …) is not matched. `{id}` itself is not pinned to
 * `$CLOUDFLARE_ACCOUNT_ID` specifically: a hardcoded id, a differently named
 * variable, or `${{ secrets.CLOUDFLARE_ACCOUNT_ID }}` interpolated straight
 * into the URL should all be caught the same way.
 */
const BARE_ACCOUNT_ENDPOINT =
  /https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/\s"']+\/?["'\s)]/;

/**
 * @param {string} text a workflow file's full source
 * @returns {{line: number, snippet: string}[]} every bare-account-endpoint call found
 */
export function findBareAccountCalls(text) {
  const hits = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (BARE_ACCOUNT_ENDPOINT.test(lines[i])) {
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
    for (const { line, snippet } of findBareAccountCalls(text)) {
      problems.push(
        `${name}:${line} calls the bare account endpoint:\n` +
          `    ${snippet}\n` +
          `    That needs "Account Settings: Read", a permission this repository's\n` +
          `    deploy tokens have no other reason to hold. Call\n` +
          `    GET /accounts/{id}/workers/scripts instead — every deploy workflow\n` +
          `    already needs "Workers Scripts: Edit", of which "Workers Scripts: Read"\n` +
          `    is a strict subset, and it proves the same fact: this token can act on\n` +
          `    this account id.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("Cloudflare preflight calls the bare account endpoint:\n");
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log("OK — no workflow calls the bare GET /accounts/{id} endpoint.");
}

/**
 * Prove the checker actually catches the shape it claims to, by sabotaging a
 * known-good fixture back into the broken one and confirming the rule fires.
 * A self-test that only proves the good corpus passes is a self-test a
 * `return []` also passes — see check-workflow-triggers.mjs's header.
 */
function selfTest() {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  const fixed = `
      - name: Verify Cloudflare credentials (preflight)
        run: |
          resp="$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\
            "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts")"
`;
  expect("the fixed shape (workers/scripts) is not flagged", findBareAccountCalls(fixed).length === 0);

  // The sabotage: revert the one line that matters back to the broken shape,
  // byte-for-byte what all four workflows carried before 2026-09-07.
  const sabotaged = fixed.replace(
    "/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts",
    "/accounts/$CLOUDFLARE_ACCOUNT_ID",
  );
  const hits = findBareAccountCalls(sabotaged);
  expect("the sabotaged (bare) shape is flagged", hits.length === 1);
  expect("the reported line matches the sabotaged url", hits[0]?.snippet.includes("accounts/$CLOUDFLARE_ACCOUNT_ID\""));

  // A trailing slash before the closing quote must not be a loophole.
  const trailingSlash = `run: |\n  curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/"\n`;
  expect("a trailing slash still counts as bare", findBareAccountCalls(trailingSlash).length === 1);

  // A hardcoded id, or a differently named variable, must be caught too — the
  // rule is about the URL SHAPE, not about which token names it.
  const hardcoded = `run: |\n  curl "https://api.cloudflare.com/client/v4/accounts/abc123"\n`;
  expect("a hardcoded account id is caught", findBareAccountCalls(hardcoded).length === 1);
  const otherVar = `run: |\n  curl "https://api.cloudflare.com/client/v4/accounts/\${MY_ACCOUNT}"\n`;
  expect("a differently named variable is caught", findBareAccountCalls(otherVar).length === 1);

  // Other accounts/{id}/... endpoints this repository legitimately calls (or
  // could) must never be flagged — this checker refuses one specific shape,
  // not the whole endpoint family.
  const scripts = `run: |\n  curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/name/secrets"\n`;
  expect("a deeper accounts/{id}/... path is not flagged", findBareAccountCalls(scripts).length === 0);
  const tokensVerify = `run: |\n  curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens/verify"\n`;
  expect("tokens/verify is not flagged", findBareAccountCalls(tokensVerify).length === 0);

  // The live repository, post-fix, must have nothing left to report — this is
  // the assertion that actually gates CI, run against the real files rather
  // than fixtures.
  const live = readWorkflows(WORKFLOWS_DIR);
  const liveHits = live.flatMap(({ name, text }) =>
    findBareAccountCalls(text).map((h) => `${name}:${h.line}`),
  );
  expect(`the live workflow files have no bare calls (found: ${liveHits.join(", ") || "none"})`, liveHits.length === 0);

  if (failures.length > 0) {
    console.error("Self-test failed:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`Self-test passed (${8} checks).`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
