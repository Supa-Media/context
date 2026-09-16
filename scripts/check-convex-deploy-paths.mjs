#!/usr/bin/env node
/**
 * Every source tree the control plane bundles, checked against the paths that
 * actually trigger its deploy.
 *
 * ── WHAT WENT WRONG ───────────────────────────────────────────────────────
 *
 * `apps/convex` is not self-contained and never has been. It imports the
 * storage adapter, the search engine, the forms engine, the plugin scanner and
 * the sandbox shim straight out of `apps/mcp/src` and `packages/`, and `npx
 * convex deploy` bundles all of it. `deploy-convex.yml` listed four of those
 * paths by hand.
 *
 * So a change to the plugin scanner deployed the gateway, deployed the app,
 * passed CI, merged — and left the control plane running the previous month's
 * copy of the same file. The scan a person sees in the console runs in Convex.
 * It kept answering from code that had been replaced three pull requests ago,
 * and the console kept drawing that answer with today's date on it.
 *
 * Measured when it was found: six trees Convex bundles were outside the filter
 * — `plugins/`, `search/`, `store/`, `forms.js`, `storageLayout.js` and
 * `packages/obsidian-runtime/` — and every one of them had been changed since
 * the last deploy that happened to be triggered by something else. One of those
 * changes was a path-traversal fix.
 *
 * ── WHY A GUARD RATHER THAN A LONGER LIST ─────────────────────────────────
 *
 * The list was not wrong when it was written. It was a hand-maintained copy of
 * an import graph, and the graph moved. Writing a longer copy fixes today and
 * schedules the same failure for whenever the next import is added, which is
 * the definition of the thing `docs/decisions/testing.md` says is not a guard.
 *
 * So this derives the truth: it walks what `apps/convex` imports, follows those
 * files' own imports, and asserts every external file it reaches is covered by
 * a path in the workflow's filter. Adding an import that the deploy would not
 * notice now fails CI at the moment it is added, naming the file and the path
 * that would have to cover it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not check the reverse — a filter path covering nothing is harmless
 * and over-deploying Convex is safe, since `convex deploy` is idempotent. The
 * asymmetry is the point: this guard exists to stop an under-trigger, and an
 * over-trigger is the direction a deploy should fail in.
 *
 * Run `--self-test` to prove the checker still catches a filter that is missing
 * a path, which is the failure it was written for and the one a refactor of it
 * would quietly lose.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW = "apps/convex/../../.github/workflows/deploy-convex.yml";
const ENTRY_DIR = "apps/convex";

/**
 * The paths listed under this workflow's `push.paths`.
 *
 * Parsed from the `on:` block rather than from the whole file, because the
 * header above talks about paths in prose and a grep would read the prose as
 * configuration — the mistake `check-workflow-triggers.mjs` records having made.
 */
