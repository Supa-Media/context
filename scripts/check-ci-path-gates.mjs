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

/** Where the editor bundle records the sources it was built from. */
const BUNDLE = "apps/mobile/features/console/files/webview/bundle.generated.ts";

/**
 * Does one changed file fall under one watched pattern?
 *
 * The definition lives here rather than in `ci-change-scope.mjs`, which imports
 * it: that module already depends on this one, and the coverage guard below has
 * to decide "is this file watched?" with **exactly** the matcher the runtime
 * uses. Two copies of two lines is how a gate comes to be checked against a
 * rule nobody enforces — which is the defect this whole file exists for.
 */
export function matches(file, pattern) {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

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

/** One named list from ci.yml's `change-filters: |` block. */
export function changeFilter(yaml, name) {
  const block = /\n {6}change-filters: \|\n((?: {8}.*\n)+)/.exec(yaml);
  if (!block) throw new Error("ci.yml passes no change-filters");
  const paths = new Set();
  let current = null;
  for (const line of block[1].split("\n")) {
    const key = /^ {8}([a-z0-9-]+):$/.exec(line);
    if (key) { current = key[1]; continue; }
    const item = /^ {10}- '([^']+)'$/.exec(line);
    if (item && current === name) paths.add(item[1]);
  }
  if (paths.size === 0) throw new Error(`ci.yml's change-filters has no ${name} list`);
  return paths;
}

export function filterPaths(yaml, job, filter) {
  const block = jobBlock(yaml, job);
  const filtersAt = block.indexOf("filters: |");
  if (filtersAt === -1) throw new Error(`${job} has no in-job path filter`);
  const afterFilters = block.slice(filtersAt);
  const list = afterFilters.match(new RegExp(`^            ${filter}:\\n((?:              - [^\\n]+\\n?)+)`, "m"));
  if (list) {
    return new Set(
      list[1]
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").replace(/^['\"]|['\"]$/g, "")),
    );
  }
  const inline = afterFilters.match(new RegExp(`^            ${filter}: (\\[[^\\n]+\\])$`, "m"));
  if (inline) return new Set(JSON.parse(inline[1]));
  throw new Error(`${job} has no ${filter} path set`);
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

/**
 * The paths one job's shared CI scope step watches, read from its `paths: |`
 * block.
 *
 * Indentation-relative rather than a fixed column, because the block's depth is
 * a formatting choice and a checker that hard-codes it reports "no paths" on a
 * reindented file — which reads as "this job watches nothing" and would be
 * believed.
 */
export function scopePaths(yaml, job, key = "paths") {
  const scope = stepBlocks(jobBlock(yaml, job)).find((step) =>
    step.includes("uses: ./.github/actions/ci-scope"),
  );
  if (scope === undefined) throw new Error(`${job} has no shared CI scope step`);
  const lines = scope.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^\\s+${key}: \\|\\s*$`).test(line));
  if (at === -1) throw new Error(`${job}'s scope step has no ${key}: | block`);
  const depth = lines[at].search(/\S/);
  const paths = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") continue;
    if (line.search(/\S/) <= depth) break;
    paths.push(line.trim());
  }
  if (paths.length === 0) throw new Error(`${job}'s ${key}: | block is empty`);
  return new Set(paths);
}

/** Which of `sources` no pattern in `watched` covers. */
export function unwatchedSources(sources, watched) {
  return [...sources].filter((source) => ![...watched].some((pattern) => matches(source, pattern)));
}

/**
 * EVERY SOURCE THE EDITOR BUNDLE RECORDS MUST BE WATCHED BY THE JOB THAT
 * REBUILDS IT.
 *
 * `bundle.generated.ts` is a 950kb blob that runs inside the editor webview
 * over somebody's private markdown, and the only thing binding it to its
 * sources is the `editor-bundle` job rebuilding it and comparing bytes. That
 * job is now scoped, so a pull request outside its `paths:` skips every step
 * and the job reports success — correct for an unrelated change, and a hole for
 * a source the list forgot.
 *
 * The list forgot two, and in a way a list of directories always will:
 * `apps/mcp/src/forms/**` and `apps/mcp/src/lists/**` do not match their
 * siblings `apps/mcp/src/forms.js` and `apps/mcp/src/lists.js`, which are
 * bundle sources — and `lists.js` is `setNoteProperty`, the frontmatter writer
 * every list and folder-page write calls. A change confined to it skipped this
 * job *and* the hash check in `apps/mobile/__tests__/editorBundle.test.ts`,
 * because the mobile suite is itself filtered to `apps/mobile`, `apps/convex`
 * and `packages/shared`. Nothing was left to notice that the committed bundle
 * no longer matched its sources.
 *
 * So the list is checked against the bundle's own record of what it was built
 * from, here, in the lane that runs on every pull request.
 */
