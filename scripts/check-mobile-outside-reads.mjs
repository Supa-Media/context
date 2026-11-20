#!/usr/bin/env node

/**
 * apps/mobile tests read files outside the app by path: `readFileSync(join(
 * __dirname, "../../mcp/src/agent/ledger.js"))` reads the gateway. The mobile
 * job runs only when ci.yml's `mobile:` change filter matches a changed file,
 * so PR #3740 (which changed ledger.js) skipped the mobile tests and broke
 * main until it was reverted in #3745.
 *
 * So this lists every file outside apps/mobile that the app names or imports,
 * and fails when that filter does not watch one. It recognises three shapes:
 * a quoted relative literal ("../../mcp/src/x.js"); a join() or resolve() whose
 * first argument is __dirname, import.meta.dirname or a constant bound to one
 * (to a fixpoint) and whose other arguments are string literals; and a
 * straight-quoted repository-absolute literal ("apps/mcp/src/x.js"). A
 * candidate counts only if it exists on disk, which drops fake traversal
 * strings like "../../etc/passwd".
 *
 * Its limit: a path built at runtime from a variable it cannot resolve (a
 * parameter, a computed name, a template with ${...}) is not seen.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { changeFilter, matches } from "./check-ci-path-gates.mjs";
import { componentInputs } from "./deploy-plan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MOBILE = "apps/mobile";
/**
 * The Tex Lab's package: its page runs inside the app, and its tests run in the app's jest (`roots` in
 * apps/mobile/jest.config.js), so what they read counts as the app's reads. Its own files are watched whole
 * (`packages/lab/**` in the mobile filter).
 */
const LAB = "packages/lab";
const inside = (rel) => rel === MOBILE || rel.startsWith(`${MOBILE}/`) || rel === LAB || rel.startsWith(`${LAB}/`);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const RENDERER = /\.render\.tsx?$/;
const SKIP_DIRS = new Set(["node_modules", "ios", "android", "web-build", "dist"]);
// Not run by jest; e2e has its own browser workflow filter.
const SKIP_TOP = new Set([`${MOBILE}/scripts`, `${MOBILE}/e2e`]);
/**
 * Paths the app names that it does not read, each with where and why. Watching
 * them would only run the suite more; listing them keeps the filter honest.
 */
const NOT_READS = {
  "apps/mcp/bench/ai/workspaces/maya/**": "texLabTestsRunCompare.test.ts expects this text on screen",
  "docs/decisions/encryption.md": "advanced.ts shows it as the spec a setting follows",
};
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.js"];

