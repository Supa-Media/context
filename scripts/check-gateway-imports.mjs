#!/usr/bin/env node
/**
 * The gateway may only import its own files.
 *
 * `apps/mcp` is the piece users self-host: dependency-free, running on the
 * Cloudflare Workers runtime where Node built-ins do not exist. A `node:`
 * import typechecks and passes the in-memory test stub, then fails at the edge
 * on real traffic. And with `shamefully-hoist=true`, a package installed
 * anywhere in the workspace hoists to the root `node_modules`, so a bare
 * import from `apps/mcp/src` would resolve, bundle and ship without ever
 * appearing in `apps/mcp/package.json`. Requiring every specifier to be
 * relative catches both, and everything else of that shape.
 *
 * This began as a grep in the workflow and produced a false positive on the
 * first file that discussed imports in prose — a comment reading
 * `… from "not yours"` matched. Hence a real parser-ish pass that strips
 * comments and only looks at statement positions, and hence the self-test
 * below: a guard without one is a guard nobody has checked.
 *
 *   node scripts/check-gateway-imports.mjs [dir]   # default apps/mcp/src
 *   node scripts/check-gateway-imports.mjs --self-test
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Remove comments without mangling string literals.
 *
 * Walks the source once tracking whether we are inside a string, a template,
 * a line comment or a block comment. Naive regex stripping breaks on the very
 * thing this file exists to check — `"https://…"` contains `//`.
 */
export function stripComments(source) {
  let out = "";
  let i = 0;
  let state = "code";
  let quote = "";

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") { state = "string"; quote = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }

    if (state === "string") {
      if (c === "\\") { out += c + (next ?? ""); i += 2; continue; }
      if (c === quote) { state = "code"; quote = ""; }
      out += c; i += 1; continue;
    }

    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; }
      i += 1; continue;
    }

    // block
    if (c === "*" && next === "/") { state = "code"; i += 2; continue; }
    if (c === "\n") out += c; // keep line numbers honest
    i += 1;
  }

  return out;
}

/** Every module specifier that appears in a real statement position. */
export function findSpecifiers(source) {
  const code = stripComments(source);
  const found = [];
  const patterns = [
    // import x from "y" / export { x } from "y" / import "y"
    //
    // The clause may span lines — a multi-line `import {\n  a,\n  b,\n} from`
    // is ordinary formatting, and an earlier version of this pattern excluded
    // \n and so missed every one of them. Bounded and non-greedy so it cannot
    // run away across unrelated statements; `;` still terminates.
    /^[ \t]*(?:import|export)\b[^;]{0,400}?from[ \t\n]*["']([^"']+)["']/gm,
    /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
    // dynamic import and require, anywhere
    /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g,
    /\brequire[ \t]*\([ \t]*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const before = code.slice(0, match.index);
      found.push({ specifier: match[1], line: before.split("\n").length });
    }
  }
  return found;
}

const isRelative = (specifier) => specifier.startsWith("./") || specifier.startsWith("../");

/**
 * `--allow-node-builtins` widens the rule from "relative only" to "relative or
 * a `node:` built-in", for the one thing in this repo that is a Node program
 * rather than a Worker: `packages/hook`, which people run on their own laptop.
 *
 * The invariant that matters is the same in both places and is **not** "no
 * `node:`" — it is **no third party**. A package hoisted to the workspace root
 * resolves without ever appearing in the package's own manifest, so a
 * dependency can arrive in something published to npm without anybody adding
 * one. Keeping `node:` forbidden by default is what protects the gateway, where
 * the built-ins genuinely do not exist at runtime; the flag says "this one runs
 * on Node" out loud rather than dropping the check.
 */
const isNodeBuiltin = (specifier) => specifier.startsWith("node:");

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(js|mjs|ts)$/.test(entry)) files.push(full);
  }
  return files;
}

