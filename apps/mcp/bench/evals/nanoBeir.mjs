/**
 * NANOBEIR: A PUBLIC, STANDARD SEARCH BENCHMARK, RUN THROUGH OUR WHOLE SEARCH (Dev2, 2026-11-21: "we should probably
 * have a thread focused on bringing in a popular search benchmark instead of our own";
 * `docs/decisions/search/search-suite.md`, "The public standard").
 *
 * BEIR (Thakur et al., 2021) is the standard zero-shot retrieval benchmark: 18 public sets from different fields, each
 * a corpus, queries and the documents judged relevant to each query ("qrels"), scored by nDCG@10. MTEB's retrieval
 * tab is BEIR. NanoBEIR (Zeta Alpha, 2024) cuts 13 of them to 50 queries and a corpus of a few thousand documents
 * (every relevant one kept, the rest BM25's top hits for the queries, so the distractors are hard). Sentence
 * Transformers' `NanoBEIREvaluator` reads the `sentence-transformers/Nano<Set>-bm25` copies used here, which also
 * carry BM25's own ranking of every query: the same qrels scored on BM25's list give a published reference row.
 *
 * One set is one world: Sam's empty personal workspace, every document one note (`beir/<doc id>.md`, its title as the
 * heading when the set has one), warm with both indexes filled, then each query one `search_notes` call as Sam
 * through the MCP endpoint, on both ways production answers (the search database and the workspace object). Only
 * the embedder and the reranker are called: a run costs embeddings and minutes, never Claude.
 *
 * Scored per set and as the mean over sets (NanoBEIR's own headline): nDCG@10, Recall@10, MRR@10, and our own right
 * note first and top 5. Sets differ in size, so the mean is over sets, never over pooled queries.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVAL_PERSON, EVAL_WORKSPACE, evalBench } from "./memoryRun.mjs";
import { overlay, runSearchCases, searchScores } from "./searchSuite.mjs";

/** The 13 NanoBEIR sets: our short name, the Hugging Face set, and what its queries and documents are. */
export const NANO_SETS = Object.freeze([
  { id: "msmarco", repo: "sentence-transformers/NanoMSMARCO-bm25", about: "Bing searches → web passages" },
  { id: "nq", repo: "sentence-transformers/NanoNQ-bm25", about: "Google questions → Wikipedia passages" },
  { id: "fiqa", repo: "sentence-transformers/NanoFiQA2018-bm25", about: "personal-finance questions → forum answers" },
  { id: "scifact", repo: "sentence-transformers/NanoSciFact-bm25", about: "science claims → paper abstracts" },
  { id: "nfcorpus", repo: "sentence-transformers/NanoNFCorpus-bm25", about: "plain health questions → medical abstracts" },
  { id: "quora", repo: "sentence-transformers/NanoQuoraRetrieval-bm25", about: "a question → the same question asked another way" },
  { id: "hotpotqa", repo: "sentence-transformers/NanoHotpotQA-bm25", about: "two-step questions → Wikipedia passages" },
  { id: "fever", repo: "sentence-transformers/NanoFEVER-bm25", about: "claims → the Wikipedia passage that checks them" },
  { id: "climate-fever", repo: "sentence-transformers/NanoClimateFEVER-bm25", about: "climate claims → Wikipedia passages" },
  { id: "dbpedia", repo: "sentence-transformers/NanoDBPedia-bm25", about: "entity searches → DBpedia abstracts" },
  { id: "scidocs", repo: "sentence-transformers/NanoSCIDOCS-bm25", about: "a paper title → the papers it cites" },
  { id: "arguana", repo: "sentence-transformers/NanoArguAna-bm25", about: "an argument → its counter-argument" },
  { id: "touche", repo: "sentence-transformers/NanoTouche2020-bm25", about: "debate questions → argument pages" },
]);

/**
 * The four the search gate runs: the sets whose queries look most like what people and agents type into notes search
 * (short searches, plain questions, a forum-style answer, a claim to check), about 17,600 notes and 200 queries.
 */
export const GATE_SETS = Object.freeze(["msmarco", "nq", "fiqa", "scifact"]);

/** The benches the Lab offers: every set, and the gate's four. */
export const NANO_BENCHES = Object.freeze({
  nanobeir: NANO_SETS.map((s) => s.id),
  "nanobeir-gate": [...GATE_SETS],
});

/** How deep nDCG, Recall and MRR look: BEIR's cut-off. */
export const K = 10;

/** The folder a set's documents are notes in, under Sam's personal workspace. */
export const DOC_FOLDER = "beir";

