#!/usr/bin/env node

/**
 * Decide whether one pull-request job can prove anything about the diff.
 *
 * The workflow still starts and reports a check. Only setup and test steps are
 * skipped, so a required context can never remain pending because a trigger
 * filter prevented it from existing. A merge group (the merge queue's trial
 * commit) is scoped the same way, against the commit it was built on. Pushes
 * to main always run as a backstop.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { matches, workspacePaths } from "./check-ci-path-gates.mjs";
import { reach, reached } from "./import-reach.mjs";
import { jobBlock } from "./lib/workflow-jobs.mjs";

const ROOT_INPUTS = [
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "patches/**",
  ".github/actions/ci-scope/**",
  "scripts/ci-change-scope.mjs",
  "scripts/check-ci-path-gates.mjs",
  "scripts/lib/workflow-jobs.mjs",
  "scripts/import-reach.mjs",
];

/**
 * Tex's config and data: the wiring graph, its node shelf, prompt words,
 * Training and test-set conversations, and the files generated from them.
 * They change behaviour only through the code that reads them, so a diff made
 * of nothing else is proven by the jobs that read them (the gateway and Worker
 * suites, the generated-bundle check, the fast guards and the Tex test set),
 * which opt in with `tex-data: "true"`. Every other job skips such a diff
 * (Dev2, 2026-11-17: a config change runs the AI tests, not every suite).
 * A diff with any other file in it is scoped exactly as before.
 */
export const TEX_DATA = [
  "packages/shared/src/texConfig.json",
  "packages/shared/src/texNodeShelf.json",
  "packages/shared/src/texPrompt/**",
  "packages/shared/src/texTraining.generated.json",
  "packages/shared/src/texSetsRepo.generated.json",
  "apps/mcp/bench/sets/**",
  "apps/mcp/src/agent/texArchitecture.generated.js",
  "apps/mcp/src/texDev/canvas.generated.js",
  "apps/mcp/src/texDev/lab.generated.js",
  "apps/mcp/src/texDev/replay.generated.js",
  "apps/mobile/features/tex/lab/labData.generated.ts",
  "apps/mobile/features/tex/lab/promptCatalog.generated.json",
  "docs/architecture/tex.md",
];

/** True when a diff is non-empty and every file in it is Tex config or data. */
export function texDataOnly(changed) {
  return changed.length > 0 && changed.every((file) => TEX_DATA.some((pattern) => matches(file, pattern)));
}