export function assertBundleSourcesWatched(root = ROOT) {
  const generated = readFileSync(join(root, BUNDLE), "utf8");
  const sources = [...generated.matchAll(/^ {2}"([^"]+)": "[0-9a-f]{64}",$/gm)].map((match) => match[1]);
  // A reader that silently matches nothing would pass every repository it is
  // pointed at, which is this file's own most-repeated failure shape.
  if (sources.length < 50) {
    throw new Error(`read only ${sources.length} sources from ${BUNDLE}; the reader is wrong`);
  }
  const watched = scopePaths(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), "editor-bundle");
  const unwatched = unwatchedSources(sources, watched);
  if (unwatched.length > 0) {
    throw new Error(
      `editor-bundle does not run when these bundle sources change: ${unwatched.join(", ")}`,
    );
  }
}

/**
 * AND THE BUNDLE ITSELF MUST BE WATCHED, NOT ONLY WHAT IT IS BUILT FROM.
 *
 * `assertBundleSourcesWatched` above reads the bundle's own record of its
 * inputs and checks each one is in the job's `paths:`. The *output* is not one
 * of those inputs, so nothing above says a word about it — and a pull request
 * that edits only `bundle.generated.ts`, injecting code into the blob that
 * runs over somebody's private markdown, is precisely the case the
 * rebuild-and-compare job says it exists for.
 *
 * Today that request is caught, by one pattern: `console/files/**` is in the
 * list because most of the bundle's sources live under it, and the artifact
 * happens to sit there too. Nothing records that this coincidence is
 * load-bearing, and the guard above actively pushes a maintainer toward the
 * edit that ends it — its complaint is that "a list of directories always
 * will" forget a sibling, and the obvious answer to that is to enumerate the
 * recorded sources instead. Measured, not supposed: replacing that one
 * pattern with the source paths it covers, named one by one, leaves `check()`
 * green with the artifact unwatched. No count is written down here on
 * purpose — it would be the stale-number defect this file exists to catch.
 *
 * So the output is asserted here, beside the inputs, with the same matcher.
 */
export function assertBundleArtifactWatched(root = ROOT) {
  const watched = scopePaths(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), "editor-bundle");
  if (unwatchedSources([BUNDLE], watched).length > 0) {
    throw new Error(
      `editor-bundle does not run when ${BUNDLE} itself changes, so a commit that edits only the ` +
        "generated bundle skips the rebuild that would catch it",
    );
  }
}

/**
 * A GUARD THAT NAMES ITS OWN SOURCE ROOTS MUST BE RUN WHERE THEY CHANGE.
 *
 * `check-worker-fetch-options.mjs` scans four Worker source trees — the
 * gateway, the email worker, the router and the transcribe worker — because
 * workerd does not implement `redirect: "error"` and shipping it stops the
 * worker dead before the request is made. Its header says it shipped twice,
 * and that the second occurrence was found only because the first had been.
 *
 * Its only host is `mcp.yml`'s `Test Gateway`, which since #1074 is
 * `ci-scope`d to `@context/mcp` plus five named packages. Three of its four
 * roots are outside that set, so a pull request touching only
 * `infra/email-worker/src`, `infra/router/src` or `infra/transcribe-worker/src`
 * computed `affected: false` and the guard did not run — measured with this
 * module's own matcher, not assumed.
 *
 * The recurring shape: what a guard checks and where a guard runs are written
 * down in two places, and only one of them is enforced. This is the other one.
 *
 * A job with no `ci-scope` step in a workflow that triggers on `pull_request`
 * watches the whole tree: `check-workflow-triggers.mjs` already refuses a
 * `paths:` or `paths-ignore:` filter on `pull_request`, so there is no second
 * way to narrow one.
 */
