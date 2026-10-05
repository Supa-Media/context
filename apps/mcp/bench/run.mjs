/**
 * The search baseline (docs/design/link-graph/PLAN.md, Phase 0): today's
 * bucket search (B0) and the Fast Search projection (B5) over the same
 * synthetic corpus and judged queries.
 *
 * **Not part of `pnpm test`.** It builds a 10,000-note index and waits on
 * injected store latency, which is minutes rather than a suite check. The
 * arithmetic it rests on is checked in `test/benchHarness.test.mjs`.
 *
 *   pnpm --filter @context/mcp bench:search                    # 100 and 1,000 notes
 *   pnpm --filter @context/mcp bench:search -- --sizes 10000
 *   pnpm --filter @context/mcp bench:search -- --latency 20 --d1-latency 60
 *   pnpm --filter @context/mcp bench:search -- --census ~/notes
 *
 * B0 runs the real `syncShardedIndex` and `searchIndexedNotes` against an
 * in-memory bucket that sleeps `--latency` ms per operation. B5 runs the real
 * projection SQL (`project.js`, `query.js`, `serve.js`) against `node:sqlite`,
 * which ships the FTS5 D1 runs, with a client that sleeps `--d1-latency` ms per
 * request. Both latencies are assumptions until replaced by staging numbers.
 *
 * Neither engine caches anything between queries in one isolate, so "cold" is
 * each query's first run and "warm" its second: the difference is the
 * JavaScript engine warming up, not a cache.
 *
 * `--census <dir>` counts the Markdown files under a local folder by the
 * scripts they use. It reads files and prints counts; nothing leaves the
 * machine.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createSearchBudget } from "../src/search/maintain.js";
import { syncShardedIndex } from "../src/search/shards.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { projectNote, upsertStatements } from "../src/search/d1/project.js";
import { answerFromProjection } from "../src/search/d1/serve.js";
import { generateCorpus } from "./fixtures.js";
import { mean, ndcgAt, percentile, recallAt, reciprocalRank } from "./metrics.js";

const encoder = new TextEncoder();
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
}

/* -- B0: the bucket index ------------------------------------------------ */

/** The in-memory bucket of `test/bench/shardSizing.mjs`, with latency. */
function createBucket(latency) {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      await sleep(latency);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => encoder.encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      await sleep(latency);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      await sleep(latency);
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      await sleep(latency);
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: encoder.encode(stored.body).length, uploaded: stored.uploaded, etag: stored.etag });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return { objects: page, delimitedPrefixes: [...prefixes], truncated, cursor: truncated ? keys[index - 1] : undefined };
    },
    setLatency(ms) {
      latency = ms;
    },
  };
}

async function buildB0(notes, latency, budget) {
  const bucket = createBucket(0);
  for (const note of notes) bucket.seed(note.path, note.text);
  // Built without latency: the build is not what is being measured, and at
  // 10,000 notes it would be most of the run.
  let passes = 0;
  for (; passes < 400; passes += 1) {
    const pass = await syncShardedIndex(bucket, { budget: createSearchBudget(budget) });
    if (pass.pending === 0 && !pass.listingTruncated) break;
  }
  bucket.setLatency(latency);
  return {
    passes: passes + 1,
    async search(query) {
      const spend = createSearchBudget(budget);
      const answer = await searchIndexedNotes(bucket, {
        isVisible: () => true,
        isIndexable: (key) => key.endsWith(".md"),
        query,
        budget: spend,
        // As production runs it (src/search/visibleNotes.js): an empty answer
        // over a converged index buys a listing and asks again.
        refreshOnMiss: true,
      });
      return { paths: (answer.hits ?? []).map((hit) => hit.key), subrequests: spend.spent };
    },
  };
}

/* -- B5: the Fast Search projection -------------------------------------- */

/** The schema in `test/searchD1.test.mjs`, kept in step with `lib/d1.ts`. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (
     path TEXT PRIMARY KEY, version TEXT NOT NULL, visibility TEXT NOT NULL,
     title TEXT NOT NULL, uploaded TEXT, chunks INTEGER NOT NULL,
     indexed_at TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_private_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_team_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2')`,
];

function buildB5(notes, latency, budget) {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  for (const note of notes) {
    const projected = projectNote(note.path, { version: "v1", uploaded: null, visibility: note.visibility, content: note.text });
    for (const { sql, params } of upsertStatements(note.path, projected)) db.prepare(sql).run(...params);
  }
  const client = {
    async query(sql, params) {
      await sleep(latency);
      return db.prepare(sql).all(...params);
    },
  };
  return {
    async search(query) {
      const spend = createSearchBudget(budget);
      const answer = await answerFromProjection(client, { query, tier: "private", isVisible: () => true, budget: spend });
      return { paths: (answer?.hits ?? []).map((hit) => hit.key), subrequests: spend.spent };
    },
  };
}

/* -- scoring ------------------------------------------------------------- */

