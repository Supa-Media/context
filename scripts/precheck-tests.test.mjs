#!/usr/bin/env node
/**
 * `node --test scripts/precheck-tests.test.mjs`: proves the reach-based test
 * selection in scripts/precheck-tests.mjs on a throwaway git repository.
 *
 * The fixture has the real gateway test runner (`apps/mcp/test/run.mjs` and its
 * TypeScript hooks) and two unit tests: one imports `src/value.js`, the other
 * imports `src/other.js`. It has no `apps/mobile` or `apps/convex`, so those
 * suites skip before any change filter is read (selectMobile and selectConvex
 * check the directory first). Each case builds its own repository and removes
 * it, so the cases cannot see each other's edits.
 *
 * The sabotage proof is the "break" case: a change to `value.js` must fail
 * the one test that reaches it, and the output must not name the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, gatewayGraph, rankAndCap, selectGateway } from "./precheck-tests.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts/precheck-tests.mjs");
const RUNNER_FILES = ["run.mjs", "tsRegister.mjs", "tsHook.mjs"];

// Git inside the fixture must not inherit the hook or worktree the outer run was started in.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
// Under `node --test`, NODE_TEST_CONTEXT is set, and a `node --test` started beneath it skips every file and
// exits 0 without running one. It is passed on here on purpose: precheck-tests.mjs must clear it for its runners,
// and the break case fails if it does not.
const childEnv = gitEnv;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const write = (root, file, text) => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const REACHED_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { value } from "../src/value.js";

test("reached: value is 1", () => assert.equal(value, 1));
`;

const OTHER_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { other } from "../src/other.js";

test("other: value is other", () => assert.equal(other, "other"));
`;

/**
 * A repository on one commit: the gateway runner, two unit tests and the two
 * sources they import. Returns the root and the base commit to diff against.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "precheck-tests-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  for (const file of RUNNER_FILES) {
    mkdirSync(join(root, "apps/mcp/test"), { recursive: true });
    copyFileSync(join(REPO, "apps/mcp/test", file), join(root, "apps/mcp/test", file));
  }
  write(root, "apps/mcp/test/unit.list", "test/reached.test.mjs\ntest/other.test.mjs\n");
  write(root, "apps/mcp/test/reached.test.mjs", REACHED_TEST);
  write(root, "apps/mcp/test/other.test.mjs", OTHER_TEST);
  write(root, "apps/mcp/src/value.js", "export const value = 1;\n");
  write(root, "apps/mcp/src/other.js", 'export const other = "other";\n');
  write(root, "docs/notes.md", "# Notes\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

/** Runs the selector CLI against a fixture, the way precheck runs it. */
function precheck(root, base, ...extra) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--base", base, ...extra], {
    encoding: "utf8",
    env: { ...childEnv, BASE_SHA: "" },
    timeout: 120_000,
  });
}