export function guardRoots(script, root = ROOT) {
  const source = readFileSync(join(root, script), "utf8");
  const block = source.match(/^const ROOTS = \[\n((?:.*\n)*?)\];$/m);
  if (block === null) throw new Error(`${script} declares no ROOTS array`);
  // `,?` deliberately: a reader that needs the trailing comma drops the last
  // root the moment somebody removes it, and drops it **silently** — fewer
  // roots to cover is a guard that passes for the wrong reason, which is the
  // failure shape this whole file exists for.
  const roots = [...block[1].matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => match[1]);
  if (roots.length === 0) throw new Error(`read no roots from ${script}; the reader is wrong`);
  return roots;
}

/** Which workflow jobs run `script` against the tree, and what each watches. */
export function guardHosts(script, root = ROOT) {
  const dir = join(root, ".github/workflows");
  const hosts = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml")).sort()) {
    const yaml = readFileSync(join(dir, file), "utf8");
    if (!/^on:\n(?:  .*\n)*?  pull_request:/m.test(yaml)) continue;
    const jobsAt = yaml.search(/^jobs:$/m);
    if (jobsAt === -1) continue;
    for (const [, job] of yaml.slice(jobsAt).matchAll(/^  ([A-Za-z0-9_-]+):$/gm)) {
      const block = jobBlock(yaml, job);
      const runs = block
        .split("\n")
        .some((line) => line.trim().replace(/^run:\s+/, "") === `node ${script}`);
      if (!runs) continue;
      hosts.push({ workflow: file, job, watched: hostWatches(yaml, job, root) });
    }
  }
  return hosts;
}

/** The paths one host job watches, or `null` when it is ungated. */
function hostWatches(yaml, job, root) {
  const scope = stepBlocks(jobBlock(yaml, job)).find((step) =>
    step.includes("uses: ./.github/actions/ci-scope"),
  );
  if (scope === undefined) return null;
  const named = scope.match(/packages:\s*["']?([^"'\n]+)["']?/)?.[1] ?? "";
  const packages = named.split(/[\s,]+/).filter(Boolean);
  return new Set([...scopePaths(yaml, job), ...workspacePaths(packages, root)]);
}

/**
 * The guards that declare their own source roots, discovered rather than
 * listed: a hard-coded list is the thing that goes stale, and a rename would
 * empty it silently, so the floor below refuses an empty answer.
 */
