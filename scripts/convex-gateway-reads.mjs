#!/usr/bin/env node
/**
 * Which gateway files the control-plane suite can read, and which of its tests
 * read the whole gateway.
 *
 * `ci / Test Convex Backend` used to watch all of `apps/mcp/**`, because Convex
 * code and tests import gateway modules by relative path. It is the longest
 * check on a pull request (four minutes across three shards), and it ran on
 * every texting-assistant fix, although nothing in `apps/convex` reaches
 * `apps/mcp/src/agent/` or the gateway's own tests (2026-10-20). So the convex
 * filter in `ci.yml` names the gateway files Convex actually reaches, and
 * `check-ci-path-gates.mjs` fails when it stops covering what this derives:
 *
 * - every `apps/mcp` file reached by following imports out of every file in
 *   `apps/convex` (functions, helpers and tests alike; deploy-plan's walk);
 * - every `apps/mcp` file a Convex file names by a path literal, relative
 *   (`../../mcp/src/index.js`) or repository-absolute (`"apps/mcp/src/x.js"`).
 *
 * A path literal that names a directory or a glob (`import.meta.glob(
 * "../../mcp/src/**\/*.js")`) reads the whole gateway, and no filter short of
 * `apps/mcp/src/**` covers it. Those files are the scanners: the tests that
 * are them, or import a helper that is, run in Gateway Contracts on every
 * gateway change instead (`--scanner-tests` prints them), which takes seconds.
 *
 * It fails toward running the suite: a Convex import of a workspace package by
 * name claims the whole package, so a Convex file importing `@context/mcp`
 * would require `apps/mcp/**` back.
 */
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { componentInputs } from "./deploy-plan.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX = "apps/convex";
const GATEWAY = "apps/mcp/";
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function sources(root, dir) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sources(root, path));
    else if (SOURCE.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Every gateway path one file names in code: the repository path it resolves
 * to, and whether that is one file or more than one (a directory or a glob).
 */
export function namedGatewayPaths(file, source, root = ROOT) {
  // Comments are not stripped (a glob's `/**/` reads as one), so the two
  // shapes are told apart the way gateway-contract-tests.mjs does: a relative
  // path is a code artifact, in any quote, template literals included; a
  // repository path counts only straight-quoted, because prose names one in
  // backticks on every other line here. Prose that slips through only runs
  // more, which is the cheap mistake.
  const named = [];
  for (const [, literal] of source.matchAll(/["'`]((?:\.\.?\/)+[^"'`\n]*?mcp\/[^"'`\n]*)["'`]/g)) {
    named.push(relative(root, resolve(root, dirname(file), literal)).replaceAll("\\", "/"));
  }
  for (const [, literal] of source.matchAll(/["'](apps\/mcp\/[\w./*-]*)["']/g)) named.push(literal);
  return named
    .filter((path) => path.startsWith(GATEWAY))
    .map((path) => {
      const clean = path.replace(/\?.*$/, "");
      const isFile = !clean.includes("*") && existsSync(join(root, clean)) && statSync(join(root, clean)).isFile();
      return { path: clean, whole: !isFile };
    });
}

export function convexGatewayReads(root = ROOT) {
  const convexFiles = sources(root, CONVEX);
  const files = new Set();
  const scanners = new Set();
  const { files: reached, dirs } = componentInputs({ packages: [], files: convexFiles }, root);
  if (dirs.some((dir) => `${dir}/`.startsWith(GATEWAY))) scanners.add(`${CONVEX} imports the gateway package by name`);
  for (const file of reached) if (file.startsWith(GATEWAY)) files.add(file);
  for (const file of convexFiles) {
    for (const { path, whole } of namedGatewayPaths(file, readFileSync(join(root, file), "utf8"), root)) {
      if (whole) scanners.add(file);
      else files.add(path);
    }
  }
  return { files: [...files].sort(), scanners: [...scanners].sort() };
}

/** The scanners that are tests, and the tests that import a scanner helper. */
export function scannerTests(root = ROOT, { scanners } = convexGatewayReads(root)) {
  const tests = new Set(scanners.filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file)));
  const helpers = scanners.filter((file) => !tests.has(file)).map((file) => basename(file).replace(SOURCE, ""));
  if (helpers.length > 0) {
    for (const file of sources(root, CONVEX)) {
      if (!/\.test\.[cm]?[jt]sx?$/.test(file)) continue;
      const code = readFileSync(join(root, file), "utf8");
      if (helpers.some((name) => new RegExp(`["'][^"']*/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.[jt]s)?["']`).test(code))) tests.add(file);
    }
  }
  return [...tests].sort();
}

/**
 * The watch list `ci.yml` carries, for pasting: a directory as `dir/**`, except
 * under `tools/`, which the texting assistant's own tools share with the ones
 * Convex imports, so each reached file there is named.
 */
export function suggestedFilter(files) {
  const patterns = new Set();
  for (const file of files) {
    const parts = file.split("/");
    if (parts.length <= 4 || file.startsWith("apps/mcp/src/tools/") || file.startsWith("apps/mcp/test/")) patterns.add(file);
    else patterns.add(`${parts.slice(0, 4).join("/")}/**`);
  }
  return [...patterns].sort();
}

function selfTest() {
  const file = "apps/convex/__tests__/x.test.ts";
  const probe = (source) => namedGatewayPaths(file, source, ROOT);
  const cases = [
    ['import { a } from "../../mcp/src/privacy/engine.js";', [{ path: "apps/mcp/src/privacy/engine.js", whole: false }]],
    ['const all = import.meta.glob("../../mcp/src/**/*.js", { eager: true });', [{ path: "apps/mcp/src/**/*.js", whole: true }]],
    ['const FILES = ["apps/mcp/src"];', [{ path: "apps/mcp/src", whole: true }]],
    ['readFileSync(join(ROOT, "apps/mcp/test/test.mjs"))', [{ path: "apps/mcp/test/test.mjs", whole: false }]],
    // Prose names repository paths in backticks; that is not a read.
    [" * The gateway's `apps/mcp/src/agent/route.js` is what this mirrors.", []],
    [" * `apps/mcp/src`, `packages/*` is treated like a package", []],
    ['import { x } from "./local";', []],
  ];
  for (const [source, expected] of cases) {
    const actual = probe(source);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`namedGatewayPaths(${JSON.stringify(source)}) gave ${JSON.stringify(actual)}`);
    }
  }
  const { files, scanners } = convexGatewayReads();
  // The facts this file exists for, measured on 2026-10-20: Convex reaches
  // the privacy engine and reads the gateway whole in at least two places,
  // and it reaches nothing of the texting assistant.
  if (!files.includes("apps/mcp/src/privacy/engine.js")) throw new Error("the walk no longer reaches the privacy engine");
  if (scanners.length < 2) throw new Error(`only ${scanners.length} whole-gateway readers found`);
  if (scannerTests().length < 2) throw new Error("no test runs the whole-gateway readers");
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log("convex-gateway-reads self-test OK");
  } else if (process.argv.includes("--scanner-tests")) {
    // Relative to apps/convex, where vitest runs.
    for (const file of scannerTests()) console.log(relative(CONVEX, file));
  } else if (process.argv.includes("--filter")) {
    for (const pattern of suggestedFilter(convexGatewayReads().files)) console.log(`          - '${pattern}'`);
  } else {
    const { files, scanners } = convexGatewayReads();
    console.log(JSON.stringify({ files, scanners }, null, 2));
  }
}
