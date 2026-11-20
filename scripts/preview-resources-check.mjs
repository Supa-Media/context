#!/usr/bin/env node
/**
 * Fails when a preview gains something scripts/preview-resources.mjs does not
 * account for: a Worker config key, a Worker the deploy makes, a Workflow, or a
 * Cloudflare API family that code a preview runs calls. Every one must be an
 * OWNED kind (with its teardown and gone-check) or a USED one (with the reason
 * it needs none). Run in CI: `node scripts/preview-resources-check.mjs`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsonc, previewSection, SOURCES } from "./preview-config.mjs";
import { PREVIEW_WORKFLOWS, WORKER_DIRS } from "./preview-cleanup.mjs";
import { apiFamily, registryProblems, USED_BINDINGS } from "./preview-resources.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** Code a preview runs, where a Cloudflare API call could create something. */
export const SCANNED = ["apps/convex/functions", "apps/mcp/src", "apps/agent/src", "infra/router/src"];
/** The preview's own scripts, also scanned (the rest of scripts/ never runs against a preview). */
const PREVIEW_SCRIPT = /^preview-.*\.mjs$/;
const CODE = /\.(?:m?js|ts)$/;
const SKIP = /(?:^|\/)(?:node_modules|_generated|__tests__|dist)(?:\/|$)|\.test\.|\.spec\./;

/** The top-level keys of a config's env.preview section. */
export function previewKeys(text, kind) {
  if (kind === "jsonc") return Object.keys(parseJsonc(text)?.env?.preview ?? {});
  const keys = new Set();
  let inTop = false;
  for (const line of previewSection(text, "toml").split("\n")) {
    const header = /^\s*\[\[?env\.preview(?:\.([A-Za-z0-9_]+))?/.exec(line);
    if (header) {
      inTop = header[1] === undefined;
      if (header[1]) keys.add(header[1]);
      continue;
    }
    if (/^\s*\[/.test(line)) {
      inTop = false;
      continue;
    }
    const key = inTop && /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (key) keys.add(key[1]);
  }
  return [...keys];
}

/** Workflow base names (without `-__PREVIEW__`) in a jsonc config's env.preview. */
export function previewWorkflowBases(text) {
  return (parseJsonc(text)?.env?.preview?.workflows ?? []).map((w) => String(w?.name ?? "").replace(/-__PREVIEW__$/, ""));
}

/** The Worker kinds deploy-preview.yml deploys, from `--name "context-<kind>-pr$PR"`. */
export function deployedWorkers(workflowText) {
  return [...new Set([...workflowText.matchAll(/wrangler deploy\b[^\n]*--name "context-([a-z]+)-pr\$PR"/g)].map((m) => m[1]))];
}

/** Every `/accounts/<anything>/<path>` a source text calls, as the path after the account. */
export function accountPaths(text) {
  const out = [];
  for (const match of text.matchAll(/\/accounts\/(?:\$\{[^}]*\}|[A-Za-z0-9_:$-]+)\/([a-z0-9_]+(?:\/[a-z0-9_-]+)*)/g)) out.push(match[1]);
  return out;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(REPO, path);
    if (SKIP.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(name)) out.push(path);
  }
  return out;
}

/** Every problem, as lines naming the file and what is unaccounted for. */
export function problems({ read = (rel) => readFileSync(join(REPO, rel), "utf8"), files } = {}) {
  const found = [...registryProblems()];
  for (const source of SOURCES) {
    const text = read(source.source);
    for (const key of previewKeys(text, source.kind)) {
      if (!(key in USED_BINDINGS)) found.push(`${source.source}: env.preview.${key} is not in scripts/preview-resources.mjs; say whether a preview owns it (and how it is torn down) or only uses it`);
    }
    if (source.id === "agent") {
      const bases = previewWorkflowBases(text).sort();
      if (JSON.stringify(bases) !== JSON.stringify([...PREVIEW_WORKFLOWS].sort())) {
        found.push(`${source.source}: preview workflows ${bases.join(", ")} differ from PREVIEW_WORKFLOWS in scripts/preview-cleanup.mjs (${PREVIEW_WORKFLOWS.join(", ")}), so cleanup would miss one`);
      }
    }
  }
  const deployed = deployedWorkers(read(".github/workflows/deploy-preview.yml")).sort();
  if (JSON.stringify(deployed) !== JSON.stringify(Object.keys(WORKER_DIRS).sort())) {
    found.push(`.github/workflows/deploy-preview.yml deploys Workers ${deployed.join(", ")}, but cleanup deletes ${Object.keys(WORKER_DIRS).join(", ")} (WORKER_DIRS in scripts/preview-cleanup.mjs)`);
  }
  const sources = files ?? [
    ...SCANNED.flatMap((dir) => walk(join(REPO, dir))),
    ...readdirSync(join(REPO, "scripts")).filter((name) => PREVIEW_SCRIPT.test(name) && !SKIP.test(name)).map((name) => join(REPO, "scripts", name)),
  ].map((path) => relative(REPO, path));
  for (const rel of sources) {
    for (const path of accountPaths(read(rel))) {
      if (apiFamily(path) === null) found.push(`${rel}: calls Cloudflare /accounts/…/${path}, a family scripts/preview-resources.mjs does not list; add it to API_FAMILIES as owned (with a teardown) or used`);
    }
  }
  return [...new Set(found)];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const found = problems();
  for (const line of found) console.error(`::error::${line}`);
  if (found.length) process.exit(1);
  console.log("preview resources: every kind a preview creates has a teardown and a gone-check.");
}
