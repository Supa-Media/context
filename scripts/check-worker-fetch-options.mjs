#!/usr/bin/env node
/**
 * No Worker source may ask for `redirect: "error"`.
 *
 * workerd does not implement it: `fetch` rejects with a TypeError *before the
 * request is made*. Both control-plane clients then flatten every throw to
 * "request failed" — deliberately, since the raw error can quote the
 * `Authorization` header — so the call fails identically and invisibly.
 *
 * It shipped twice. It stopped the email worker dead (every inbound message
 * rejected with "worker script threw an exception") and it stopped the MCP
 * gateway dead (every control-plane call 503, so no AI client could even
 * register). The second one was found only because the first had been.
 *
 * Node implements `"error"`, so unit tests with a mocked fetch never notice —
 * which is precisely why this is a source check and not a test.
 *
 * `"manual"` is the correct replacement: a redirect is surfaced as a response
 * rather than followed, and both callers refuse any status that is not 200.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "apps/mcp/src",
  "infra/email-worker/src",
  "infra/router/src",
  // No `fetch` in here today — it reaches Workers AI through a binding rather
  // than the REST API — but a Worker source root missing from this list is one
  // the guard silently stopped covering, and the second occurrence above was
  // found only because somebody went looking after the first.
  "infra/transcribe-worker/src",
];
const BANNED = /redirect:\s*["']error["']/;

/** Comment-stripped, so a rationale naming the banned string is not a hit. */
function code(text) {
  return text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
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

/**
 * Every listed root must exist and hold sources.
 *
 * `walk` returns `[]` for a directory it cannot read, so a root that was
 * renamed or moved leaves this guard printing OK over a tree it no longer
 * looks at — the same silence the header describes, arriving by the other
 * door. A root that scans nothing is a broken guard, not a clean repository.
 */
export function scan(roots = ROOTS) {
  const hits = [];
  for (const root of roots) {
    const files = walk(root);
    if (files.length === 0) throw new Error(`${root} holds no Worker source; this guard is not scanning it`);
    for (const file of files) {
      if (BANNED.test(code(readFileSync(file, "utf8")))) hits.push(file);
    }
  }
  return hits;
}

/** The detector still detects, and the comment-stripper still strips. */
function selfTest() {
  const cases = [
    ['fetch(url, { redirect: "error" })', true],
    ["fetch(url, { redirect:'error' })", true],
    ['fetch(url, { redirect: "manual" })', false],
  ];
  for (const [source, expected] of cases) {
    if (BANNED.test(code(source)) !== expected) throw new Error(`detector is wrong for: ${source}`);
  }
  if (BANNED.test(code('// never ask for redirect: "error" here'))) {
    throw new Error("a comment naming the banned option was read as code");
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
  const hits = scan();
  if (hits.length > 0) {
    console.error('Worker source asks for redirect: "error", which workerd does not implement:\n');
    for (const h of hits) console.error("  " + h);
    console.error('\nUse redirect: "manual" and refuse any non-200 status.');
    process.exit(1);
  }
  console.log('OK — no Worker source asks for redirect: "error".');
}
