#!/usr/bin/env node
/**
 * Refreshes `apps/convex/.test-timings.json`, the per-file durations that
 * `scripts/convex-tests.mjs` balances its shards by.
 *
 * Give it the vitest output of every Convex shard from a main run, one log
 * per shard. A job's log comes from the Actions API:
 *
 *   gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs > shard.log
 *
 *   node scripts/convex-test-timings.mjs shard-1.log ... shard-6.log
 *
 * A file's entry is the median of its durations across the logs given. Only
 * files of at least FLOOR_MS are written, because those are the ones a
 * balance depends on; the key `*` holds the median of every file, and the
 * selector weighs any file without an entry at that. The timings only decide which runner takes a file,
 * never which files run, so a stale file costs balance, not coverage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = fileURLToPath(new URL("../apps/convex/.test-timings.json", import.meta.url));

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** The timestamp GitHub puts at the start of every line of a job log. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;
/**
 * A vitest result line: a marker, the test file, `(N tests)` or `(N test)`,
 * then the duration, in milliseconds or seconds, which may be missing.
 */
const RESULT = /^\s*[✓×❯√✗]\s+(\S+\.test\.ts)\s+\(\d+\s+tests?\b[^)]*\)(?:\s+(\d+(?:\.\d+)?)(ms|s))?\s*$/;

/** Each vitest result line in one log, as `{ file, ms }`; a missing duration counts as 0. */
export function parseTimings(text) {
  const samples = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").replace(ANSI, "").replace(TIMESTAMP, "");
    const match = RESULT.exec(line);
    if (!match) continue;
    const [, file, amount, unit] = match;
    const ms = amount === undefined ? 0 : Number(amount) * (unit === "s" ? 1000 : 1);
    samples.push({ file, ms: Math.round(ms) });
  }
  return samples;
}

/** The middle value of a list (the mean of the two middle values for an even count), or null when empty. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `{ "<path relative to apps/convex>": ms }` sorted by key, the median of each file's durations across the logs. */
export function medianTimings(logs) {
  const durations = new Map();
  for (const text of logs) {
    for (const { file, ms } of parseTimings(text)) {
      if (!durations.has(file)) durations.set(file, []);
      durations.get(file).push(ms);
    }
  }
  const keys = [...durations.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(keys.map((file) => [file, Math.round(median(durations.get(file)))]));
}

/** Files faster than this are weighed at the `*` median instead of listed. */
export const FLOOR_MS = 2000;

/** `timings` reduced to `*` (the median of all of them) plus the files of at least `floorMs`. */
export function compactTimings(timings, floorMs = FLOOR_MS) {
  const values = Object.values(timings);
  if (values.length === 0) return {};
  const kept = Object.entries(timings).filter(([, ms]) => ms >= floorMs);
  return { "*": Math.round(median(values)), ...Object.fromEntries(kept) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logs = process.argv.slice(2);
  if (logs.length === 0) {
    console.error("usage: node scripts/convex-test-timings.mjs <shard log>...");
    process.exit(2);
  }
  const all = medianTimings(logs.map((path) => readFileSync(path, "utf8")));
  const count = Object.keys(all).length;
  if (count === 0) {
    console.error("no vitest result lines in those logs; nothing written");
    process.exit(1);
  }
  const timings = compactTimings(all);
  writeFileSync(OUT, `${JSON.stringify(timings, null, 1)}\n`);
  console.log(`Read ${count} file timings from ${logs.length} log(s); wrote the ${Object.keys(timings).length - 1} of at least ${FLOOR_MS} ms and their median to ${OUT}`);
}
