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

/** What the collaboration browser run mounts and drives; see collaboration.yml. */
const COLLABORATION_ENTRIES = [
  "apps/mobile/app/_layout.tsx",
  "apps/mobile/features/e2e/collaboration/Fixture.tsx",
  "apps/mcp/test/browser/verifyEditor.mjs",
  "apps/mcp/test/browser/editor-worker.ts",
];

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

  const browserMobile = requiredPaths(["@context/mobile"], ".github/workflows/browser.yml", root);
  assertPaths(filterPaths(browser, "webkit_build", "mobile"), browserMobile, "webkit browser build");
  const nativeMobile = requiredPaths(["@context/mobile"], ".github/workflows/ci.yml", root);
  assertPaths(filterPaths(ci, "native-bundle", "mobile"), nativeMobile, "native-bundle");

  const fullWebkit = new Set([
    "apps/mobile/e2e/webkit/**",
    "apps/mobile/features/console/**",
    "packages/collaboration/**",
    "packages/communications/**",
    "packages/desktop-bridge/**",
    "packages/drawings/**",
    "packages/meetings/**",
    "packages/obsidian-runtime/**",
    "packages/shared/**",
    ...INFRA_PATHS,
    ".github/workflows/browser.yml",
  ]);
  assertPaths(filterPaths(browser, "webkit_build", "full"), fullWebkit, "full WebKit suite");
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

  // Scoped by what the run executes: the screen and Worker it mounts, and the
  // harness that drives them. Losing one of these entries would shrink the
  // scope to whatever the rest import, and skip runs that matter.
  assertScopedJob(collaboration, "browser", ".github/workflows/collaboration.yml", ["@context/collaboration"]);
  const collaborationEntries = scopePaths(collaboration, "browser", "entries");
  for (const entry of COLLABORATION_ENTRIES) {
    if (!collaborationEntries.has(entry)) throw new Error(`collaboration browser scope is missing entry ${entry}`);
  }
  for (const entry of collaborationEntries) {
    if (!existsSync(join(root, entry))) throw new Error(`collaboration browser scope entry ${entry} does not exist`);
  }
  // The route and the switch that lead the harness to that fixture are not
  // imported by it, so they are watched by name.
  const collaborationPaths = scopePaths(collaboration, "browser");
  for (const path of ["apps/mobile/app/e2e-fixture.tsx", "apps/mobile/features/e2e/FixtureScreen.tsx", "apps/mcp/test/browser/**"]) {
    if (!collaborationPaths.has(path)) throw new Error(`collaboration browser scope does not watch ${path}`);
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
    [".github/workflows/mcp.yml", "decryptor", ["@supa-media/context-encryption-decryptor"]],
    [".github/workflows/mcp.yml", "meetings", ["@context/meetings"]],
    [".github/workflows/mcp.yml", "obsidian-runtime", ["@context/obsidian-runtime"]],
    [".github/workflows/mcp.yml", "communications", ["@context/communications"]],
    [".github/workflows/mcp.yml", "drawings", ["@context/drawings"]],
    [".github/workflows/mcp.yml", "desktop", ["@context/desktop"]],
    [".github/workflows/router.yml", "test", ["@context/router"]],
    [".github/workflows/email-worker.yml", "test", ["@context/email-worker"]],
    [".github/workflows/transcribe-worker.yml", "test", ["@context/transcribe-worker"]],
    [".github/workflows/egress-service.yml", "test", ["@context/egress-service"]],
    [".github/workflows/sentry-worker.yml", "test", ["@context/sentry-worker"]],
    [".github/workflows/cli.yml", "test", ["@supa-media/context"]],
    [".github/workflows/cli.yml", "no-dependencies", ["@supa-media/context"]],
  ];
  for (const [workflow, job, packages] of scoped) {
    assertScopedJob(readFileSync(join(root, workflow), "utf8"), job, workflow, packages);
  }
  assertBundleSourcesWatched(root);
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