/** Runs one case against a fresh fixture and removes the fixture whatever happens. */
function withFixture(body) {
  const { root, base } = fixture();
  try {
    return body(root, base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a change that breaks the test it reaches fails, and only that test runs", () =>
  withFixture((root, base) => {
    write(root, "apps/mcp/src/value.js", "export const value = 2;\n");
    const result = precheck(root, base);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /reached\.test\.mjs/);
    assert.doesNotMatch(output, /other\.test\.mjs/);
    assert.match(output, /precheck tests: gateway — 1 of 2 test files reached, running 1/);
    assert.match(output, /# fail 1/);
  }));

test("a compatible change to a reached source passes, and runs one gateway file", () =>
  withFixture((root, base) => {
    write(root, "apps/mcp/src/value.js", "export const value = 1 + 0;\n");
    const result = precheck(root, base);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /precheck tests: gateway — 1 of 2 test files reached, running 1/);
    assert.match(output, /# pass 1\b/);
    assert.doesNotMatch(output, /# pass 2\b/);
    assert.match(output, /precheck tests: gateway passed/);
    assert.match(output, /precheck tests: mobile — skipped/);
    assert.match(output, /precheck tests: convex — skipped/);
  }));

test("a docs-only change skips every suite and runs nothing", () =>
  withFixture((root, base) => {
    write(root, "docs/notes.md", "# Notes\n\nA new line.\n");
    const result = precheck(root, base);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /precheck tests: gateway — skipped: no changed file reaches it/);
    assert.match(output, /precheck tests: mobile — skipped/);
    assert.match(output, /precheck tests: convex — skipped/);
    assert.doesNotMatch(output, /running \d/);
    assert.doesNotMatch(output, /=====/);
  }));

/**
 * A repository with the mobile and Convex suites present: their directories and the change-filters
 * in ci.yml, which the suites read. Their own test runners are stood in for by a fake `pnpm` (see below).
 */
function suitesFixture() {
  const made = fixture();
  const { root } = made;
  write(root, "apps/mobile/features/existing.ts", "export const existing = 1;\n");
  write(root, "apps/convex/functions/existing.ts", "export const existing = 1;\n");
  write(
    root,
    ".github/workflows/ci.yml",
    [
      "jobs:",
      "  changes:",
      "    steps:",
      "      - with:",
      "      change-filters: |",
      "        mobile:",
      "          - 'apps/mobile/**'",
      "        convex:",
      "          - 'apps/convex/**'",
      "",
    ].join("\n"),
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "suites base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

/**
 * A `pnpm` that records every call in a log and succeeds without printing a test list, so a suite whose
 * reach finds no test file is the case under test. Returns the directory to put first on PATH and the log.
 */
function fakePnpm(root) {
  const bin = join(root, "..", `${root.split("/").pop()}-bin`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  writeFileSync(join(bin, "pnpm"), '#!/bin/sh\necho "$*" >> "$PRECHECK_FAKE_LOG"\nexit 0\n');
  chmodSync(join(bin, "pnpm"), 0o755);
  return { bin, log };
}

test("a suite whose filter matches but whose reach finds no test runs nothing, and never the whole suite", () => {
  const { root, base } = suitesFixture();
  const fake = fakePnpm(root);
  try {
    write(root, "apps/mobile/features/fresh.ts", "export const fresh = 2;\n");
    write(root, "apps/convex/functions/fresh.ts", "export const fresh = 2;\n");
    const result = spawnSync(process.execPath, [SCRIPT, "--root", root, "--base", base], {
      encoding: "utf8",
      env: { ...childEnv, BASE_SHA: "", PATH: `${fake.bin}:${process.env.PATH}`, PRECHECK_FAKE_LOG: fake.log },
      timeout: 120_000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.match(output, /precheck tests: mobile — skipped: no changed file reaches it/);
    assert.match(output, /precheck tests: convex — skipped: no changed file reaches it/);
    const calls = existsSync(fake.log) ? readFileSync(fake.log, "utf8") : "";
    // The list calls are the reach questions; a run call with no file names would run every test in the suite.
    assert.doesNotMatch(calls, /vitest run|--runTestsByPath|exec jest --runTests/, calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fake.bin, { recursive: true, force: true });
  }
});

test("changedFiles lists edits, a new untracked file and no renames", () =>
  withFixture((root, base) => {
    write(root, "apps/mcp/src/value.js", "export const value = 1 + 0;\n");
    write(root, "apps/mcp/src/fresh.js", "export const fresh = 1;\n");
    assert.deepEqual(changedFiles(root, base), ["apps/mcp/src/fresh.js", "apps/mcp/src/value.js"]);
  }));

test("selectGateway gives import distances on the fixture", () =>
  withFixture((root) => {
    const graph = gatewayGraph(root);
    assert.deepEqual(selectGateway({ root, changed: ["apps/mcp/src/value.js"], graph }), {
      tests: [{ file: "apps/mcp/test/reached.test.mjs", distance: 1 }],
      total: 2,
    });
    assert.deepEqual(selectGateway({ root, changed: ["apps/mcp/test/other.test.mjs"], graph }), {
      tests: [{ file: "apps/mcp/test/other.test.mjs", distance: 0 }],
      total: 2,
    });
    assert.deepEqual(selectGateway({ root, changed: ["apps/mcp/src/other.js"], graph }).tests, [
      { file: "apps/mcp/test/other.test.mjs", distance: 1 },
    ]);
    assert.deepEqual(selectGateway({ root, changed: ["docs/notes.md"], graph }).tests, []);
  }));

test("selectGateway resolves the real repository's imports (setArea reaches its test)", () => {
  const started = Date.now();
  const { tests, total } = selectGateway({ root: REPO, changed: ["apps/mcp/src/tools/notes/setArea.js"] });
  const found = tests.find((test) => test.file === "apps/mcp/test/setArea.test.mjs");
  assert.ok(found, `setArea.test.mjs not reached; reached ${tests.length} of ${total}`);
  assert.equal(found.distance, 1);
  assert.ok(total > 100, `unit.list should name hundreds of files, got ${total}`);
  assert.ok(Date.now() - started < 20_000, "the real graph should build in well under 20 s");
});

test("rankAndCap: changed tests always run and are not counted against the cap", () => {
  const changed = ["apps/mcp/test/x.test.mjs", "apps/mcp/src/a.js"];
  const tests = [
    "apps/mcp/test/x.test.mjs",
    { file: "apps/mcp/test/far.test.mjs", distance: 4 },
    { file: "apps/mcp/test/near.test.mjs", distance: 1 },
    { file: "apps/mcp/test/mid.test.mjs", distance: 2 },
  ];
  // The cap of 2 keeps the two nearest of the three others (distances 1 and 2); the farthest is left.
  assert.deepEqual(rankAndCap(tests, changed, 2), {
    run: ["apps/mcp/test/mid.test.mjs", "apps/mcp/test/near.test.mjs", "apps/mcp/test/x.test.mjs"],
    left: 1,
  });
  assert.deepEqual(rankAndCap(tests, changed, 0), { run: ["apps/mcp/test/x.test.mjs"], left: 3 });
});

test("rankAndCap: at equal distance, the test sharing name words with a change comes first", () => {
  const picked = rankAndCap(
    [
      { file: "apps/mcp/test/unrelated.test.mjs", distance: 1 },
      { file: "apps/mcp/test/setArea.test.mjs", distance: 1 },
    ],
    ["apps/mcp/src/setArea.js"],
    1,
  );
  assert.deepEqual(picked, { run: ["apps/mcp/test/setArea.test.mjs"], left: 1 });
});

test("rankAndCap: a test with no known distance ranks after every measured one, and a duplicate keeps its nearest", () => {
  const picked = rankAndCap(
    ["t/a.test.mjs", { file: "t/b.test.mjs", distance: 5 }, { file: "t/b.test.mjs", distance: 2 }, { file: "t/c.test.mjs", distance: 9 }],
    ["src/q.js"],
    1,
  );
  assert.deepEqual(picked, { run: ["t/b.test.mjs"], left: 2 });
});
