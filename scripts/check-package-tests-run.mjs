#!/usr/bin/env node
/**
 * Every workspace package that has a test suite is run by a pull request.
 *
 * ── WHAT WENT WRONG, FIVE TIMES ───────────────────────────────────────────
 *
 * `ci.yml` delegates to the framework's reusable pipeline, which filters on
 * `apps/mobile`, `apps/convex` and `packages/shared`. Nothing else under
 * `apps/`, `packages/` or `infra/` is covered by it. So a package could have a
 * green suite on a developer's machine and no CI job anywhere, and the only
 * way anybody found out was by noticing.
 *
 * Five packages were found that way, one at a time, and `mcp.yml` still
 * carries the evidence in its own comments — one per job, each opening with
 * some version of "NO CI JOB RAN THIS PACKAGE'S SUITE EITHER":
 * `packages/encryption-decryptor`, `packages/meetings`,
 * `packages/communications`, `packages/drawings`, `apps/desktop`. Two more,
 * `infra/sentry-worker` and `infra/egress-service`, were found the same way
 * and closed the same way.
 *
 * Seven discoveries of one defect, seven individual fixes, and nothing that
 * would catch the eighth. The list of covered packages lived in the workflows
 * and no check was made on the list. This is that check.
 *
 * ── WHAT IT ASSERTS ───────────────────────────────────────────────────────
 *
 * For every package under `apps/`, `packages/` or `infra/` that declares a
 * `test` script, some workflow that accepts `pull_request` must show evidence
 * of RUNNING it — not of mentioning it. A path in a `paths:` filter, in a
 * concurrency group or in a comment is a mention; what counts is:
 *
 *   - `working-directory:` set to the package, or
 *   - a `run:` command naming the package's path, or
 *   - a pnpm `--filter` naming the package or its directory.
 *
 * The distinction is the whole point. `apps/convex` appears in several
 * workflows' `paths:` filters and is actually executed by exactly one job; a
 * mention-shaped check would have reported it covered for the wrong reason,
 * and would have gone on doing so after that job was deleted.
 *
 * ── WHY IT PARSES THE `on:` BLOCK ─────────────────────────────────────────
 *
 * `grep -l pull_request .github/workflows/*.yml` matches every deploy
 * workflow, because each explains in prose why it deliberately has none. A
 * grep-shaped guard reads those comments as configuration and reports the
 * opposite of the truth — `check-workflow-triggers.mjs` documents the same
 * trap and solves it the same way.
 *
 * ── AND THERE IS NO EXEMPTION LIST, DELIBERATELY ──────────────────────────
 *
 * Every package but one passed the day this was written, so an allowance
 * would have had nothing legitimate in it and would only ever be the place
 * the next gap hides — which is the defect this file exists for, wearing a
 * different hat. A package that genuinely cannot run in CI is a decision to
 * argue in `docs/decisions/testing.md`, not a line to add here.
 *
 * Run `node scripts/check-package-tests-run.mjs --self-test` to prove the
 * rule catches what it claims.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_DIRS = ["apps", "packages", "infra", "plugins"];

/**
 * A YAML-ish comment strip.
 *
 * Whole-line comments go, and so does a trailing ` #…`. A `#` with no space
 * before it is left alone, because it occurs inside values here (anchors,
 * colours, fragments) and dropping it would corrupt the line rather than
 * clean it.
 */
