#!/usr/bin/env node
/**
 * TEX IS BECOMING ITS OWN SERVICE, AND THE IMPORTS BETWEEN IT AND THE GATEWAY
 * ARE WHAT HAS TO GO.
 *
 * Decided by the owner, 2026-11-28 (docs/decisions/texting-assistant/tex-service.md):
 * Tex moves out of the gateway Worker into a Worker of its own, deployed from a
 * private repository, and reaches Context only over MCP, as a client.
 * Today the two are one program: Tex's code imports gateway modules directly,
 * and gateway code imports Tex's.
 *
 * This guard holds both directions to a list, `scripts/tex-boundary.json`,
 * of the modules each side imports from the other. The list only shrinks:
 *
 * - an import of a module the list does not name fails (a new tie);
 * - a module the list names that nothing imports any more fails too, so the
 *   entry is deleted in the same pull request that cut the tie.
 *
 * Test files are left out: they may reach across while both sides live here.
 *
 * Run `--self-test` to check the rule itself.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, dirname, sep } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const LIST = "scripts/tex-boundary.json";
const SIDES = {
  texImportsGateway: { from: "packages/tex", into: "apps/mcp/src" },
  gatewayImportsTex: { from: "apps/mcp/src", into: "packages/tex" },
};

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

/** Whether a path is a test file or sits in a test folder. */
export function isTest(path) {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path);
}

/** The relative specifiers in one file's text. */
export function specifiers(text) {
  const out = [];
  for (const match of text.matchAll(SPECIFIER)) if (match[1].startsWith(".")) out.push(match[1]);
  return out;
}

/**
 * The modules under `into` that the files under `from` import, as repo-relative
 * paths. `files` is a list of { path, text } with repo-relative posix paths.
 */
export function crossings(files, from, into) {
  const found = new Map();
  for (const { path, text } of files) {
    if (!path.startsWith(`${from}/`) || isTest(path)) continue;
    for (const spec of specifiers(text)) {
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      if (!target.startsWith(`${into}/`)) continue;
      if (!found.has(target)) found.set(target, new Set());
      found.get(target).add(path);
    }
  }
  return found;
}

/** What is wrong with one side: new modules, and listed ones nothing imports. */
export function compare(found, listed) {
  const allowed = new Set(listed);
  const added = [...found.keys()].filter((module) => !allowed.has(module)).sort();
  const gone = listed.filter((module) => !found.has(module)).sort();
  return { added, gone };
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?[jt]sx?$/.test(name)) out.push(full);
  }
  return out;
}

function selfTest() {
  let bad = 0;
  const check = (ok, what) => {
    if (!ok) {
      bad += 1;
      console.error(`self-test: ${what}`);
    }
  };
  const text = [
    'import { a } from "../../../../apps/mcp/src/tools/session.js";',
    'export { b } from "./local.js";',
    'const c = await import("../../../../apps/mcp/src/vault/fill.js");',
    'import "../../../../apps/mcp/src/side.js";',
    'import x from "@context/collaboration";',
  ].join("\n");
  check(specifiers(text).length === 4, "a static, re-export, dynamic and bare import are all read; a package name is not");
  const files = [
    { path: "packages/tex/gateway/agent/turn.js", text },
    { path: "packages/tex/gateway/agent/turn.test.js", text: 'import "../../../../apps/mcp/src/hidden.js";' },
    { path: "packages/tex/gateway/test/x.js", text: 'import "../../../../apps/mcp/src/hidden.js";' },
    { path: "apps/mcp/src/http/agent.js", text: 'import { run } from "../../../../packages/tex/gateway/agent/production.js";' },
  ];
  const out = crossings(files, "packages/tex", "apps/mcp/src");
  check(out.has("apps/mcp/src/tools/session.js") && out.has("apps/mcp/src/vault/fill.js"), "imports across are found");
  check(!out.has("apps/mcp/src/hidden.js"), "test files are left out");
  check(!crossings(files, "packages/tex", "apps/mcp/src").has("packages/tex/gateway/agent/production.js"), "direction is kept");
  check(crossings(files, "apps/mcp/src", "packages/tex").has("packages/tex/gateway/agent/production.js"), "the other direction is found");
  const { added, gone } = compare(out, ["apps/mcp/src/tools/session.js", "apps/mcp/src/side.js", "apps/mcp/src/old.js"]);
  check(added.length === 1 && added[0] === "apps/mcp/src/vault/fill.js", "a new tie fails");
  check(gone.length === 1 && gone[0] === "apps/mcp/src/old.js", "a cut tie left on the list fails");
  if (bad > 0) process.exit(1);
  console.log("OK — the Tex boundary rule holds on its own cases.");
}

function main() {
  const listed = JSON.parse(readFileSync(join(ROOT, LIST), "utf8"));
  const files = [];
  for (const { from } of Object.values(SIDES)) {
    for (const full of walk(join(ROOT, from))) {
      files.push({ path: relative(ROOT, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
    }
  }
  let failed = false;
  const counts = [];
  for (const [key, { from, into }] of Object.entries(SIDES)) {
    const found = crossings(files, from, into);
    const { added, gone } = compare(found, listed[key] ?? []);
    counts.push(`${found.size} ${from} → ${into}`);
    if (added.length > 0) {
      failed = true;
      console.error(`New imports from ${from} into ${into}. Tex is becoming its own service, so the two sides`);
      console.error("may not grow new ties (docs/decisions/texting-assistant/tex-service.md). Go through an");
      console.error("existing module, or move what you need to the side that uses it:");
      for (const module of added) console.error(`  ${module}  (from ${[...found.get(module)].sort().join(", ")})`);
    }
    if (gone.length > 0) {
      failed = true;
      console.error(`These modules are no longer imported from ${from}. Delete them from ${LIST}.${key}:`);
      for (const module of gone) console.error(`  ${module}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`OK — the Tex boundary holds its list (${counts.join("; ")}), and the list only shrinks.`);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