function selfTest() {
  const cases = [
    // The flag widens the rule to node: built-ins and nothing else. Asserted
    // here so "allow Node" cannot quietly become "allow anything".
    ['import fs from "node:fs";', true, "node builtin under --allow-node-builtins", true],
    ['import { z } from "zod";', false, "third party under --allow-node-builtins", true],
    ['import crypto from "crypto";', false, "legacy specifier under --allow-node-builtins", true],
    ['import fs from "node:fs";', false, "named node import"],
    ['import fs\n  from "node:fs";', false, "multi-line import"],
    ['import "node:crypto";', false, "bare side-effect import"],
    ['const m = await import("node:fs");', false, "dynamic import"],
    ['import crypto from "crypto";', false, "legacy specifier"],
    ['const z = require("zod");', false, "require"],
    ['import { z } from "zod";', false, "third-party package"],
    ['export { thing } from "some-pkg";', false, "re-export"],
    ['import { R2Store } from "./store/r2.js";', true, "relative import"],
    ['import { x } from "../lib/y.js";', true, "parent-relative"],
    ['export { a } from "./a.js";', true, "relative re-export"],
    // the false positive that prompted this file
    ['// returns the same answer as "not yours"\n// distinct from "that one"', true, "prose in a line comment"],
    ['/*\n * from "not yours" — byte-identical\n */', true, "prose in a block comment"],
    ['const url = "https://example.com/a//b";', true, "url containing slashes"],
    ['const msg = "import x from \\"zod\\"";', true, "import-shaped string literal"],
  ];

  let failed = 0;
  for (const [source, shouldPass, label, allowNode = false] of cases) {
    const offenders = findSpecifiers(source).filter(
      (f) => !isRelative(f.specifier) && !(allowNode && isNodeBuiltin(f.specifier))
    );
    const passed = offenders.length === 0;
    if (passed !== shouldPass) {
      failed += 1;
      console.error(`  FAIL  ${label} — expected ${shouldPass ? "clean" : "caught"}, got ${passed ? "clean" : "caught"}`);
    } else {
      console.log(`  ok    ${label}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} self-test case(s) failed — the guard is not doing what it claims.`);
    process.exit(1);
  }
  console.log("\nSelf-test passed.");
}

const args = process.argv.slice(2);
const allowNode = args.includes("--allow-node-builtins");
const targets = args.filter((value) => !value.startsWith("--"));
if (args.includes("--self-test")) {
  selfTest();
} else {
  const dirs = targets.length ? targets : ["apps/mcp/src"];
  for (const dir of dirs) checkDirectory(dir, allowNode);
}

function checkDirectory(dir, allowNode) {
  let statInfo;
  try {
    statInfo = statSync(dir);
  } catch {
    console.error(`${dir} not found — has the layout moved?`);
    process.exit(1);
  }
  if (!statInfo.isDirectory()) {
    console.error(`${dir} is not a directory.`);
    process.exit(1);
  }

  const offenders = [];
  for (const file of walk(dir)) {
    const source = readFileSync(file, "utf8");
    for (const { specifier, line } of findSpecifiers(source)) {
      if (isRelative(specifier)) continue;
      if (allowNode && isNodeBuiltin(specifier)) continue;
      offenders.push(`${file}:${line}  ${specifier}`);
    }
  }

  if (offenders.length > 0) {
    console.error(offenders.join("\n"));
    console.error("");
    console.error(
      allowNode
        ? `${dir} may only import relative paths and node: built-ins.`
        : `${dir} may only import relative paths.`
    );
    console.error("");
    if (!allowNode) {
      console.error("It runs on the Cloudflare Workers runtime, where Node built-ins do not");
      console.error("exist — a 'node:' import typechecks and passes the in-memory test stub,");
      console.error("then fails at the edge on real traffic.");
    }
    console.error("And a third-party package hoisted to the workspace root would resolve");
    console.error("here without ever appearing in that package's own manifest.");
    process.exit(1);
  }
  console.log(
    allowNode
      ? `OK — every specifier in ${dir} is relative or a node: built-in.`
      : `OK — every specifier in ${dir} is relative.`
  );
}