export function stripComments(text) {
  return text
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line.replace(/\s#.*$/, "")))
    .join("\n");
}

/** Whether a workflow's `on:` block has a `pull_request` trigger. */
export function acceptsPullRequest(text) {
  const match = /^on:\s*$([\s\S]*?)^\S/m.exec(`${text}\n\u0000`);
  const block = match ? match[1] : "";
  return /^\s{2}pull_request:/m.test(block);
}

/**
 * Which of `workflows` shows evidence of running `pkg`, and how.
 *
 * Exported and pure so the self-test drives the same function the real run
 * does. A guard whose rules are only reachable through the filesystem is one
 * whose rules are only ever checked against the filesystem's current state.
 */
export function evidenceOfExecution(pkg, workflows) {
  const path = pkg.path.replace(/\\/g, "/");
  const found = [];
  for (const workflow of workflows) {
    if (!workflow.acceptsPullRequest) continue;
    const text = workflow.text;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = pkg.name ? pkg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
    // `- ` because both spellings are valid YAML: a plain key under a step,
    // and the first key of the step itself. The self-test caught this file
    // matching only the first before it had run against the repository once.
    if (new RegExp(`^\\s*(- )?working-directory:\\s*${escaped}\\s*$`, "m").test(text)) {
      found.push({ workflow: workflow.name, how: "working-directory" });
    } else if (new RegExp(`^\\s*(- )?run:.*${escaped}`, "m").test(text)) {
      found.push({ workflow: workflow.name, how: "run" });
    } else if (name && new RegExp(`--filter\\s+["']?(\\./)?(${name}|${escaped})`).test(text)) {
      found.push({ workflow: workflow.name, how: "filter" });
    }
  }
  return found;
}

/** Every package with a `test` script, and every workflow, read from disk. */
function readRepository(root) {
  const packages = [];
  for (const area of WORKSPACE_DIRS) {
    const areaPath = join(root, area);
    if (!existsSync(areaPath)) continue;
    for (const entry of readdirSync(areaPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(areaPath, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        throw new Error(`${area}/${entry.name}/package.json does not parse`);
      }
      const test = parsed?.scripts?.test;
      if (typeof test !== "string" || test.trim() === "") continue;
      packages.push({ path: `${area}/${entry.name}`, name: parsed.name ?? null });
    }
  }
  const workflows = [];
  const dir = join(root, ".github", "workflows");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const text = stripComments(readFileSync(join(dir, file), "utf8"));
    workflows.push({ name: file, text, acceptsPullRequest: acceptsPullRequest(text) });
  }
  return { packages, workflows };
}

/** The packages nothing runs on a pull request. */
export function uncovered(packages, workflows) {
  return packages.filter((pkg) => evidenceOfExecution(pkg, workflows).length === 0);
}

function selfTest() {
  const workflow = (name, on, body) => ({
    name,
    text: stripComments(`${on}\n${body}`),
    acceptsPullRequest: acceptsPullRequest(stripComments(`${on}\n${body}`)),
  });
  const PR = "on:\n  pull_request:\n  push:\n    branches: [main]\njobs:";
  const PUSH_ONLY = "on:\n  push:\n    branches: [main]\njobs:";
  const pkg = { path: "packages/thing", name: "@context/thing" };

  const cases = [
    [
      "a working-directory at the package counts",
      [workflow("a.yml", PR, "      - working-directory: packages/thing\n        run: node test/test.mjs")],
      true,
    ],
    [
      "a run command naming the path counts",
      [workflow("a.yml", PR, "      - run: node packages/thing/test/test.mjs")],
      true,
    ],
    [
      "a pnpm filter naming the package counts",
      [workflow("a.yml", PR, "      - run: pnpm --filter @context/thing test")],
      true,
    ],
    [
      // The rule this file exists for. A paths: filter is the most common way
      // a package is named by a workflow that never runs it.
      "a paths: filter is a mention and does not count",
      [workflow("a.yml", "on:\n  pull_request:\n    paths:\n      - packages/thing/**\njobs:", "      - run: echo hi")],
      false,
    ],
    [
      // And the reason the `on:` block is parsed rather than grepped.
      "a push-only workflow that runs it does not count",
      [workflow("a.yml", PUSH_ONLY, "      - working-directory: packages/thing\n        run: node test/test.mjs")],
      false,
    ],
    [
      "a comment naming the package does not count",
      [workflow("a.yml", PR, "      # working-directory: packages/thing\n      - run: echo hi")],
      false,
    ],
    [
      "no workflows at all is not coverage",
      [],
      false,
    ],
  ];

  for (const [label, workflows, expected] of cases) {
    const got = evidenceOfExecution(pkg, workflows).length > 0;
    if (got !== expected) {
      throw new Error(`self-test: ${label} — expected ${expected}, got ${got}`);
    }
  }

  // A guard that reports nothing because it found nothing to check is the
  // failure this repository keeps meeting. Prove the reporting path fires.
  const missed = uncovered([pkg], [workflow("a.yml", PR, "      - run: echo hi")]);
  if (missed.length !== 1) throw new Error("self-test: an uncovered package must be reported");

  console.log(`ok   self-test passed (${cases.length + 1} cases)`);
}

function main() {
  if (process.argv.slice(2).includes("--self-test")) {
    selfTest();
    return;
  }
  const { packages, workflows } = readRepository(ROOT);
  if (packages.length === 0) {
    console.error("FAIL — no package with a test script was found, which cannot be right.");
    process.exit(1);
  }
  const missing = uncovered(packages, workflows);
  if (missing.length > 0) {
    console.error(
      `FAIL — ${missing.length} package(s) with a test suite are not run by any workflow that accepts pull requests:\n` +
        missing.map((pkg) => `  ${pkg.path} (${pkg.name ?? "unnamed"})`).join("\n") +
        "\n\nAdd a job that runs the suite to a workflow with a `pull_request` trigger.\n" +
        "See the header of this file for why an exemption list is not the answer.",
    );
    process.exit(1);
  }
  const prCount = workflows.filter((one) => one.acceptsPullRequest).length;
  console.log(
    `OK — ${packages.length} package(s) with a test suite, each run by one of ${prCount} pull-request workflow(s).`,
  );
}

main();
