#!/usr/bin/env node
/**
 * Decide which staging components a deployment has to touch.
 *
 * Every merge used to deploy Convex, test and deploy all five Workers, rebuild
 * the web app and publish an OTA update, whatever it changed. A merge that only
 * edited CI files spent 8m 40s redeploying code that was already live.
 *
 * This compares the commit being deployed with what staging is actually
 * running and selects the components whose inputs changed.
 *
 * ── WHAT STAGING IS RUNNING ──────────────────────────────────────────────
 *
 * The newest successful `Deploy Staging` run deployed every component it
 * selected, and every earlier success deployed the rest, so staging matches
 * that run's commit. A later run that failed or was cancelled may have
 * deployed some components from its own commit before it stopped, so its
 * commit is a base too. The changed set is the union of the diffs from every
 * one of those commits to this one. A manual run from a branch counts the
 * same way, because it deployed that branch.
 *
 * ── WHAT A COMPONENT IS BUILT FROM ──────────────────────────────────────
 *
 * Package manifests do not describe it: Convex and the app import files from
 * `apps/mcp/src` by relative path. So a component owns its workspace
 * directories, those of the workspace packages it declares, and every file
 * reached by following imports out of them. Tests and READMEs inside those
 * directories do not deploy.
 *
 * ── FAILING SAFE ─────────────────────────────────────────────────────────
 *
 * Every uncertainty deploys everything: no successful run to compare with, a
 * base commit that cannot be fetched, a manual run asking for it, a change to
 * dependencies, this script or the workflow, and any file this script does not
 * recognise. Only paths a target lists as ignored can be skipped without
 * being attributed to a component. Over-deploying costs minutes; under-deploying
 * leaves staging running code nobody can see.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A change to any of these can alter every component, on either target. */
const SHARED_FAN_OUT = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
  "patches/**",
  "scripts/deploy-plan.mjs",
];

/**
 * Paths no component is built from, unless a component reaches them (checked
 * first). Everything else that no component claims deploys everything.
 */
const SHARED_IGNORED = [
  "docs/**",
  ".github/**",
  ".claude/**",
  "scripts/**",
  "plugins/**",
  "artifacts/**",
  "apps/desktop/**",
  "infra/domain-connect/**",
  "packages/encryption-decryptor/**",
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "turbo.json",
  "architecture.config.json",
];

const workflow = (name) => `.github/workflows/${name}.yml`;

/**
 * What each target deploys. A staging `worker` carries what that workflow's
 * matrix needs; the staging app covers both the web export and the OTA
 * update, which bundle the same sources. Production calls one reusable
 * workflow per component, so each one's workflow file is one of its inputs.
 */
export const TARGETS = {
  staging: {
    title: "Staging",
    workflow: "deploy-staging.yml",
    components: {
      convex: { packages: ["@context/convex"], files: ["convex.json", "scripts/staging-env.mjs"] },
      transcribe: { packages: ["@context/transcribe-worker"], worker: "infra/transcribe-worker" },
      egress: { packages: ["@context/egress-service"], worker: "infra/egress-service" },
      email: { packages: ["@context/email-worker"], worker: "infra/email-worker" },
      agent: { packages: ["@context/agent"], worker: "apps/agent" },
      // The gateway's job deploys its screenshot Worker first (a service
      // binding needs its target), so either one changing deploys both.
      mcp: { packages: ["@context/mcp", "@context/site-shots"], worker: "apps/mcp" },
      // Staging publishes the app export inside this Worker's Static Assets
      // version, so an app input is also a router input.
      router: { packages: ["@context/router", "@context/mobile"], worker: "infra/router" },
      app: { packages: ["@context/mobile"], files: ["scripts/build-drawing-editor.mjs"] },
    },
    fanOut: [...SHARED_FAN_OUT, workflow("deploy-staging")],
    // Staging runs no Sentry inbox.
    ignored: [...SHARED_IGNORED, "infra/sentry-worker/**"],
  },
  production: {
    title: "Production",
    workflow: "deploy-production.yml",
    components: {
      convex: { packages: ["@context/convex"], files: ["convex.json", workflow("deploy-convex")] },
      gateway: { packages: ["@context/mcp", "@context/site-shots"], files: [workflow("deploy-mcp")] },
      email: { packages: ["@context/email-worker"], files: [workflow("deploy-email-worker")] },
      transcribe: { packages: ["@context/transcribe-worker"], files: [workflow("deploy-transcribe-worker")] },
      agent: { packages: ["@context/agent"], files: [workflow("deploy-agent-worker")] },
      egress: { packages: ["@context/egress-service"], files: [workflow("deploy-egress-service")] },
      sentry: { packages: ["@context/sentry-worker"], files: [workflow("deploy-sentry-worker")] },
      // The router publishes the web export as one Worker version. Either
      // half changing must rebuild and deploy both halves of that version.
      web: {
        packages: ["@context/mobile", "@context/router"],
        files: ["scripts/build-drawing-editor.mjs", workflow("build-web"), workflow("deploy-router")],
      },
      router: {
        packages: ["@context/mobile", "@context/router"],
        files: ["scripts/build-drawing-editor.mjs", workflow("build-web"), workflow("deploy-router")],
      },
      ota: { packages: ["@context/mobile"], files: [workflow("deploy-mobile-update")] },
    },
    fanOut: [...SHARED_FAN_OUT, workflow("deploy-production")],
    ignored: SHARED_IGNORED,
  },
};