const ROWS = "https://datasets-server.huggingface.co/rows";
const PAGE = 100;
const WAITS_MS = [2_000, 5_000, 15_000, 30_000];
const say = (line) => process.stderr.write(`${line}\n`);

/** A document id as a file name: letters, digits, `_` and `-` kept, anything else `-`, never empty. */
export function fileOf(id) {
  const name = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  return name || "doc";
}

/** Every row of one config of a set, from the Hugging Face dataset viewer, a page at a time, retried when busy. */
async function rowsOf(repo, config, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${ROWS}?dataset=${encodeURIComponent(repo)}&config=${config}&split=train&offset=${offset}&length=${PAGE}`;
    let page = null;
    for (let tried = 0; page === null; tried += 1) {
      const response = await fetchImpl(url).catch((error) => ({ ok: false, status: String(error?.message ?? error) }));
      if (response.ok) page = await response.json();
      else if (tried >= WAITS_MS.length) throw new Error(`${repo} ${config} rows at ${offset}: ${response.status}`);
      else await sleep(WAITS_MS[tried]);
    }
    const got = (page.rows ?? []).map((r) => r.row);
    rows.push(...got);
    if (got.length < PAGE) return rows;
  }
}

/**
 * One set as { id, revision, corpus: [{ id, title, text }], queries: [{ id, text, relevant: [doc id], bm25: [doc id] }] },
 * from `dir/<set>.json` when it was fetched before, else from Hugging Face (and kept there). A query with no relevant
 * document is dropped, as BEIR's evaluator does.
 */
export async function loadNanoSet(setId, dir, options = {}) {
  const set = NANO_SETS.find((s) => s.id === setId);
  if (!set) throw new Error(`no NanoBEIR set ${setId}: one of ${NANO_SETS.map((s) => s.id).join(", ")}`);
  const file = join(dir, `nanobeir-${set.id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const fetchImpl = options.fetchImpl ?? fetch;
  const info = await fetchImpl(`https://huggingface.co/api/datasets/${set.repo}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [corpus, queries, relevance] = [await rowsOf(set.repo, "corpus", options), await rowsOf(set.repo, "queries", options), await rowsOf(set.repo, "relevance", options)];
  const rel = new Map(relevance.map((r) => [String(r["query-id"]), r]));
  const data = {
    id: set.id,
    repo: set.repo,
    revision: typeof info?.sha === "string" ? info.sha : null,
    corpus: corpus.map((d) => ({ id: String(d._id), title: typeof d.title === "string" ? d.title : "", text: String(d.text ?? "") })),
    queries: queries
      .map((q) => {
        const r = rel.get(String(q._id));
        return { id: String(q._id), text: String(q.text ?? ""), relevant: (r?.["positive-corpus-ids"] ?? []).map(String), bm25: (r?.["bm25-ranked-ids"] ?? []).map(String) };
      })
      .filter((q) => q.relevant.length > 0),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, JSON.stringify(data));
  renameSync(`${file}.part`, file);
  say(`fetched NanoBEIR ${set.id}: ${data.corpus.length} documents, ${data.queries.length} queries`);
  return data;
}

/**
 * A set as notes and cases: `notes` "@sam/beir/<file>.md" → the document (its title as a heading when it has one),
 * and per query a case expecting its relevant documents' notes. `docOf` maps a note back to its document id, so BM25's
 * list (document ids) and our hits (addresses) are scored the same way.
 */
export function worldOf(data, { n = null } = {}) {
  const notes = {};
  const addressOf = new Map();
  const used = new Set();
  for (const doc of data.corpus) {
    let name = fileOf(doc.id);
    for (let k = 2; used.has(name); k += 1) name = `${fileOf(doc.id)}-${k}`;
    used.add(name);
    const address = `@${EVAL_WORKSPACE}/${DOC_FOLDER}/${name}.md`;
    addressOf.set(doc.id, address);
    notes[address] = `${doc.title ? `# ${doc.title}\n\n` : ""}${doc.text}\n`;
  }
  const queries = n === null ? data.queries : data.queries.slice(0, n);
  const cases = queries.map((q) => ({
    id: `${data.id}-${q.id}`,
    query: q.text,
    as: EVAL_PERSON,
    kind: data.id,
    expect: q.relevant.map((id) => addressOf.get(id)).filter(Boolean),
    bm25: q.bm25.map((id) => addressOf.get(id)).filter(Boolean),
  }));
  return { notes, cases };
}

/** Each note once, in the order first seen. */
const once = (hits) => [...new Set(hits ?? [])];

/** nDCG@K with binary relevance, as BEIR's evaluator (pytrec_eval) scores it: log2 discount, ideal = all relevant first. */
export function ndcgAt(hits, relevant, k = K) {
  const rel = new Set(relevant);
  if (rel.size === 0) return 0;
  const dcg = once(hits).slice(0, k).reduce((sum, h, i) => sum + (rel.has(h) ? 1 / Math.log2(i + 2) : 0), 0);
  let ideal = 0;
  for (let i = 0; i < Math.min(rel.size, k); i += 1) ideal += 1 / Math.log2(i + 2);
  return dcg / ideal;
}

/** The share of the relevant notes in the first K. */
export function recallAt(hits, relevant, k = K) {
  const rel = new Set(relevant);
  if (rel.size === 0) return 0;
  return once(hits).slice(0, k).filter((h) => rel.has(h)).length / rel.size;
}

/** 1 / the place of the first relevant note in the first K, or 0. */
export function mrrAt(hits, relevant, k = K) {
  const rel = new Set(relevant);
  const at = once(hits).slice(0, k).findIndex((h) => rel.has(h));
  return at < 0 ? 0 : 1 / (at + 1);
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const r3 = (x) => (x === null ? null : Math.round(1000 * x) / 1000);

/** One list of records' IR scores: nDCG@10, Recall@10, MRR@10 over the cases that expect something. */
export function irScores(records, hitsOf = (r) => r.hits) {
  const scored = records.filter((r) => (r.expect ?? []).length > 0);
  return {
    ndcg10: r3(mean(scored.map((r) => ndcgAt(hitsOf(r), r.expect)))),
    recall10: r3(mean(scored.map((r) => recallAt(hitsOf(r), r.expect)))),
    mrr10: r3(mean(scored.map((r) => mrrAt(hitsOf(r), r.expect)))),
  };
}

/**
 * The scores of a NanoBEIR run: our `searchScores` over every query, plus `ndcg10`, `recall10`, `mrr10` as the mean
 * over sets (NanoBEIR's headline), `bm25Ndcg10` (BM25's own ranking, the reference row), the object world's `ndcg10`
 * beside it, and `bySet` { set: { n, ndcg10, recall10, mrr10, firstPct, bm25Ndcg10, objectNdcg10 } }.
 */
export function nanoScores(records) {
  const sets = [...new Set(records.map((r) => r.kind))];
  const bySet = {};
  for (const set of sets) {
    const group = records.filter((r) => r.kind === set);
    const ours = irScores(group);
    const object = group.some((r) => r.object) ? irScores(group.filter((r) => r.object), (r) => r.object.hits) : null;
    const first = searchScores(group);
    bySet[set] = { n: first.n, ...ours, firstPct: first.firstPct, bm25Ndcg10: irScores(group, (r) => r.bm25).ndcg10, ...(object ? { objectNdcg10: object.ndcg10 } : {}) };
  }
  const avg = (key) => r3(mean(Object.values(bySet).map((s) => s[key]).filter((x) => typeof x === "number")));
  return {
    ...searchScores(records),
    ndcg10: avg("ndcg10"),
    recall10: avg("recall10"),
    mrr10: avg("mrr10"),
    bm25Ndcg10: avg("bm25Ndcg10"),
    ...(Object.values(bySet).some((s) => s.objectNdcg10 !== undefined) ? { objectNdcg10: avg("objectNdcg10") } : {}),
    bySet,
  };
}

/**
 * Run NanoBEIR sets through search: each set its own world, `n` queries in all spread evenly over the sets (null =
 * every query). Returns the records (each with `kind` = its set and `bm25` = BM25's list) and their `nanoScores`.
 */
export async function runNanoBeir({ sets, dir, n = null, ai, objects = true, log = say }) {
  const perSet = n === null ? null : Math.max(1, Math.ceil(n / sets.length));
  const records = [];
  for (const setId of sets) {
    const data = await loadNanoSet(setId, dir);
    const { notes, cases } = worldOf(data, { n: perSet });
    log(`${setId}: ${data.corpus.length} notes, ${cases.length} queries${data.revision ? ` (revision ${data.revision.slice(0, 7)})` : ""}`);
    const started = Date.now();
    const got = await runSearchCases({ bench: overlay(evalBench(), notes), cases, ai, objects, log: () => {} });
    got.forEach((record, i) => records.push({ ...record, bm25: cases[i].bm25 }));
    const s = nanoScores(records.filter((r) => r.kind === setId)).bySet[setId];
    log(`${setId}: nDCG@10 ${s.ndcg10}${s.objectNdcg10 !== undefined ? ` (objects ${s.objectNdcg10})` : ""}, BM25 ${s.bm25Ndcg10}, right note first ${s.firstPct}% in ${Math.round((Date.now() - started) / 1000)} s`);
  }
  return { records, search: nanoScores(records) };
}
