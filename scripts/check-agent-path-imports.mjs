#!/usr/bin/env node

/**
 * apps/agent imports packages/shared/src modules by relative path, not as a
 * workspace dependency, so the ci-scope `packages:` input cannot see them. A
 * change to one of those files would not wake the agent suite, which is how
 * PR #3733 changed groupRunQuestions.cjs, the suite in workers.yml skipped, and
 * main broke (reverted in #3741).
 *
 * So this checks that every relative import from packages/tex/worker that leaves
 * apps/agent is matched by the `paths:` of the agent ci-scope step in
 * .github/workflows/workers.yml, job `test`. Plain Node over files in this
 * repository, so it needs no install.
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scopePaths, unwatchedSources } from "./check-ci-path-gates.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"];
const RELATIVE_IMPORT = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

/**
 * The repo-relative files that sources under `dir` import by relative path and
 * that live outside `dir`, sorted and unique.
 */
export function relativeImportsOutside(dir, root = ROOT) {
  const found = new Set();
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(RELATIVE_IMPORT)) {
          const target = relative(root, resolve(dirname(path), match[1])).replaceAll("\\", "/");
          if (!target.startsWith(`${dir}/`)) found.add(target);
        }
      }
    }
  };
  walk(join(root, dir));
  return [...found].sort();
}

/**
 * apps/agent imports packages/shared files by relative path, not as a workspace
 * dependency, so package-based scope cannot see them. PR #3733 changed
 * groupRunQuestions.cjs, skipped the agent tests, and broke main.
 */
export function assertPathImportsWatched(imports, watched, label) {
  const missing = unwatchedSources(imports, watched);
  if (missing.length) {
    throw new Error(`${label} imports ${missing.join(", ")} by path, but its CI scope does not watch it; a change there would skip its tests`);
  }
}

/** The agent's path imports must be watched by its ci-scope step in workers.yml. */
export function check(root = ROOT) {
  const workers = readFileSync(join(root, ".github/workflows/workers.yml"), "utf8");
  assertPathImportsWatched(relativeImportsOutside("packages/tex/worker", root), scopePaths(workers, "test", "paths", "agent"), "workers.yml:test:agent");
}

function expectFailure(name, fn, includes) {
  try {
    fn();
  } catch (error) {
    if (String(error.message).includes(includes)) return;
    throw new Error(`${name} failed for the wrong reason: ${error.message}`);
  }
  throw new Error(`${name} did not fail`);
}

export function selfTest() {
  expectFailure(
    "a path import the scope does not watch",
    () => assertPathImportsWatched(["packages/shared/src/groupRunQuestions.cjs"], new Set(["packages/tex/src/texNumber.cjs"]), "agent"),
    "groupRunQuestions.cjs",
  );
  if (!relativeImportsOutside("packages/tex/worker").includes("packages/shared/src/groupRunQuestions.cjs")) {
    throw new Error("the agent's path import of groupRunQuestions.cjs was not found");
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) selfTest();
  else check();
  console.log("Agent path imports OK");
}