export function rootDeclaringGuards(root = ROOT) {
  const dir = join(root, "scripts");
  const found = readdirSync(dir)
    .filter((name) => name.startsWith("check-") && name.endsWith(".mjs"))
    .filter((name) => /^const ROOTS = \[$/m.test(readFileSync(join(dir, name), "utf8")))
    .map((name) => `scripts/${name}`)
    .sort();
  if (found.length === 0) throw new Error("found no guard declaring ROOTS; the reader is wrong");
  return found;
}

export function assertRootsCovered(roots, hosts, script) {
  if (hosts.length === 0) throw new Error(`no pull-request job runs ${script}`);
  if (hosts.some((host) => host.watched === null)) return;
  const watched = new Set(hosts.flatMap((host) => [...host.watched]));
  const unwatched = roots.filter(
    (source) => ![...watched].some((pattern) => matches(`${source}/probe`, pattern)),
  );
  if (unwatched.length > 0) {
    const where = hosts.map((host) => `${host.workflow}:${host.job}`).join(", ");
    throw new Error(
      `${script} scans ${unwatched.join(", ")}, which no job running it watches (${where})`,
    );
  }
}

export function assertGuardRootsWatched(script, root = ROOT) {
  assertRootsCovered(guardRoots(script, root), guardHosts(script, root), script);
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

export function assertScopedJob(yaml, job, workflow, packages) {
  const steps = stepBlocks(jobBlock(yaml, job));
  const detector = steps.findIndex((step) => step.includes("uses: ./.github/actions/ci-scope"));
  if (detector === -1) throw new Error(`${workflow}:${job} has no shared CI scope step`);
  const scope = steps[detector];
  if (!scope.includes("id: scope")) throw new Error(`${workflow}:${job} scope step has no id: scope`);
  if (!scope.includes(workflow)) throw new Error(`${workflow}:${job} does not run when its workflow changes`);
  for (const name of packages) {
    if (!scope.includes(name)) throw new Error(`${workflow}:${job} does not name package ${name}`);
  }
  const condition = "steps.scope.outputs.affected == 'true'";
  for (const step of steps.slice(detector + 1)) {
    if (!step.includes(condition)) {
      const name = step.match(/name:\s*([^\n]+)/)?.[1] ?? step.match(/uses:\s*([^\n]+)/)?.[1] ?? "unnamed step";
      throw new Error(`${workflow}:${job}: ${name} is not gated by the shared scope`);
    }
  }
}

/**
 * A job that runs several packages' suites, each behind its own scope step.
 * Every scope names its package and the workflow; every step after the first
 * scope (other than the scopes themselves) is gated by exactly one of them;
 * and each scope gates a step that runs its own package — so a suite cannot
 * end up behind another package's scope and skip when its own code changes.
 */
export function assertMultiScopedJob(yaml, job, workflow, suites) {
  const steps = stepBlocks(jobBlock(yaml, job));
  const first = steps.findIndex((step) => step.includes("uses: ./.github/actions/ci-scope"));
  if (first === -1) throw new Error(`${workflow}:${job} has no scope step`);
  const gated = new Map(Object.keys(suites).map((id) => [id, []]));
  for (const step of steps.slice(first)) {
    if (step.includes("uses: ./.github/actions/ci-scope")) {
      const id = step.match(/\bid:\s*([\w-]+)/)?.[1];
      const suite = suites[id];
      if (!suite) throw new Error(`${workflow}:${job} has a scope step "${id}" nobody declared`);
      if (!step.includes(workflow)) throw new Error(`${workflow}:${job}:${id} does not run when its workflow changes`);
      for (const name of suite.packages) {
        if (!step.includes(name)) throw new Error(`${workflow}:${job}:${id} does not name package ${name}`);
      }
      continue;
    }
    const ids = [...step.matchAll(/steps\.([\w-]+)\.outputs\.affected == 'true'/g)].map((match) => match[1]);
    const name = step.match(/name:\s*([^\n]+)/)?.[1] ?? step.match(/uses:\s*([^\n]+)/)?.[1] ?? "unnamed step";
    if (ids.length !== 1) throw new Error(`${workflow}:${job}: ${name} is not gated by exactly one package scope`);
    if (!gated.has(ids[0])) throw new Error(`${workflow}:${job}: ${name} is gated by unknown scope ${ids[0]}`);
    // A step that runs another package's suite behind this scope would skip
    // when that package changes and nothing here does.
    for (const [other, { runs }] of Object.entries(suites)) {
      if (other !== ids[0] && step.includes(runs) && !step.includes(suites[ids[0]].runs)) {
        throw new Error(`${workflow}:${job}: ${name} runs ${runs} behind the ${ids[0]} scope`);
      }
    }
    gated.get(ids[0]).push(step);
  }
  for (const [id, { runs }] of Object.entries(suites)) {
    if (!gated.get(id).some((step) => step.includes(runs))) {
      throw new Error(`${workflow}:${job}: no step behind scope ${id} runs ${runs}`);
    }
  }
}

function requiredPaths(rootNames, workflow, root = ROOT) {
  return new Set([...workspacePaths(rootNames, root), ...INFRA_PATHS, workflow]);
}

export function check(root = ROOT) {
  const ciPath = join(root, ".github/workflows/ci.yml");
  const browserPath = join(root, ".github/workflows/browser.yml");
  const collaborationPath = join(root, ".github/workflows/collaboration.yml");
  const ci = readFileSync(ciPath, "utf8");
  const browser = readFileSync(browserPath, "utf8");
  const collaboration = readFileSync(collaborationPath, "utf8");

  const nativeMobile = requiredPaths(["@context/mobile"], ".github/workflows/ci.yml", root);
  assertPaths(filterPaths(ci, "native-bundle", "mobile"), nativeMobile, "native-bundle");

  // Per push the browser runs only the note editor's tests, scoped by what the
  // editor imports; the rest of the suite is daily (Dev2, 2026-10-07). The
  // editor job must run exactly the specs the scope watches, or an editor
  // test could change without running, or run without its file being watched.
  const browserTrigger = browser.slice(browser.indexOf("\non:"), browser.indexOf("\njobs:"));
  for (const event of ["pull_request", "push", "schedule", "workflow_dispatch"]) {
    if (!browserTrigger.includes(`\n  ${event}:`)) throw new Error(`browser.yml no longer runs on ${event}`);
  }
  const scopeStep = jobBlock(browser, "webkit_build");
  for (const entry of [
    "apps/mobile/features/console/files/LiveEditor.web.tsx",
    "apps/mobile/features/console/files/LiveEditor.tsx",
    "apps/mobile/features/console/files/webview/entry.ts",
  ]) {
    if (!scopeStep.includes(`            ${entry}\n`)) throw new Error(`the editor browser scope no longer follows ${entry}`);
  }
  const scopedSpecs = [...scopeStep.matchAll(/^ {12}(apps\/mobile\/e2e\/webkit\/[\w.]+\.spec\.ts)$/gm)].map((m) => m[1]).sort();
  const editorJob = jobBlock(browser, "webkit_editor");
  const editorSpecs = [...editorJob.matchAll(/(e2e\/webkit\/[\w.]+\.spec\.ts)/g)].map((m) => `apps/mobile/${m[1]}`).sort();
  if (!scopedSpecs.length || scopedSpecs.join() !== [...new Set(editorSpecs)].join()) {
    throw new Error(`the editor job runs ${editorSpecs.join(", ")} but the scope watches ${scopedSpecs.join(", ")}`);
  }
  for (const job of ["webkit_full", "webkit_offline"]) {
    if (!/\n    if: .*needs\.webkit_build\.outputs\.daily == 'true'/.test(jobBlock(browser, job))) {
      throw new Error(`${job} runs on every push again; it is daily`);
    }
  }
  if (!/\n    if: .*needs\.webkit_build\.outputs\.daily != 'true'/.test(editorJob)) {
    throw new Error("the note editor job no longer runs per push");
  }
  const build = jobBlock(browser, "webkit_build");
  const shards = jobBlock(browser, "webkit_full");
  const summary = jobBlock(browser, "editor_webkit");
  if (!build.includes("name: webkit-fixture")) throw new Error("WebKit build does not publish one shared fixture");
  if (!shards.includes('image: mcr.microsoft.com/playwright:v1.56.1-noble')) {
    throw new Error("WebKit shards do not use the pinned browser image");
  }
  if (!shards.includes('["1/2", "2/2"]') || !shards.includes("--reporter=blob")) {
    throw new Error("full WebKit suite is not split into two mergeable shards");
  }
  if (!summary.includes("playwright merge-reports") || !summary.includes("name: editor-webkit-report")) {
    throw new Error("WebKit summary does not retain one merged report");
  }

  // The control-plane suite runs once, in `ci / Test Convex Backend`; Gateway
  // Contracts keeps only its detector. So ci.yml's convex filter must watch
  // everything that suite reads from outside apps/convex, or a gateway-only
  // pull request skips the very checks Gateway Contracts was written for.
  const convexFilter = changeFilter(ci, "convex");
  for (const path of [
    ...workspacePaths(["@context/mcp", "@context/convex"], root),
    "apps/mobile/features/console/storage/dropbox.ts",
    "apps/mobile/features/console/storage/dropbox.web.ts",
    ".github/workflows/deploy-convex.yml",
    ...INFRA_PATHS,
  ]) {
    // A file under the watched path, so `packages/**` covers
    // `packages/collaboration/**`.
    const sample = path.endsWith("/**") ? `${path.slice(0, -3)}/sample.ts` : path;
    if (![...convexFilter].some((pattern) => matches(sample, pattern))) {
      throw new Error(`ci.yml's convex filter does not watch ${path}`);
    }
  }

  // The browser run is daily and on demand (Dev2, 2026-10-07), and the
  // per-push half of it, the collaboration package's own suite, runs in
  // `Test Gateway`. Losing either would leave the editor's room unchecked.
  const trigger = collaboration.slice(collaboration.indexOf("\non:"), collaboration.indexOf("\npermissions:"));
  if (!/\n  schedule:\n    - cron: "[^"]+"/.test(trigger) || !trigger.includes("\n  workflow_dispatch:")) {
    throw new Error("collaboration browser run is not scheduled daily and runnable by hand");
  }
  if (/\n  (pull_request|push):/.test(trigger)) {
    throw new Error("collaboration browser run is back on every push; it runs daily");
  }
  const gateway = jobBlock(readFileSync(join(root, ".github/workflows/mcp.yml"), "utf8"), "test");
  if (!gateway.includes("pnpm --filter @context/collaboration test")) {
    throw new Error("Test Gateway no longer runs the collaboration suite on every push");
  }
  const collaborationJob = jobBlock(collaboration, "browser");
  if (!collaborationJob.includes("image: mcr.microsoft.com/playwright:v1.56.1-noble")) {
    throw new Error("collaboration browser does not use the pinned browser image");
  }
  if (collaborationJob.includes("playwright install")) {
    throw new Error("collaboration browser downloads Chromium instead of using the pinned image");
  }

  const scoped = [
    [".github/workflows/ci.yml", "editor-bundle", []],
    [".github/workflows/ci.yml", "convex-deploy-typecheck", ["@context/convex"]],
    [".github/workflows/gateway-contracts.yml", "contracts", ["@context/mcp", "@context/convex"]],
    [".github/workflows/mcp.yml", "test", ["@context/mcp"]],
    [".github/workflows/mcp.yml", "desktop", ["@context/desktop"]],
    [".github/workflows/email-worker.yml", "test", ["@context/email-worker"]],
    [".github/workflows/cli.yml", "test", ["@supa-media/context"]],
    [".github/workflows/cli.yml", "no-dependencies", ["@supa-media/context"]],
  ];
  // One job, several packages: each suite is gated by its own package's scope.
  assertMultiScopedJob(readFileSync(join(root, ".github/workflows/mcp.yml"), "utf8"), "packages", ".github/workflows/mcp.yml", {
    decryptor: { packages: ["@supa-media/context-encryption-decryptor"], runs: "packages/encryption-decryptor" },
    meetings: { packages: ["@context/meetings"], runs: "packages/meetings" },
    obsidian: { packages: ["@context/obsidian-runtime"], runs: "packages/obsidian-runtime" },
    communications: { packages: ["@context/communications"], runs: "packages/communications" },
    drawings: { packages: ["@context/drawings"], runs: "packages/drawings" },
    sentry: { packages: ["@context/sentry-worker"], runs: "infra/sentry-worker" },
  });
  assertMultiScopedJob(readFileSync(join(root, ".github/workflows/workers.yml"), "utf8"), "test", ".github/workflows/workers.yml", {
    router: { packages: ["@context/router"], runs: "infra/router" },
    transcribe: { packages: ["@context/transcribe-worker"], runs: "infra/transcribe-worker" },
    egress: { packages: ["@context/egress-service"], runs: "infra/egress-service" },
    siteshots: { packages: ["@context/site-shots"], runs: "infra/site-shots" },
    agent: { packages: ["@context/agent"], runs: "apps/agent" },
  });

  for (const [workflow, job, packages] of scoped) {
    assertScopedJob(readFileSync(join(root, workflow), "utf8"), job, workflow, packages);
  }
  assertBundleSourcesWatched(root);
  assertBundleArtifactWatched(root);
  for (const script of rootDeclaringGuards(root)) assertGuardRootsWatched(script, root);
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
  const unscoped = `  test:\n    steps:\n      - uses: actions/checkout@v5\n      - uses: ./.github/actions/ci-scope\n        id: scope\n        with:\n          packages: "@context/router"\n          paths: ".github/workflows/router.yml"\n      - name: Expensive\n        run: do-work\n`;
  expectFailure(
    "unguarded shared scope",
    () => assertScopedJob(unscoped, "test", ".github/workflows/router.yml", ["@context/router"]),
    "Expensive",
  );

  /*
    The coverage rule, on the case that was actually wrong: a directory pattern
    does not match its own sibling file. Asserted in both directions, because a
    matcher that answered "watched" for everything would satisfy the first half
    and hide every gap.
  */
  if (unwatchedSources(["apps/mcp/src/lists.js"], ["apps/mcp/src/lists/**"]).length !== 1) {
    throw new Error("a directory pattern was read as covering its sibling file");
  }
  if (unwatchedSources(["apps/mcp/src/lists/status.js"], ["apps/mcp/src/lists/**"]).length !== 0) {
    throw new Error("a file inside a watched directory was read as unwatched");
  }
  if (unwatchedSources(["apps/mobile/package.json"], ["apps/mobile/package.json"]).length !== 0) {
    throw new Error("an exactly-named watched file was read as unwatched");
  }

  /*
    And the same rule for a guard's own source roots, in both directions. The
    scoped host is the shape `mcp.yml` had: it watches the gateway and nothing
    else, while the guard it runs also scans three `infra/` workers.
  */
  const scopedHost = { workflow: "w.yml", job: "test", watched: new Set(["apps/mcp/**"]) };
  expectFailure(
    "a guard whose host watches fewer roots than it scans",
    () => assertRootsCovered(["apps/mcp/src", "infra/router/src"], [scopedHost], "scripts/g.mjs"),
    "infra/router/src",
  );
  expectFailure(
    "a guard no pull-request job runs",
    () => assertRootsCovered(["apps/mcp/src"], [], "scripts/g.mjs"),
    "no pull-request job runs",
  );
  try {
    assertRootsCovered(
      ["apps/mcp/src", "infra/router/src"],
      [{ workflow: "fast-guards.yml", job: "guards", watched: null }],
      "scripts/g.mjs",
    );
  } catch (error) {
    throw new Error(`an ungated host did not cover every root: ${error.message}`);
  }
  // Pinned rather than "more than zero": the reader above drops a root it
  // cannot parse, and dropping one is the direction that makes this guard
  // quietly weaker. A legitimate change to the list fails here and gets read.
  if (guardRoots("scripts/check-worker-fetch-options.mjs").length !== 4) {
    throw new Error("check-worker-fetch-options.mjs no longer declares the four roots read here");
  }

  /*
    The bundle's OUTPUT, in both directions. The failing case is the real edit
    this guards against: a `paths:` list that names every recorded source and
    not the artifact they build, which `assertBundleSourcesWatched` passes.
  */
  const artifactYaml = (paths) =>
    `  editor-bundle:\n    steps:\n      - uses: ./.github/actions/ci-scope\n        id: scope\n        with:\n          paths: |\n${paths
      .map((path) => `            ${path}\n`)
      .join("")}`;
  const sourcesOnly = artifactYaml([
    "apps/mobile/features/console/files/editorSetup.ts",
    "apps/mobile/features/console/files/webview/entry.ts",
  ]);
  if (unwatchedSources([BUNDLE], scopePaths(sourcesOnly, "editor-bundle")).length !== 1) {
    throw new Error("a paths list naming only the bundle's sources was read as watching the bundle");
  }
  for (const covering of [BUNDLE, "apps/mobile/features/console/files/**", "apps/mobile/**"]) {
    if (unwatchedSources([BUNDLE], scopePaths(artifactYaml([covering]), "editor-bundle")).length !== 0) {
      throw new Error(`\`${covering}\` was read as not covering the generated bundle`);
    }
  }

  const noPaths = `  editor-bundle:\n    steps:\n      - uses: ./.github/actions/ci-scope\n        id: scope\n        with:\n          packages: "@context/mobile"\n`;
  expectFailure(
    "a scoped job whose paths cannot be read",
    () => scopePaths(noPaths, "editor-bundle"),
    "no paths: | block",
  );
  const reindented = `  editor-bundle:\n    steps:\n      - uses: ./.github/actions/ci-scope\n        id: scope\n        with:\n          paths: |\n              apps/mcp/src/lists.js\n              scripts/build-editor-bundle.mjs\n`;
  if (scopePaths(reindented, "editor-bundle").size !== 2) {
    throw new Error("a reindented paths block was not read");
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) selfTest();
  else check();
  console.log("CI path gates OK");
}
