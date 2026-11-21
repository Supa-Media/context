/**
 * THE SEARCH SUITE FROM A COMMAND LINE (`searchSuite.mjs`, `docs/decisions/search/search-suite.md`):
 *
 *   node apps/mcp/bench/evals/cli.mjs search --bench search-hard [--n 40] --out result.json [--fake]
 *   node apps/mcp/bench/evals/cli.mjs search --bench search-real [--part dev|training] [--cases <file>] --out result.json
 *   (add --database-only to skip the workspace-object world each case is also searched in)
 *   node apps/mcp/bench/evals/cli.mjs search --bench longmemeval-retrieval --fetch <dir> --n 50 --out result.json
 *
 * `--cases <file>` runs a real-query set from a file instead of the repo's parts: how the search gate runs the sealed
 * Test part it was handed (`search-test-set.yml`), never kept in the repository. Only the embedder is called (Workers
 * AI when its keys are set, the bench's fake one otherwise or with `--fake`), so a run costs embeddings and seconds.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_BENCH_FOLDER } from "../folder.mjs";
import { expandWorkspaces, readBenchFolder } from "../load.mjs";
import { BENCHES, entryOf, sliceOf } from "./longMemEval.mjs";
import { retrievalScores, retrieveQuestion } from "./memoryRetrieval.mjs";
import { loadHardSet } from "./searchSets.mjs";
import { embedderFor, overlay, rowOf, runSearchCases, searchScores, searchSetOf } from "./searchSuite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The real-query set's visible parts; the Test part lives only in the eval service. */
export const REAL_DIR = join(HERE, "..", "search", "real");
export const REAL_PARTS = Object.freeze(["training", "dev"]);
export const REAL_TODAY = "2026-11-21";

const say = (line) => process.stderr.write(`${line}\n`);

/**
 * A real-query part as one bench overlay and its cases. Each case brings the notes that make it hard
 * (`notes`, "@ws/path" → text); two cases naming the same address must agree on its text.
 */
export function realSetOf(cases) {
  if (!Array.isArray(cases)) throw new Error("a real-query set is a JSON array of cases");
  const notes = {};
  for (const c of cases) {
    for (const key of ["id", "query", "as"]) if (typeof c?.[key] !== "string" || !c[key]) throw new Error(`case ${c?.id ?? "?"}: ${key} is missing`);
    if (!Array.isArray(c.expect) || c.expect.length === 0) throw new Error(`case ${c.id}: expect names no note`);
    for (const [address, text] of Object.entries(c.notes ?? {})) {
      if (Object.hasOwn(notes, address) && notes[address] !== text) throw new Error(`case ${c.id}: ${address} differs from another case's note of that name`);
      notes[address] = text;
    }
  }
  return { notes, cases: cases.map(({ notes: _notes, ...c }) => ({ ...c, in: c.in ?? null, forbid: c.forbid ?? [] })) };
}

export async function readRealPart(part, file = null) {
  if (!file && !REAL_PARTS.includes(part)) throw new Error(`--part is one of ${REAL_PARTS.join(", ")}`);
  return JSON.parse(await readFile(file ?? join(REAL_DIR, `${part}.json`), "utf8"));
}

/** The compatibility scores block the Lab's older readers show: right note first as "correct". */
const labScores = (s) => ({ n: s.n, correct: s.first, pct: s.firstPct, asked: s.n, failed: s.errors, usd: { filing: 0, reading: 0, judging: 0, total: 0 } });

const byKind = (records) => {
  const kinds = {};
  for (const r of records) {
    if (!(r.expect ?? []).length) continue;
    const k = (kinds[r.kind ?? "other"] ??= { n: 0, first: 0 });
    k.n += 1;
    if (r.rank === 1) k.first += 1;
  }
  return Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { n: v.n, firstPct: Math.round((1000 * v.first) / v.n) / 10 }]));
};

/** Run one search set and return the result object the Lab's eval workflow reports. */
export async function runSearchSet(options) {
  const set = searchSetOf(options.bench ?? "search-hard");
  if (!set) throw new Error(`no search set ${options.bench}`);
  const ai = embedderFor({ fake: options.fake === true || !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN) });
  const started = Date.now();
  const n = options.n === undefined ? null : Number(options.n);
  if (n !== null && (!Number.isSafeInteger(n) || n < 1)) throw new Error("--n is a whole number of cases");
  // A world's gateway logs a JSON line per step; a run prints one line per case instead.
  const log = console.log;
  console.log = () => {};
  try {
    if (set.id === "longmemeval-retrieval") {
      const lme = BENCHES.find((b) => b.id === "longmemeval-s");
      const file = options.data ?? (options.fetch ? await (await import("./cli.mjs")).fetchData(lme, options.fetch) : null);
      if (!file) throw new Error("--data <file> or --fetch <dir> is required");
      const data = JSON.parse(readFileSync(file, "utf8"));
      const byId = new Map(data.map((item) => [item?.question_id, item]));
      // Abstention questions have no answer session to find; retrieval recall leaves them out, as LongMemEval does.
      const index = data.map((item, i) => entryOf(item, i)).filter((e) => e && e.ability !== "abstention");
      const slice = sliceOf(index, n ?? index.length).map((e) => byId.get(e.id));
      const records = [];
      for (const item of slice) {
        const record = await retrieveQuestion(item, { ai });
        records.push(record);
        say(`${record.id}: ${record.rank === null ? "miss" : `rank ${record.rank}`}${record.recallAll5 ? "" : record.recallAny5 ? " (some answer sessions past 5)" : ""}`);
      }
      const search = retrievalScores(records);
      return { bench: set.id, variant: set.variant, total: index.length, n: records.length, ms: Date.now() - started, search, scores: labScores(search), rows: records.map((r) => ({ ...rowOf(r), ability: r.ability ?? "search" })) };
    }
    const base = expandWorkspaces(await readBenchFolder(REPO_BENCH_FOLDER));
    let today = null;
    let notes;
    let cases;
    if (set.id === "search-hard") {
      const hard = await loadHardSet();
      today = hard.today ?? null;
      ({ notes, cases } = hard);
    } else {
      ({ notes, cases } = realSetOf(await readRealPart(options.part ?? "dev", options.cases ?? null)));
      // Pinned, so a recency prior ranks the same today and next month: the day the real set was written.
      today = options.today ?? REAL_TODAY;
    }
    const total = cases.length;
    const chosen = n === null ? cases : cases.slice(0, n);
    const records = await runSearchCases({ bench: overlay(base, notes), cases: chosen, ai, today, objects: options["database-only"] !== true, log: (line) => process.stderr.write(line) });
    const search = { ...searchScores(records), byKind: byKind(records) };
    return { bench: set.id, variant: set.variant, total, n: records.length, ms: Date.now() - started, search, scores: labScores(search), rows: records.map(rowOf), records: options["keep-records"] ? records : undefined };
  } finally {
    console.log = log;
  }
}
