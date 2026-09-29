#!/usr/bin/env node
/**
 * A package whose tests exist must have a job that runs them.
 *
 * `ci.yml` hands the whole test matrix to supa-framework's reusable workflow,
 * and two of that workflow's jobs are gated on inputs this caller chooses:
 *
 *   test-shared:  if: inputs.shared-package != '' && (… the `shared` filter …)
 *   test-convex:  if: (… the `convex` filter …)   # and falls back to
 *                 `cd apps/convex && pnpm test` when `convex-package` is unset
 *
 * The convex job runs either way. **The shared job cannot run at all unless
 * `shared-package` is passed**, and this caller does not pass it — so
 * `ci / Test Shared Package` reports `skipped` on every pull request,
 * including the ones whose `Detect Changes` step prints `Filter shared = true`.
 *
 * That is correct today and invisible tomorrow. `@context/shared` has no
 * `test` script: its behaviour is covered from `apps/convex/__tests__`, which
 * the `convex` filter runs because that filter names `packages/shared/**`. The
 * moment somebody writes `packages/shared/src/*.test.ts` and a `test` script
 * to run them, those tests execute on nobody's machine but their own, and the
 * check list will go on saying "skipped" in a way that reads like every other
 * change-scoped skip on the page.
 *
 * So this guard pins the pair in both directions:
 *
 *   - a `test` script in the shared package **requires** the input, and
 *   - the input, if passed, **requires** a package that has a `test` script
 *     (otherwise the job runs `pnpm --filter <name> test` and goes red).
 *
 * This is the narrow half of a wider rule that is still owed: every test file
 * a package's `test` script names should be run by some pull-request job.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const CI_WORKFLOW = ".github/workflows/ci.yml";
const SHARED_PACKAGE_JSON = "packages/shared/package.json";
const CALLER = /uses:\s*Supa-Media\/supa-framework\/\.github\/workflows\/ci\.yml@/;

/** The `with:` mapping this repository passes to the reusable workflow. */
export function callerInputs(yaml) {
  const lines = yaml.split("\n");
  const at = lines.findIndex((line) => CALLER.test(line));
  if (at === -1) throw new Error(`${CI_WORKFLOW} no longer calls the reusable workflow; this guard is reading the wrong file`);
  const withAt = lines.findIndex((line, i) => i > at && /^\s*with:\s*$/.test(line));
  if (withAt === -1 || withAt > at + 3) throw new Error(`the reusable-workflow call in ${CI_WORKFLOW} has no with: block where this guard expects one`);
  const depth = lines[withAt].search(/\S/);
  const inputs = new Map();
  for (const line of lines.slice(withAt + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (line.search(/\S/) <= depth) break;
    const match = /^\s*([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (match) inputs.set(match[1], match[2].replace(/^["']|["']$/g, ""));
  }
  return inputs;
}

/** Every workspace package name that declares a `test` script. */
function packagesWithTests(roots = ["apps", "packages", "infra"]) {
  const found = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const manifest = join(root, name, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.scripts?.test) found.add(parsed.name);
    }
  }
  return found;
}

export function problems({ inputs, sharedName, sharedHasTests, testable }) {
  const found = [];
  const declared = inputs.get("shared-package");
  if (sharedHasTests && (declared === undefined || declared === "")) {
    found.push(
      `${SHARED_PACKAGE_JSON} declares a \`test\` script, and no pull-request job runs it: ` +
        `the reusable workflow's Test Shared Package job is gated on \`shared-package\`, ` +
        `which ${CI_WORKFLOW} does not pass. Pass \`shared-package: "${sharedName}"\`.`,
    );
  }
  if (declared !== undefined && declared !== "" && !testable.has(declared)) {
    found.push(
      `${CI_WORKFLOW} passes \`shared-package: "${declared}"\`, but no workspace package of that ` +
        `name declares a \`test\` script. Test Shared Package would run \`pnpm --filter ${declared} test\` and fail.`,
    );
  }
  return found;
}

export function check() {
  const inputs = callerInputs(readFileSync(CI_WORKFLOW, "utf8"));
  const shared = JSON.parse(readFileSync(SHARED_PACKAGE_JSON, "utf8"));
  return problems({
    inputs,
    sharedName: shared.name,
    sharedHasTests: Boolean(shared.scripts?.test),
    testable: packagesWithTests(),
  });
}

function selfTest() {
  const yaml = [
    "jobs:",
    "  ci:",
    "    uses: Supa-Media/supa-framework/.github/workflows/ci.yml@main",
    "    with:",
    "      app-slug: \"context\"",
    "      # a comment, and a blank line, inside the block",
    "",
    "      lint-continue-on-error: false",
    "    secrets: inherit",
  ].join("\n");
  const inputs = callerInputs(yaml);
  if (inputs.get("app-slug") !== "context" || inputs.get("lint-continue-on-error") !== "false") {
    throw new Error("the with: block was not read as written");
  }
  if (inputs.has("secrets")) throw new Error("the block was read past its own indentation");

  const testable = new Set(["@context/shared"]);
  const cases = [
    [{ inputs: new Map(), sharedHasTests: false, testable: new Set() }, 0],
    [{ inputs: new Map(), sharedHasTests: true, testable }, 1],
    [{ inputs: new Map([["shared-package", "@context/shared"]]), sharedHasTests: true, testable }, 0],
    [{ inputs: new Map([["shared-package", "@context/shared"]]), sharedHasTests: false, testable: new Set() }, 1],
  ];
  for (const [input, expected] of cases) {
    const got = problems({ sharedName: "@context/shared", ...input }).length;
    if (got !== expected) throw new Error(`expected ${expected} problem(s), got ${got}`);
  }

  let threw = false;
  try {
    callerInputs("jobs:\n  ci:\n    uses: somebody/else/.github/workflows/ci.yml@main\n");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("a workflow that no longer calls the reusable CI was accepted");
  console.log("OK — self-test passed.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const found = check();
  if (found.length > 0) {
    console.error("A package's tests would not run in CI:\n");
    for (const problem of found) console.error("  " + problem);
    process.exit(1);
  }
  console.log("OK — the shared package's tests and the job that would run them agree.");
}