const TEST_SEGMENTS = new Set(["__tests__", "test", "tests"]);
const DOC_NAMES = new Set(["README.md", "CLAUDE.md", "AGENTS.md", "CHANGELOG.md"]);

export function matches(file, pattern) {
  if (pattern.endsWith("/**")) return file.startsWith(pattern.slice(0, -2));
  return file === pattern;
}

/** Tests, the Playwright suite and docs inside a package; never deployed. */
export function isInert(file) {
  const parts = file.split("/");
  const name = parts.at(-1);
  if (DOC_NAMES.has(name)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  if (file.startsWith("apps/mobile/e2e/")) return true;
  return parts.slice(0, -1).some((part) => TEST_SEGMENTS.has(part));
}

function manifests(root) {
  const byName = new Map();
  for (const parent of ["apps", "packages", "infra", "plugins"]) {
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const path = join(base, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      if (manifest.name) byName.set(manifest.name, { dir: `${parent}/${entry.name}`, manifest });
    }
  }
  return byName;
}

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const PLATFORMS = ["web", "native", "ios", "android"];
const SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)\b[^'"]{0,400}?\bfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function sourceFiles(root, dir) {
  const out = [];
  const full = join(root, dir);
  if (!existsSync(full)) return out;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(root, rel));
    else if (SOURCE.test(entry.name) && !isInert(rel)) out.push(rel);
  }
  return out;
}

function fileCandidates(root, base) {
  const found = [];
  for (const suffix of SUFFIXES) found.push(base + suffix);
  for (const index of ["index.ts", "index.tsx", "index.js", "index.mjs"]) found.push(`${base}/${index}`);
  for (const platform of PLATFORMS) for (const ext of [".ts", ".tsx", ".js", ".jsx"]) found.push(`${base}.${platform}${ext}`);
  return found.filter((path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile());
}

/**
 * A component's owned directories and every repository file its sources
 * reach. Importing a workspace package by name claims the whole package, so an
 * import the manifest forgot to declare still counts.
 */
export function componentInputs(component, root = ROOT, byName = manifests(root)) {
  const dirs = new Set();
  const files = new Set();
  const queue = [...(component.files ?? [])];
  const seen = new Set();

  const claimPackage = (name) => {
    const workspace = byName.get(name);
    if (!workspace) throw new Error(`Unknown workspace package ${name}`);
    if (dirs.has(workspace.dir)) return;
    dirs.add(workspace.dir);
    queue.push(...sourceFiles(root, workspace.dir));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dep, version] of Object.entries(workspace.manifest[section] ?? {})) {
        if (String(version).startsWith("workspace:") && byName.has(dep)) claimPackage(dep);
      }
    }
  };
  for (const name of component.packages) claimPackage(name);

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    files.add(file);
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (specifier.startsWith(".")) {
          const base = relative(root, resolve(root, dirname(file), specifier)).replaceAll("\\", "/");
          if (base.startsWith("..")) continue;
          for (const target of fileCandidates(root, base)) queue.push(target);
        } else {
          const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
          if (byName.has(name)) claimPackage(name);
        }
      }
    }
  }
  return { dirs: [...dirs].sort(), files };
}

export function buildGraph(target = "staging", root = ROOT) {
  const byName = manifests(root);
  return Object.fromEntries(
    Object.entries(TARGETS[target].components).map(([name, component]) => [name, componentInputs(component, root, byName)]),
  );
}

function owns(inputs, file) {
  if (inputs.files.has(file)) return true;
  return !isInert(file) && inputs.dirs.some((dir) => file.startsWith(`${dir}/`));
}

/**
 * The components a set of changed files requires, with the reason for each.
 * `full` deploys everything regardless.
 */
export function selectComponents(changed, graph, { full = false, target = "staging" } = {}) {
  const { fanOut, ignored } = TARGETS[target];
  const names = Object.keys(graph);
  const reasons = Object.fromEntries(names.map((name) => [name, []]));
  const everything = (why) => {
    for (const name of names) reasons[name].push(why);
  };
  if (full) everything("full deployment requested");
  for (const file of changed) {
    if (fanOut.some((pattern) => matches(file, pattern))) {
      everything(`${file} can affect every component`);
      continue;
    }
    const owners = names.filter((name) => owns(graph[name], file));
    for (const name of owners) reasons[name].push(file);
    if (owners.length > 0) continue;
    if (isInert(file) || ignored.some((pattern) => matches(file, pattern))) continue;
    everything(`${file} is not attributed to a component`);
  }
  const selected = Object.fromEntries(names.map((name) => [name, reasons[name].length > 0]));
  return { selected, reasons };
}