// `const NAME = join(BASE, "lit", ...)` and any `join(BASE, "lit", ...)` call.
// The argument list allows newlines and a trailing comma.
const BINDING = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:join|resolve)\(\s*(__dirname|import\.meta\.dirname|[A-Za-z_$][\w$]*)\s*((?:,\s*(?:"[^"\n]*"|'[^'\n]*')\s*)*),?\s*\)/g;
const CALL = /(?<![\w$.])(?:path\.)?(?:join|resolve)\(\s*(__dirname|import\.meta\.dirname|[A-Za-z_$][\w$]*)\s*((?:,\s*(?:"[^"\n]*"|'[^'\n]*')\s*)*),?\s*\)/g;

// A module specifier, as deploy-plan.mjs reads them: these run, so what they
// import runs too. A path handed to readFileSync is read as text and stops there.
const IMPORT = /(?:\bfrom\s*|(?:^|\n)\s*import\s*|\brequire\(\s*|\bimport\(\s*|\bjest\.(?:mock|requireActual)\(\s*)["'](\.{1,2}\/[^"'\n]+)["']/g;

const literals = (args) => [...args.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((m) => m[1] ?? m[2]);

/** The outside paths one file imports as modules (a subset of what it names). */
export function importedOutsidePaths(file, source, root = ROOT) {
  const imported = [...source.matchAll(IMPORT)].map(([, specifier]) => `"${specifier}"`).join("\n");
  return namedOutsidePaths(file, imported, root).filter((path) => !path.endsWith("/**"));
}

/** The repo-relative paths outside apps/mobile that one file names; a directory is `dir/**`. */
export function namedOutsidePaths(file, source, root = ROOT) {
  const dir = dirname(join(root, file));
  const bindings = new Map();
  for (const [, name, base, args] of source.matchAll(BINDING)) bindings.set(name, { base, args: literals(args) });

  // Constants resolve to a fixpoint: one may be bound from a later one.
  const values = new Map();
  const baseOf = (base) => (base === "__dirname" || base === "import.meta.dirname" ? dir : values.get(base));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, { base, args }] of bindings) {
      const start = baseOf(base);
      if (values.has(name) || start === undefined) continue;
      values.set(name, resolve(start, ...args));
      grew = true;
    }
  }

  const found = new Set();
  for (const [, , literal] of source.matchAll(/(["'`])(\.{1,2}\/[^"'`\n]*)\1/g)) {
    if (!literal.includes("${")) found.add(resolve(dir, literal));
  }
  for (const [, base, args] of source.matchAll(CALL)) {
    const start = baseOf(base);
    if (start !== undefined) found.add(resolve(start, ...literals(args)));
  }
  for (const [, , literal] of source.matchAll(/(["'])((?:apps|packages|infra|plugins|scripts|docs|tests|\.github)\/[\w./-]+)\1/g)) {
    found.add(resolve(root, literal));
  }

  const out = new Set();
  for (const abs of found) {
    const rel = relative(root, abs).replaceAll("\\", "/");
    if (rel.startsWith("..") || inside(rel) || ["", ".", "apps"].includes(rel)) continue;
    for (const suffix of SUFFIXES) {
      const path = join(root, rel + suffix);
      if (!existsSync(path)) continue;
      out.add(statSync(path).isDirectory() ? `${rel}${suffix}/**` : `${rel}${suffix}`);
      break;
    }
  }
  // A directory the file also reads files under is a base it joins onto
  // (`const root = join(__dirname, "../../convex/functions")`), not a scan.
  const named = [...out];
  return named
    .filter((path) => !path.endsWith("/**") || !named.some((other) => other !== path && other.startsWith(path.slice(0, -2))))
    .filter((path) => !(path in NOT_READS))
    .sort();
}

/** The app's source files, repo-relative, skipping what jest never runs. */
function mobileSources(root, dir = MOBILE) {
  const out = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || SKIP_TOP.has(path)) continue;
      out.push(...mobileSources(root, path));
    } else if (SOURCE.test(entry.name) && !RENDERER.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every path outside apps/mobile the app reads or imports: what it names
 * directly, and what the modules it imports from outside import in turn.
 */
export function mobileOutsideReads(root = ROOT) {
  const reads = new Set();
  const imported = new Set();
  for (const file of [...mobileSources(root), ...mobileSources(root, LAB)]) {
    const source = readFileSync(join(root, file), "utf8");
    for (const read of namedOutsidePaths(file, source, root)) reads.add(read);
    for (const path of importedOutsidePaths(file, source, root)) imported.add(path);
  }
  const { files, dirs } = componentInputs({ packages: [], files: [...imported] }, root);
  for (const file of files) if (!inside(file)) reads.add(file);
  // A workspace package imported by name claims its whole directory.
  for (const dir of dirs) if (!inside(dir)) reads.add(`${dir}/**`);
  return [...reads].sort();
}

/** The reads no pattern in `watched` covers; a directory is sampled by one file. */
export function unwatchedReads(reads, watched) {
  return reads.filter((read) => {
    const sample = read.endsWith("/**") ? `${read.slice(0, -3)}/sample.ts` : read;
    return ![...watched].some((pattern) => matches(sample, pattern));
  });
}

/** Every read must be watched by ci.yml's mobile change filter. */
export function assertReadsWatched(reads, watched) {
  const missing = unwatchedReads(reads, watched);
  if (missing.length) {
    throw new Error(`apps/mobile reads ${missing.join(", ")} outside the app, but ci.yml's mobile change filter does not watch it; a change there would skip Test Mobile App (node scripts/check-mobile-outside-reads.mjs --filter prints the lines to add)`);
  }
}

function mobileFilter(root) {
  return changeFilter(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"), "mobile");
}

export function check(root = ROOT) {
  assertReadsWatched(mobileOutsideReads(root), mobileFilter(root));
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
  const file = `${MOBILE}/__tests__/x.test.ts`;
  const cases = [
    ['readFileSync(join(__dirname, "../../mcp/src/agent/ledger.js"), "utf8")', ["apps/mcp/src/agent/ledger.js"]],
    ['join(__dirname, "..", "..", "mcp", "src", "session.js")', ["apps/mcp/src/session.js"]],
    ['const repoRoot = resolve(__dirname, "..", "..", ".."); readFileSync(join(repoRoot, "infra", "router", "src", "homeSite.ts"))', ["infra/router/src/homeSite.ts"]],
    ['const mobileRoot = resolve(__dirname, ".."); const repoRoot = resolve(mobileRoot, "..", "..");\nreadFileSync(join(repoRoot, "scripts", "check-agent-path-imports.mjs"))', ["scripts/check-agent-path-imports.mjs"]],
    ['readFileSync(join(\n  __dirname, "..", "..", "convex", "functions", "lib", "consentScopes.ts",\n))', ["apps/convex/functions/lib/consentScopes.ts"]],
    ['import { x } from "../../../packages/shared/src/websiteMetadata";', ["packages/shared/src/websiteMetadata.ts"]],
    ['const TESTED = ["apps/mcp/src/session.js"];', ["apps/mcp/src/session.js"]],
    ['const root = join(__dirname, "../../convex/functions");\nreadFileSync(join(root, "textLinks.ts"))', ["apps/convex/functions/textLinks.ts"]],
    ['fs.readdirSync(join(__dirname, "../../../.github/workflows"))', [".github/workflows/**"]],
    ['const evil = "../../etc/passwd";', []],
    ['import { a } from "../features/x";', []],
  ];
  for (const [source, expected] of cases) {
    const actual = namedOutsidePaths(file, source);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`namedOutsidePaths(${JSON.stringify(source)}) gave ${JSON.stringify(actual)}`);
    }
  }
  expectFailure(
    "a read the mobile filter does not watch",
    () => assertReadsWatched(["apps/mcp/src/agent/ledger.js"], new Set(["apps/mobile/**"])),
    "ledger.js",
  );
  const reads = mobileOutsideReads();
  for (const read of ["apps/mcp/src/agent/ledger.js", "packages/tex/worker/stepEvents.ts"]) {
    if (!reads.includes(read)) throw new Error(`mobileOutsideReads() does not include ${read}`);
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log("Mobile outside reads self-test OK");
  } else if (process.argv.includes("--list")) {
    for (const read of mobileOutsideReads()) console.log(read);
  } else if (process.argv.includes("--filter")) {
    for (const read of unwatchedReads(mobileOutsideReads(), mobileFilter(ROOT))) console.log(`          - '${read}'`);
  } else {
    check();
    console.log("Mobile outside reads OK");
  }
}
