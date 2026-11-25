#!/usr/bin/env node
/**
 * A path's kind is asked of one list, `packages/shared/src/fileKinds.cjs`,
 * never decided by a hard-coded extension test (decided by the owner,
 * 2026-11-25; `docs/decisions/file-kinds.md`).
 *
 * Tex ignored an open sheet because two places only passed `.md`, and an
 * audit found about 150 more: each a `path.endsWith(".md")` written on its
 * own, so a new text type (the `.csv` sheet) had to be added to every one by
 * hand and was missed in most. This check stops the count growing while the
 * existing sites move onto the list.
 *
 * The rule: in source (not tests, benches or generated files), a line of code
 * that tests a path for `.md` or `.csv` with `endsWith(...)` or a `/\.md$/`
 * regex counts. No file may count more than `scripts/file-kinds-baseline.json`
 * allows; a file not in it allows none. A file that counts fewer passes, and
 * `--update` writes the lower counts back so the baseline only shrinks.
 * A Markdown subtype (`.page.md`, `.excalidraw.md`) is not counted: that is a
 * format, not a kind.
 *
 *   node scripts/check-file-kinds.mjs
 *   node scripts/check-file-kinds.mjs --update
 *   node scripts/check-file-kinds.mjs --self-test
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE = join(ROOT, "scripts/file-kinds-baseline.json");
const ROOTS = ["apps", "packages", "infra", "plugins"];
const SOURCE = /\.(?:js|mjs|cjs|ts|tsx)$/;
const SKIP_DIR = new Set(["node_modules", "dist", "build", ".expo", ".wrangler", "test", "tests", "__tests__", "bench", "e2e", "_generated"]);
const SKIP_FILE = /\.(?:test|spec|shots)\.|\.generated\.|\.d\.c?ts$/;

/**
 * Where a literal extension test is the point, with why.
 */
const EXEMPT = new Map([
  ["packages/shared/src/fileKinds.cjs", "the list itself"],
  // Both privacy parsers import nothing, and the control plane's copy is tested
  // against the gateway's text (`apps/convex/functions/lib/privacy.ts`).
  ["apps/mcp/src/privacy/engine.js", "dependency-free privacy engine, evaluated as text by the port's parity tests"],
  ["apps/convex/functions/lib/privacy.ts", "the privacy engine's port, which must match the engine line for line"],
]);

/** `endsWith(".md")`, `endsWith('.csv')`, and `/\.md$/` or `/\.csv$/i` with nothing before the dot. */
const EXTENSION_TEST = /endsWith\(\s*["'`]\.(?:md|csv)["'`]\s*\)|(?<![\w)\]\\])\/\\\.(?:md|csv)\$\/[a-z]*/g;

/** Code lines, so a comment explaining a check is not one. */
export function codeLines(text) {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

/** How many extension tests a file's text holds. */
export function countTests(text) {
  let count = 0;
  for (const line of codeLines(text)) count += (line.match(EXTENSION_TEST) ?? []).length;
  return count;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIR.has(name) && !name.startsWith(".")) walk(full, out);
    } else if (SOURCE.test(name) && !SKIP_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every counted file and its count, keyed by repository path. */
export function survey() {
  const counts = {};
  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const path = relative(ROOT, file).split("\\").join("/");
      if (EXEMPT.has(path)) continue;
      const count = countTests(readFileSync(file, "utf8"));
      if (count > 0) counts[path] = count;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** The files over their allowance, and the ones now under it. */
export function compare(counts, baseline) {
  const over = [];
  const under = [];
  for (const [path, count] of Object.entries(counts)) {
    const allowed = baseline[path] ?? 0;
    if (count > allowed) over.push({ path, count, allowed });
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    const count = counts[path] ?? 0;
    if (count < allowed) under.push({ path, count, allowed });
  }
  return { over, under };
}

function selfTest() {
  const hits = [
    'if (path.endsWith(".md")) return;',
    "if (key.toLowerCase().endsWith('.csv')) {",
    "return /\\.md$/i.test(path);",
    "const name = file.replace(/\\.csv$/, \"\");",
  ];
  const misses = [
    "// path.endsWith(\".md\") is how it used to be asked",
    " * `/\\.md$/` in a comment",
    "if (/\\.page\\.md$/i.test(path)) return;",
    "if (/\\.excalidraw\\.md$/.test(path)) return;",
    "if (isNotePath(path)) return;",
    'if (path.endsWith(".md.bak")) return;',
  ];
  for (const line of hits) if (countTests(line) !== 1) throw new Error(`self-test: should count ${line}`);
  for (const line of misses) if (countTests(line) !== 0) throw new Error(`self-test: should not count ${line}`);
  const { over, under } = compare({ "a.js": 2, "new.js": 1 }, { "a.js": 2, "old.js": 3 });
  if (over.length !== 1 || over[0].path !== "new.js") throw new Error("self-test: a file not in the baseline allows none");
  if (under.length !== 1 || under[0].path !== "old.js") throw new Error("self-test: a file that went away is under");
  console.log("check-file-kinds self-test passed");
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--self-test")) return selfTest();
  const counts = survey();
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const { over, under } = compare(counts, baseline);
  if (args.has("--update")) {
    if (over.length > 0) {
      for (const { path, count, allowed } of over) console.error(`${path}: ${count} extension tests, ${allowed} allowed`);
      console.error("--update only lowers the baseline. Ask packages/shared/src/fileKinds.cjs instead of adding a test.");
      process.exit(1);
    }
    writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`file-kinds baseline: ${Object.values(counts).reduce((a, b) => a + b, 0)} tests in ${Object.keys(counts).length} files`);
    return;
  }
  if (over.length > 0) {
    for (const { path, count, allowed } of over) {
      console.error(`${path}: ${count} hard-coded .md/.csv tests, ${allowed} allowed.`);
    }
    console.error(
      "Ask packages/shared/src/fileKinds.cjs (isNotePath, isSheetPath, isTextFilePath, kindOf) instead; docs/decisions/file-kinds.md.",
    );
    process.exit(1);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`file kinds: ${total} hard-coded extension tests left in ${Object.keys(counts).length} files, none new`);
  if (under.length > 0) console.log(`${under.length} files are under their allowance: node scripts/check-file-kinds.mjs --update lowers it`);
}

main();