export function parseList(value = "") {
  return String(value)
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Re-exported, not defined here: `check-ci-path-gates.mjs` owns it, because the
 * guard that checks a job's watched paths cover what it must has to decide
 * coverage with exactly this matcher, and a second copy is a rule nobody
 * enforces.
 */
export { matches };

export function selectChanged(changed, watched) {
  return changed.filter((file) => watched.some((pattern) => matches(file, pattern)));
}

export function watchedPaths(packages, paths, root = process.cwd()) {
  return [...new Set([...workspacePaths(packages, root), ...ROOT_INPUTS, ...paths])].sort();
}

function git(...args) {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hasCommit(sha) {
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function commitParents(rev) {
  try {
    // The raw object, not `rev^1`: a depth-1 checkout grafts HEAD to have no
    // parents, but the object still names them.
    const header = git("cat-file", "commit", rev).split("\n\n")[0];
    return header.split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  } catch {
    return [];
  }
}

/**
 * What a pull request's checkout is diffed against.
 *
 * `pull_request.base.sha` is the base branch as it stood when the event's
 * pull request was last computed, often the moment it was opened, while the
 * checkout is `refs/pull/N/merge`: the branch merged into the base as it is
 * NOW. Diffing the two hands every job the files of every pull request merged
 * in between, so on a busy day a phone-only change ran the gateway suite, the
 * Convex typecheck and the editor bundle because other threads had merged
 * gateway work (#1607, 2026-10-14). The merge commit's first parent is the
 * base it was actually merged onto, so that diff is exactly this pull request.
 * Anything else checked out (a head ref, a hand-made event) keeps the old,
 * broader base.
 */
export function pullRequestBase(event, parents) {
  const head = event.pull_request?.head?.sha;
  if (parents.length === 2 && head && parents[1] === head) return parents[0];
  return event.pull_request?.base?.sha;
}

/**
 * What a merge group's checkout is diffed against.
 *
 * A merge group is the queue's trial commit for one pull request: main, the
 * pull requests ahead of it in the queue, then this one. `base_sha` is that
 * commit's parent, so the diff is this pull request alone, on top of the tree
 * it will actually land on. The pull requests ahead were proven by their own
 * groups, and the queue rebuilds this group when one of them drops out. A
 * payload whose head is not the commit checked out is not trusted: no base,
 * so the job runs.
 */
export function mergeGroupBase(event, head) {
  const group = event.merge_group;
  if (!group?.base_sha || !group.head_sha || group.head_sha !== head) return undefined;
  return group.base_sha;
}

function headSha() {
  try {
    return git("rev-parse", "HEAD");
  } catch {
    return "";
  }
}

export function changedFiles(env = process.env) {
  // A push is diffed against the commit it replaced only when the job asks
  // (`push-diff`): the editor's browser run must not run on a merge that did
  // not touch the editor (Dev2, 2026-10-07). Every other job keeps the
  // unconditional main-branch backstop.
  const pushDiff = env.GITHUB_EVENT_NAME === "push" && env.CI_SCOPE_PUSH_DIFF === "true";
  const mergeGroup = env.GITHUB_EVENT_NAME === "merge_group";
  if (env.GITHUB_EVENT_NAME !== "pull_request" && !pushDiff && !mergeGroup) {
    return { files: [], backstop: `${env.GITHUB_EVENT_NAME || "local"} runs the main-branch backstop` };
  }
  if (!env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) {
    return { files: [], backstop: "the event payload is unavailable" };
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  // A new branch or a force push reports no usable `before`; that runs.
  const base = pushDiff
    ? event.before
    : mergeGroup
      ? mergeGroupBase(event, headSha())
      : pullRequestBase(event, commitParents("HEAD"));
  if (!/^[0-9a-f]{40}$/.test(base ?? "") || /^0+$/.test(base)) {
    return { files: [], backstop: "the base commit is unavailable" };
  }
  if (!hasCommit(base)) {
    try {
      git("fetch", "--no-tags", "--quiet", "--depth=1", "origin", base);
    } catch {
      return { files: [], backstop: `base commit ${base.slice(0, 8)} could not be fetched` };
    }
  }
  return {
    files: git("diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean),
    backstop: null,
  };
}

function writeOutput(name, value, env = process.env) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function writeSummary(lines, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

/**
 * `entries` scopes by the files those entry points import rather than by whole
 * packages (see import-reach.mjs); `packages` and `paths` still add to it.
 */
export function decide({
  packages = [],
  paths = [],
  entries = [],
  changed = [],
  backstop = null,
  texData = false,
  root = process.cwd(),
}) {
  const watched = watchedPaths(packages, paths, root);
  if (!backstop && !texData && texDataOnly(changed)) {
    return {
      affected: false,
      reason: `only Tex config and data changed (${changed.length} path${changed.length === 1 ? "" : "s"}); the Tex suites and test set prove it`,
      matched: [],
      watched,
    };
  }
  const scope = entries.length ? reach(entries, root) : null;
  const matched = backstop
    ? []
    : changed.filter((file) => watched.some((pattern) => matches(file, pattern)) || (scope && reached(file, scope)));
  const affected = Boolean(backstop || matched.length);
  const reason = backstop
    ? backstop
    : matched.length
      ? `${matched.length} watched path${matched.length === 1 ? "" : "s"} changed`
      : `${changed.length} changed path${changed.length === 1 ? "" : "s"}, none watched by this job`;
  return { affected, reason, matched, watched };
}

export function selfTest() {
  const root = new URL("../", import.meta.url).pathname;
  const scope = watchedPaths(["@context/mcp"], [".github/workflows/mcp.yml"], root);
  if (!scope.includes("apps/mcp/**")) throw new Error("workspace package path is missing");
  if (!scope.includes("packages/collaboration/**")) throw new Error("recursive workspace dependency is missing");
  if (!selectChanged(["apps/mcp/src/index.js"], scope).length) throw new Error("owned source did not match");
  if (selectChanged(["apps/mobile/App.tsx"], scope).length) throw new Error("unrelated source matched");
  if (!selectChanged(["pnpm-lock.yaml"], scope).length) throw new Error("lockfile did not fan out");
  const fallback = decide({ packages: [], paths: [], changed: [], backstop: "missing base", root });
  if (!fallback.affected) throw new Error("uncertain scope did not fail open");
  const byEntry = (file) => decide({ entries: ["apps/mcp/src/index.js"], changed: [file], root }).affected;
  if (!byEntry("apps/mcp/src/index.js")) throw new Error("an entry point did not match itself");
  if (!byEntry("apps/mcp/wrangler.toml")) throw new Error("a config beside reached code did not fail open");
  if (byEntry("apps/mcp/test/test.mjs")) throw new Error("a test nothing imports matched an entry scope");
  // The collaboration run's real scope, through the `@/` alias and relative imports.
  const collaboration = (file) =>
    decide({ entries: ["apps/mobile/app/_layout.tsx", "apps/mobile/features/e2e/collaboration/Fixture.tsx"], changed: [file], root }).affected;
  if (!collaboration("apps/mobile/features/console/files/NoteEditor.tsx")) throw new Error("the editor is outside the collaboration scope");
  if (collaboration("apps/mobile/__tests__/formBlock.test.ts")) throw new Error("an app unit test matched the collaboration scope");
  // The editor's browser run: packages and other apps are followed by file.
  const editor = (file) =>
    decide({
      entries: ["apps/mobile/features/console/files/LiveEditor.web.tsx", "apps/mobile/features/console/files/webview/entry.ts"],
      changed: [file],
      root,
    }).affected;
  if (!editor("packages/shared/src/links.ts")) throw new Error("a shared file the editor imports is outside its scope");
  if (editor("packages/shared/src/siteDesign/css.ts")) throw new Error("a shared file the editor never imports matched its scope");
  // Reached before only through `import type { MenuItem } from "./menu"` in editorMenu.ts: types are erased.
  if (editor("packages/shared/src/folderIcons.cjs")) throw new Error("a file reached only through a type import matched the editor scope");
  if (!editor("apps/mcp/src/forms/grammar.js")) throw new Error("gateway code the editor imports is outside its scope");
  if (editor("apps/mcp/wrangler.toml")) throw new Error("a config of an app the editor only imports from matched its scope");
  if (!editor("apps/mobile/metro.config.js")) throw new Error("a build config of the app the editor is built in did not fail open");
  if (editor("apps/mobile/public/index.html")) throw new Error("an asset nothing imports matched the editor scope");
  if (editor("apps/mobile/eslint.config.js")) throw new Error("a lint config matched the editor scope");
  // A diff of only Tex config and data runs only the jobs that opt in.
  const config = ["packages/shared/src/texConfig.json", "apps/mobile/features/tex/lab/labData.generated.ts", "docs/architecture/tex.md"];
  const mobile = (changed, texData) => decide({ packages: [], paths: ["apps/mobile/**", "packages/shared/**"], changed, texData, root }).affected;
  if (mobile(config, false)) throw new Error("a config-only diff ran a job that did not opt in to Tex data");
  if (!mobile(config, true)) throw new Error("a config-only diff skipped a job that opted in to Tex data");
  if (!mobile([...config, "apps/mobile/App.tsx"], false)) throw new Error("a diff with code beside the config skipped a watching job");
  if (!mobile(["packages/shared/src/texPrompt/frontDoor.md"], true)) throw new Error("a prompt edit skipped an opted-in job");
  if (texDataOnly([])) throw new Error("an empty diff counted as Tex data only");
  // The framework CI's copy of the list must be this one.
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const block = /\n {6}skip-when-only: \|\n((?: {8}.*\n)+)/.exec(ci);
  const listed = block ? block[1].split("\n").map((line) => line.trim()).filter(Boolean) : [];
  if (listed.join("\n") !== TEX_DATA.join("\n")) throw new Error("ci.yml's skip-when-only is not TEX_DATA");
  // The mobile shards skip a config-only diff, so the Lab's wiring tests have their own workflow, and only then.
  const wiring = jobBlock(readFileSync(join(root, ".github/workflows/tex-lab-wiring.yml"), "utf8"), "tex-lab-wiring");
  if (!wiring.includes("mode: tex-data-only")) throw new Error("Tex Lab wiring does not ask whether the diff is only Tex data");
  if (!wiring.includes("steps.tex.outputs.only == 'true'")) throw new Error("Tex Lab wiring is not limited to a Tex-data diff");
  if (!wiring.includes("pnpm exec jest --testPathPattern '__tests__/texLab'")) throw new Error("Tex Lab wiring does not run the texLab tests");
  if (texDataOnly(["packages/shared/src/texConfig.ts"])) throw new Error("a code file beside the config counted as Tex data");
  if (!decide({ paths: ["apps/mobile/**"], changed: config, backstop: "push", root }).affected) {
    throw new Error("the main-branch backstop skipped a config-only push");
  }
  // A pull request is diffed against the base its test merge was made onto.
  const pr = { pull_request: { base: { sha: "a".repeat(40) }, head: { sha: "c".repeat(40) } } };
  if (pullRequestBase(pr, ["b".repeat(40), "c".repeat(40)]) !== "b".repeat(40)) {
    throw new Error("a pull request was not diffed against its merge commit's first parent");
  }
  if (pullRequestBase(pr, ["c".repeat(40)]) !== "a".repeat(40)) throw new Error("a non-merge checkout lost the event's base");
  if (pullRequestBase(pr, ["b".repeat(40), "d".repeat(40)]) !== "a".repeat(40)) {
    throw new Error("a merge of some other head was trusted as this pull request's");
  }
  if (commitParents("HEAD").length === 0 && git("rev-list", "--count", "HEAD") !== "1") {
    throw new Error("commit parents could not be read");
  }
  // A push runs the backstop unless the job asked to diff it.
  const event = join(mkdtempSync(join(tmpdir(), "ci-scope-")), "event.json");
  const head = git("rev-parse", "HEAD");
  const push = (before, flag) => {
    writeFileSync(event, JSON.stringify({ before }));
    return changedFiles({ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, CI_SCOPE_PUSH_DIFF: flag });
  };
  if (!push(head, undefined).backstop) throw new Error("a push without push-diff skipped the backstop");
  if (push(head, "true").backstop) throw new Error("a push with push-diff was not diffed");
  if (!push("0".repeat(40), "true").backstop) throw new Error("a push with no previous commit did not fail open");
  // A merge group is diffed against its parent, and only when its head is the checkout.
  const group = { merge_group: { base_sha: "a".repeat(40), head_sha: "b".repeat(40) } };
  if (mergeGroupBase(group, "b".repeat(40)) !== "a".repeat(40)) throw new Error("a merge group was not diffed against its parent");
  if (mergeGroupBase(group, "c".repeat(40)) !== undefined) throw new Error("a merge group that is not the checkout was trusted");
  if (mergeGroupBase({}, "b".repeat(40)) !== undefined) throw new Error("an event with no merge group named a base");
  const queued = (payload) => {
    writeFileSync(event, JSON.stringify(payload));
    return changedFiles({ GITHUB_EVENT_NAME: "merge_group", GITHUB_EVENT_PATH: event });
  };
  const own = queued({ merge_group: { base_sha: head, head_sha: head } });
  if (own.backstop || own.files.length) throw new Error("a merge group was not diffed against its base");
  if (!queued({ merge_group: { base_sha: head, head_sha: "c".repeat(40) } }).backstop) {
    throw new Error("a merge group whose head is not the checkout did not fail open");
  }
  if (!queued({}).backstop) throw new Error("a merge group event with no payload did not fail open");
}

async function main(env = process.env) {
  if (env.CI_SCOPE_MODE === "tex-data-only") {
    // For whole jobs gated at the job level: `only` is true when this pull
    // request changes nothing but Tex config and data. A push never is.
    const diff = changedFiles(env);
    const only = !diff.backstop && texDataOnly(diff.files);
    writeOutput("only", String(only), env);
    console.log(only ? `Tex config and data only:\n${diff.files.map((file) => `- ${file}`).join("\n")}` : "Not Tex config and data only");
    return;
  }
  const packages = parseList(env.CI_SCOPE_PACKAGES);
  const paths = parseList(env.CI_SCOPE_PATHS);
  const entries = parseList(env.CI_SCOPE_ENTRIES);
  if (!packages.length && !paths.length && !entries.length) throw new Error("ci-scope needs at least one package, path or entry");
  const diff = changedFiles(env);
  const texData = env.CI_SCOPE_TEX_DATA === "true";
  const result = decide({ packages, paths, entries, changed: diff.files, backstop: diff.backstop, texData });
  writeOutput("affected", String(result.affected), env);
  writeOutput("reason", result.reason.replaceAll("\n", " "), env);
  console.log(`${result.affected ? "RUN" : "SKIP"}: ${result.reason}`);
  if (result.matched.length) console.log(`Matched:\n${result.matched.map((file) => `- ${file}`).join("\n")}`);
  writeSummary([
    `### ${env.GITHUB_JOB || "CI job"} scope`,
    "",
    `${result.affected ? "Runs" : "Skips"}: ${result.reason}.`,
    ...(result.matched.length ? ["", ...result.matched.slice(0, 10).map((file) => `- \`${file}\``)] : []),
  ], env);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log("CI change scope self-test passed");
  } else {
    await main();
  }
}
