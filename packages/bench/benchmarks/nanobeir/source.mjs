/**
 * NANOBEIR: THE PUBLIC STANDARD, FETCHED AS THE BEIR SETS IT IS (Dev2, 2026-11-21: "bring in a popular search
 * benchmark instead of our own"; `docs/decisions/search/search-suite.md`, "The public standard").
 *
 * BEIR (Thakur et al., 2021) is the standard zero-shot retrieval benchmark: 18 public sets from different fields,
 * scored by nDCG@10; MTEB's retrieval tab is BEIR. NanoBEIR (Zeta Alpha, 2024) cuts 13 of them to 50 queries and a
 * corpus of a few thousand documents (every relevant one kept, the rest BM25's top hits for the queries, so the
 * distractors are hard). The `sentence-transformers/Nano<Set>-bm25` copies read here also carry BM25's own ranking of
 * every query, kept as each query's `bm25`: the same qrels scored on it give a published reference row.
 *
 * Each set is fetched once into `<dir>/nanobeir/<set>/` as BEIR's own files, and read from there after.
 */

import { join } from "node:path";

import { readBeir, writeBeir } from "../../src/beir.mjs";
import { hubDataset, hubParquet } from "../../src/hub.mjs";

/** The 13 NanoBEIR sets: our short name, the Hugging Face set, and what its queries and documents are. */
export const SETS = Object.freeze([
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

const say = (line) => process.stderr.write(`${line}\n`);

/** One set as a BEIR set, from `<dir>/nanobeir/<set>/` when fetched before, else from the Hub (and kept there). */
export async function loadSet(setId, dir, options = {}) {
  const set = SETS.find((s) => s.id === setId);
  if (!set) throw new Error(`no NanoBEIR set ${setId}: one of ${SETS.map((s) => s.id).join(", ")}`);
  const folder = join(dir, "nanobeir", set.id);
  const kept = readBeir(folder, set.id);
  if (kept) return kept;
  const { revision, files } = await hubDataset(set.repo, options);
  const corpus = await hubParquet(set.repo, revision, files, "corpus", options);
  const queries = await hubParquet(set.repo, revision, files, "queries", options);
  const relevance = await hubParquet(set.repo, revision, files, "relevance", options);
  const rel = new Map(relevance.map((r) => [String(r["query-id"]), r]));
  const qrels = {};
  for (const [q, r] of rel) for (const d of r["positive-corpus-ids"] ?? []) (qrels[q] ??= {})[String(d)] = 1;
  const data = {
    id: set.id,
    revision,
    corpus: corpus.map((d) => ({ _id: String(d._id), title: typeof d.title === "string" ? d.title : "", text: String(d.text ?? "") })),
    queries: queries.filter((q) => qrels[String(q._id)]).map((q) => ({ _id: String(q._id), text: String(q.text ?? ""), bm25: (rel.get(String(q._id))?.["bm25-ranked-ids"] ?? []).map(String) })),
    qrels,
  };
  writeBeir(folder, data);
  say(`fetched NanoBEIR ${set.id}: ${data.corpus.length} documents, ${data.queries.length} queries`);
  return data;
}

/** The sets a run asks for (`sets`, or the run's own, or all 13), as BEIR sets. */
export async function load({ run, dir, sets = null, ...options }) {
  const ids = sets ?? run.sets ?? SETS.map((s) => s.id);
  for (const id of ids) if (!SETS.some((s) => s.id === id)) throw new Error(`--sets: no NanoBEIR set ${id}`);
  const out = [];
  for (const id of ids) out.push(await loadSet(id, dir, options));
  return out;
}
