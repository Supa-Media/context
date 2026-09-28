#!/usr/bin/env node

/**
 * Keep expensive pull-request jobs aligned with the workspace packages they
 * actually execute.
 *
 * The workflow triggers stay broad so required checks always report. The
 * expensive steps are gated inside each job instead. This checker prevents
 * those gates from drifting when a workspace dependency is added, and refuses
 * the broad `packages/**` shortcut that makes unrelated package changes pay for
 * a browser run.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INFRA_PATHS = [".npmrc", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/**"];

function manifests(root) {
  const byName = new Map();
  for (const parent of ["apps", "packages", "infra", "plugins"]) {
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.name) continue;
      byName.set(manifest.name, {
        dir: relative(root, dirname(manifestPath)).replaceAll("\\", "/"),
        manifest,
      });
    }
  }
  return byName;
}

export function workspacePaths(rootNames, root = ROOT) {
  const byName = manifests(root);
  const pending = [...rootNames];
  const seen = new Set();
  const paths = new Set();

  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const workspace = byName.get(name);
    if (!workspace) throw new Error(`Unknown workspace package ${name}`);
    paths.add(`${workspace.dir}/**`);

    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, version] of Object.entries(workspace.manifest[section] ?? {})) {
        if (String(version).startsWith("workspace:") && byName.has(dependency)) pending.push(dependency);
      }
    }
  }

  return paths;
}

function jobBlock(yaml, job) {
  const start = yaml.search(new RegExp(`^  ${job}:$`, "m"));
  if (start === -1) throw new Error(`Missing job ${job}`);
  const rest = yaml.slice(start);
  const next = rest.slice(rest.indexOf("\n") + 1).search(/^  [A-Za-z0-9_-]+:$/m);
  return next === -1 ? rest : rest.slice(0, rest.indexOf("\n") + 1 + next);
}

export function filterPaths(yaml, job, filter) {
  const block = jobBlock(yaml, job);
  const filtersAt = block.indexOf("filters: |");
  if (filtersAt === -1) throw new Error(`${job} has no in-job path filter`);
  const afterFilters = block.slice(filtersAt);
  const match = afterFilters.match(new RegExp(`^            ${filter}:\\n((?:              - [^\\n]+\\n?)+)`, "m"));
  if (!match) throw new Error(`${job} has no ${filter} path set`);
  return new Set(
    match[1]
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").replace(/^['\"]|['\"]$/g, "")),
  );
}

export function assertPaths(actual, required, label) {
  if (actual.has("packages/**")) {
    throw new Error(`${label} uses packages/** and therefore runs for unrelated package changes`);
  }
  const missing = [...required].filter((path) => !actual.has(path));
  if (missing.length > 0) throw new Error(`${label} is missing: ${missing.join(", ")}`);
}

function stepBlocks(job) {
  return job.split(/^      - /m).slice(1).map((step) => `      - ${step}`);
}

export function assertExpensiveStepsAreGated(yaml, job, output) {
  const steps = stepBlocks(jobBlock(yaml, job));
  const detector = steps.findIndex((step) => step.includes("id: changes"));
  if (detector === -1) throw new Error(`${job} has no change detector`);
  const condition = `steps.changes.outputs.${output} == 'true'`;
  for (const step of steps.slice(detector + 1)) {
    if (!step.includes(condition)) {
      const name = step.match(/name:\s*([^\n]+)/)?.[1] ?? step.match(/uses:\s*([^\n]+)/)?.[1] ?? "unnamed step";
      throw new Error(`${job}: ${name} is not gated by ${output}`);
    }
  }
}

function requiredPaths(rootNames, workflow, root = ROOT) {
  return new Set([...workspacePaths(rootNames, root), ...INFRA_PATHS, workflow]);
}

export function check(root = ROOT) {
  const ciPath = join(root, ".github/workflows/ci.yml");
  const collaborationPath = join(root, ".github/workflows/collaboration.yml");
  const ci = readFileSync(ciPath, "utf8");
  const collaboration = readFileSync(collaborationPath, "utf8");

  const mobile = requiredPaths(["@context/mobile"], ".github/workflows/ci.yml", root);
  assertPaths(filterPaths(ci, "editor-webkit", "mobile"), mobile, "editor-webkit");
  assertPaths(filterPaths(ci, "native-bundle", "mobile"), mobile, "native-bundle");

  const collaborationBrowser = requiredPaths(
    ["@context/mobile", "@context/mcp"],
    ".github/workflows/collaboration.yml",
    root,
  );
  assertPaths(
    filterPaths(collaboration, "browser", "browser"),
    collaborationBrowser,
    "collaboration browser",
  );
  assertExpensiveStepsAreGated(collaboration, "browser", "browser");
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
    "broad package scope",
    () => assertPaths(new Set(["apps/mobile/**", "packages/**"]), new Set(["apps/mobile/**"]), "test"),
    "unrelated package changes",
  );
  expectFailure(
    "missing dependency",
    () => assertPaths(new Set(["apps/mobile/**"]), new Set(["apps/mobile/**", "packages/shared/**"]), "test"),
    "packages/shared/**",
  );
  const unguarded = `  browser:\n    steps:\n      - uses: actions/checkout@v5\n      - uses: dorny/paths-filter@v3\n        id: changes\n        with:\n          filters: |\n            browser:\n              - "apps/mobile/**"\n      - name: Expensive\n        run: do-work\n`;
  expectFailure(
    "unguarded expensive step",
    () => assertExpensiveStepsAreGated(unguarded, "browser", "browser"),
    "Expensive",
  );
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) selfTest();
  else check();
  console.log("CI path gates OK");
}
