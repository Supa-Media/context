#!/usr/bin/env node
/**
 * Every Durable Object we create is placed in eastern North America
 * (decided by the owner, 2026-11-01).
 *
 * An object is placed once, near whatever first asks for it, and it never
 * moves. Tex's objects were asked for without a location hint, the first calls
 * to the six busiest came from gateway requests that ran in London on
 * 2026-10-31, and so those objects live in London and Amsterdam while the
 * gateway runs in Virginia: every call to them crosses the Atlantic and back.
 * A missing hint costs nothing in a test and is permanent in production, which
 * is why this is a source check.
 *
 * The rule: a stub is made only in a file listed in `PLACERS`, and there every
 * line that makes one names `locationHint`. Anywhere else, `idFromName(`,
 * `idFromString(` or `getByName(` in code fails the check.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "apps/mcp/src",
  "apps/agent/src",
  "infra/egress-service/src",
  "infra/email-worker/src",
  "infra/router/src",
  "infra/sentry-worker/src",
  "infra/site-shots/src",
  "infra/transcribe-worker/src",
];

/** The only files that make stubs, one place per Worker. */
const PLACERS = new Set([
  "apps/mcp/src/objectPlace.js",
  "apps/agent/src/objectPlace.ts",
  "infra/egress-service/src/handler.ts",
  "infra/sentry-worker/src/worker.js",
  "infra/site-shots/src/idle.ts",
]);

const MAKES_ID = /\b(idFromName|idFromString|getByName)\s*\(/;
/** A line that hands an id to a namespace, or asks one for a stub by name. */
const MAKES_STUB = /\.get\(\s*(\w+\.)*(idFromName|idFromString)\(|\.get\(\s*(id|parsed)\b|\bgetByName\s*\(/;

/** Comment-stripped lines, so a rationale naming the calls is not a hit. */
function codeLines(text) {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
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
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** The problems in one file's text, as sentences. */
export function problemsIn(file, text, placers = PLACERS) {
  const problems = [];
  for (const line of codeLines(text)) {
    if (!placers.has(file)) {
      if (MAKES_ID.test(line)) problems.push(`${file}: makes a Durable Object id outside the place helper: ${line.trim()}`);
    } else if (MAKES_STUB.test(line) && !/locationHint/.test(line)) {
      problems.push(`${file}: makes a stub without locationHint: ${line.trim()}`);
    }
  }
  return problems;
}

/** Every root must exist and hold sources, or the guard is silently scanning nothing. */
export function scan(roots = ROOTS) {
  const problems = [];
  for (const root of roots) {
    const files = walk(root);
    if (files.length === 0) throw new Error(`${root} holds no Worker source; this guard is not scanning it`);
    for (const file of files) problems.push(...problemsIn(file, readFileSync(file, "utf8")));
  }
  return problems;
}

/** The detector still detects. */
function selfTest() {
  const placers = new Set(["a/place.js"]);
  const cases = [
    ["b/x.js", "const s = ns.get(ns.idFromName(name));", true],
    ["b/x.js", "const s = env.EGRESS.getByName(\"one\");", true],
    ["b/x.js", "// ns.idFromName(name) is how ids are made", false],
    ["b/x.js", "const s = objectByName(ns, name);", false],
    ["a/place.js", "return ns.get(ns.idFromName(name));", true],
    ["a/place.js", "return ns.get(ns.idFromName(name), { locationHint: HINT });", false],
    ["a/place.js", "const id = ns.idFromName(name);", false],
    ["a/place.js", "return ns.get(id).fetch(url);", true],
  ];
  for (const [file, source, bad] of cases) {
    if ((problemsIn(file, source, placers).length > 0) !== bad) throw new Error(`detector is wrong for ${file}: ${source}`);
  }
  let threw = false;
  try {
    scan(["infra/no-such-worker/src"]);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("a root that scans nothing was accepted");
  console.log("OK — self-test passed.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const problems = scan();
  if (problems.length > 0) {
    console.error("A Durable Object stub is made without the eastern North America hint:\n");
    for (const problem of problems) console.error("  " + problem);
    console.error("\nMake it through the Worker's objectPlace helper (apps/mcp/src/objectPlace.js, apps/agent/src/objectPlace.ts).");
    process.exit(1);
  }
  console.log("OK — every Durable Object stub is placed in eastern North America.");
}