const K = 10;

async function score(engine, queries) {
  const rows = [];
  for (const run of ["cold", "warm"]) {
    for (const [i, query] of queries.entries()) {
      const started = performance.now();
      const answer = await engine.search(query.query);
      const ms = performance.now() - started;
      // A message hit names its sub-document (`path#anchor`); the note is the unit judged.
      const ranked = [...new Set(answer.paths.map((path) => path.split("#")[0]))];
      if (run === "cold") {
        rows[i] = {
          kind: query.kind,
          recall: recallAt(ranked, query.relevant, K),
          ndcg: ndcgAt(ranked, query.relevant, K),
          rr: reciprocalRank(ranked, query.relevant),
          subrequests: answer.subrequests,
          cold: ms,
        };
      } else {
        rows[i].warm = ms;
      }
    }
  }
  return rows;
}

function summarize(rows) {
  const pick = (field) => rows.map((row) => row[field]);
  return {
    recall: mean(pick("recall")),
    ndcg: mean(pick("ndcg")),
    mrr: mean(pick("rr")),
    cold: [50, 95, 99].map((p) => percentile(pick("cold"), p)),
    warm: [50, 95, 99].map((p) => percentile(pick("warm"), p)),
    subrequests: mean(pick("subrequests")),
  };
}

const f2 = (value) => value.toFixed(2);
const ms = (values) => values.map((value) => Math.round(value)).join(" / ");

function printTable(size, results) {
  console.log(`\n### ${size.toLocaleString("en-US")} notes\n`);
  console.log("| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [name, rows] of results) {
    const s = summarize(rows);
    console.log(`| ${name} | ${f2(s.recall)} | ${f2(s.ndcg)} | ${f2(s.mrr)} | ${ms(s.cold)} | ${ms(s.warm)} | ${f2(s.subrequests)} |`);
  }
  const kinds = [...new Set(results[0][1].map((row) => row.kind))];
  console.log(`\nRecall@10 by query class:\n`);
  console.log(`| Class | ${results.map(([name]) => name).join(" | ")} |`);
  console.log(`|---|${results.map(() => "---").join("|")}|`);
  for (const kind of kinds) {
    const cells = results.map(([, rows]) => f2(mean(rows.filter((row) => row.kind === kind).map((row) => row.recall))));
    console.log(`| ${kind} | ${cells.join(" | ")} |`);
  }
}

/* -- census -------------------------------------------------------------- */

const SCRIPTS = ["Latin", "Han", "Hiragana", "Katakana", "Hangul", "Thai", "Cyrillic", "Arabic", "Hebrew", "Devanagari", "Greek"];
const SCRIPT_RES = SCRIPTS.map((script) => [script, new RegExp(`\\p{Script=${script}}`, "u")]);

function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (name.endsWith(".md")) yield path;
  }
}

/** Files that use each script at least once. A file can count under several. */
export function census(texts) {
  const counts = Object.fromEntries(SCRIPTS.map((script) => [script, 0]));
  let files = 0;
  for (const text of texts) {
    files += 1;
    for (const [script, re] of SCRIPT_RES) if (re.test(text)) counts[script] += 1;
  }
  return { files, counts };
}

function printCensus(label, result) {
  const used = Object.entries(result.counts).filter(([, count]) => count > 0);
  console.log(`\nScript census, ${label}: ${result.files} files; ${used.map(([s, c]) => `${s} ${c}`).join(", ")}`);
}

/* -- main ---------------------------------------------------------------- */

const latency = Number(arg("latency", 20));
const d1Latency = Number(arg("d1-latency", 20));
const budget = Number(arg("budget", 600));
const sizes = String(arg("sizes", "100,1000")).split(",").map(Number);
const censusDir = arg("census", null);

if (censusDir) {
  printCensus(censusDir, census((function* () {
    for (const path of markdownFiles(censusDir)) yield readFileSync(path, "utf8");
  })()));
} else {
  console.log(`Store latency ${latency} ms per operation (B0), ${d1Latency} ms per request (B5), budget ${budget}.`);
  for (const size of sizes) {
    const { notes, queries } = generateCorpus({ size });
    const b0 = await buildB0(notes, latency, budget);
    const b5 = buildB5(notes, d1Latency, budget);
    printTable(size, [
      ["B0 bucket search", await score(b0, queries)],
      ["B5 Fast Search", await score(b5, queries)],
    ]);
    console.log(`\nB0 index built in ${b0.passes} passes. ${queries.length} judged queries.`);
    printCensus(`${size} fixture notes`, census(notes.map((note) => note.text)));
  }
}