export function deployPaths(yaml) {
  const lines = yaml.split("\n");
  const paths = [];
  let inOn = false;
  let inPaths = false;
  for (const line of lines) {
    if (/^on:\s*$/.test(line)) { inOn = true; continue; }
    if (inOn && /^\S/.test(line)) break;
    if (!inOn) continue;
    if (/^\s{4,}paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths) {
      const item = line.match(/^\s+-\s+"?([^"\s#]+)"?/);
      if (item) { paths.push(item[1]); continue; }
      if (line.trim() !== "" && !line.trim().startsWith("#")) inPaths = false;
    }
  }
  return paths;
}

/** Does one of the workflow's globs cover this repository-relative file? */
export function covered(file, paths) {
  return paths.some((pattern) => {
    // The only two shapes these filters use: a literal file, and a prefix with
    // `**`. Anything more exotic would need a matcher, and a matcher nobody
    // tested is how a guard starts passing for the wrong reason.
    if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
    return file === pattern;
  });
}

const EXTENSIONS = ["", ".ts", ".js", ".tsx", ".mjs", ".cjs", "/index.ts", "/index.js"];

function resolveImport(specifier, fromFile) {
  let base;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith("@context/")) {
    // The workspace packages, whose name maps to a directory rather than to
    // node_modules — `@context/shared/src/links` is `packages/shared/src/links`.
    const rest = specifier.slice("@context/".length);
    const slash = rest.indexOf("/");
    const pkg = slash === -1 ? rest : rest.slice(0, slash);
    const inner = slash === -1 ? "src/index" : rest.slice(slash + 1);
    base = resolve(ROOT, "packages", pkg, inner);
  } else {
    // A real dependency. It is installed from a lockfile, not bundled out of
    // this repository, so no path here could trigger a deploy for it.
    return null;
  }
  for (const extension of EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/*
  Newlines are allowed between `import` and `from`, because a multi-line import
  list is the normal shape here and the first version of this forbade them —
  which quietly dropped `@context/obsidian-runtime`, `forms.js` and
  `enablement.js` from the answer. A guard that misses the import it was written
  for is worse than no guard, so the bound is a character count rather than a
  line: it cannot cross a quote, and 400 is far past the longest import list in
  this repository.
*/
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]{0,400}?\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function importsIn(source) {
  const found = [];
  for (const match of source.matchAll(IMPORT)) found.push(match[1]);
  for (const match of source.matchAll(BARE_IMPORT)) found.push(match[1]);
  return found;
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "_generated") continue;
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every file outside `apps/convex` that a Convex deploy would bundle.
 *
 * Follows imports transitively: `files.ts` imports `inventory.js`, which
 * imports `scan.js`, and a change to `scan.js` is just as invisible to the
 * deploy as a change to the file that names it.
 */
export function externalFiles() {
  const queue = sourceFiles(join(ROOT, ENTRY_DIR));
  const seen = new Set(queue);
  const external = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of importsIn(source)) {
      const target = resolveImport(specifier, file);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      const rel = relative(ROOT, target);
      if (!rel.startsWith(`${ENTRY_DIR}/`)) external.add(rel);
      queue.push(target);
    }
  }
  return [...external].sort();
}

function run() {
  const yaml = readFileSync(resolve(ROOT, ".github/workflows/deploy-convex.yml"), "utf8");
  const paths = deployPaths(yaml);
  if (paths.length === 0) {
    console.error("deploy-convex.yml: could not read any push paths — refusing to pass vacuously.");
    return 1;
  }
  const missed = externalFiles().filter((file) => !covered(file, paths));
  if (missed.length > 0) {
    console.error(
      "These files are bundled into the Convex deployment but do not trigger it:\n" +
        missed.map((file) => `  ${file}`).join("\n") +
        "\n\nA change to any of them merges, passes CI, and leaves the control plane" +
        "\nrunning the previous copy. Add a covering path to `push.paths` in" +
        "\n.github/workflows/deploy-convex.yml.",
    );
    return 1;
  }
  console.log(`Convex deploy covers all ${externalFiles().length} bundled files outside ${ENTRY_DIR}/.`);
  return 0;
}

function selfTest() {
  const problems = [];
  // The failure this exists for: a real bundled file, a filter that omits it.
  const bundled = externalFiles();
  if (bundled.length === 0) problems.push("found no external imports at all — the walker is not walking");
  if (!bundled.some((file) => file.startsWith("apps/mcp/src/"))) {
    problems.push("did not reach apps/mcp/src, which apps/convex demonstrably imports");
  }
  if (covered("apps/mcp/src/plugins/inventory.js", ["apps/convex/**"])) {
    problems.push("a filter that cannot cover a file was reported as covering it");
  }
  if (!covered("apps/mcp/src/plugins/inventory.js", ["apps/mcp/src/plugins/**"])) {
    problems.push("a prefix that does cover a file was reported as not covering it");
  }
  if (deployPaths('on:\n  push:\n    branches: [main]\n    paths:\n      - "a/**"\n      - "b.js"\n').join(",") !== "a/**,b.js") {
    problems.push("the paths parser did not read a plain paths block");
  }
  // Prose in the header must not be read as configuration.
  if (deployPaths('# paths:\n#   - "not/real/**"\non:\n  push:\n    paths:\n      - "real/**"\n').join(",") !== "real/**") {
    problems.push("the paths parser read a commented path as configuration");
  }
  if (problems.length > 0) {
    console.error(`check-convex-deploy-paths self-test failed:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    return 1;
  }
  console.log(`check-convex-deploy-paths self-test passed (${bundled.length} bundled files seen).`);
  return 0;
}

process.exit(process.argv.includes("--self-test") ? selfTest() : run());