// ── GitHub and git ─────────────────────────────────────────────────────────

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function hasCommit(sha) {
  try {
    git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commits staging may still be running parts of: every completed run
 * newer than the newest success, and that success. `null` when there is no
 * success to anchor on.
 */
export function baseCommits(runs, currentRunId) {
  const bases = [];
  for (const run of runs) {
    if (Number(run.id) === Number(currentRunId)) continue;
    // A newer run exists: this is a rerun of an old run, and staging may be
    // ahead of the commit it is about to deploy.
    if (Number(run.id) > Number(currentRunId)) return null;
    if (run.status !== "completed") return null;
    bases.push(run.head_sha);
    if (run.conclusion === "success") return [...new Set(bases)];
  }
  return null;
}

async function recentRuns(env, target, request = fetch) {
  const url = new URL(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${TARGETS[target].workflow}/runs`);
  url.search = new URLSearchParams({ per_page: "100", exclude_pull_requests: "true" }).toString();
  const response = await request(url, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`Could not list earlier runs (HTTP ${response.status}).`);
  return (await response.json()).workflow_runs ?? [];
}

async function changedFiles(env, target) {
  if (env.FULL_DEPLOY === "true") return { full: "full deployment requested", files: [] };
  let runs;
  try {
    runs = await recentRuns(env, target);
  } catch (error) {
    return { full: error.message, files: [] };
  }
  const bases = baseCommits(runs, env.GITHUB_RUN_ID);
  if (!bases) return { full: "no earlier successful deployment to compare with", files: [] };
  const files = new Set();
  for (const sha of bases) {
    if (!/^[0-9a-f]{40}$/.test(sha)) return { full: `invalid base commit ${sha}`, files: [] };
    if (!hasCommit(sha)) {
      try {
        git("fetch", "--no-tags", "--quiet", "origin", sha);
      } catch {
        return { full: `base commit ${sha} is not available`, files: [] };
      }
    }
    for (const file of git("diff", "--name-only", "--no-renames", sha, "HEAD").split("\n")) if (file) files.add(file);
  }
  return { full: null, files: [...files].sort(), bases };
}

function summary({ selected, reasons }, { full, files, bases }, target) {
  const lines = [`## ${TARGETS[target].title} deployment plan`, ""];
  if (full) lines.push(`Deploying everything: ${full.replace(/\.$/, "")}.`, "");
  else lines.push(`Compared with ${bases.map((sha) => `\`${sha.slice(0, 7)}\``).join(", ")}: ${files.length} changed files.`, "");
  lines.push("| Component | Deploys | Because |", "| --- | --- | --- |");
  for (const [name, on] of Object.entries(selected)) {
    const why = reasons[name].slice(0, 3).map((r) => `\`${r}\``).join(", ") + (reasons[name].length > 3 ? ` and ${reasons[name].length - 3} more` : "");
    lines.push(`| ${name} | ${on ? "yes" : "no"} | ${on ? why : "unchanged"} |`);
  }
  return `${lines.join("\n")}\n`;
}

function targetArg(argv) {
  const at = argv.indexOf("--target");
  const target = at === -1 ? "staging" : argv[at + 1];
  if (!Object.hasOwn(TARGETS, target)) throw new Error(`Unknown target ${target}`);
  return target;
}

async function main(target) {
  const change = await changedFiles(process.env, target);
  const plan = selectComponents(change.files, buildGraph(target), { full: Boolean(change.full), target });
  if (change.full) for (const name of Object.keys(plan.reasons)) plan.reasons[name] = [change.full];
  const workers = Object.entries(TARGETS[target].components)
    // The router carries the web export as a Static Assets binding and has a
    // dedicated staging job that downloads that artifact. Keeping it out of
    // this matrix lets the other Workers continue deploying while web builds.
    .filter(([name, component]) => component.worker && name !== "router" && plan.selected[name])
    .map(([name, component]) => ({ name, package: component.packages[0], dir: component.worker }));
  const outputs = { ...plan.selected, workers: JSON.stringify(workers), any_worker: String(workers.length > 0) };
  const text = summary(plan, change, target);
  console.log(text);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  const target = targetArg(process.argv);
  const at = process.argv.indexOf("--files");
  if (at !== -1) {
    // Local dry run: `node scripts/deploy-plan.mjs [--target production] --files a b c`.
    const files = process.argv.slice(at + 1);
    console.log(summary(selectComponents(files, buildGraph(target), { target }), { full: null, files, bases: ["local"] }, target));
  } else {
    await main(target);
  }
}
