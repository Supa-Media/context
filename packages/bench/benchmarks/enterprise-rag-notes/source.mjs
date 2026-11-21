/**
 * ENTERPRISERAG NOTES: ENTERPRISERAG-BENCH CUT TO WHAT PEOPLE KEEP IN CONTEXT (Dev2, 2026-11-21: HERB is not the
 * final benchmark; "we don't save emails in context anymore though, or even chat threads"; "would it still be
 * enterprise rag or do we have to call it something different").
 *
 * EnterpriseRAG-Bench (Onyx, arXiv 2605.05253; `onyx-dot-app/EnterpriseRAG-Bench` on Hugging Face, MIT) is one made-up
 * company's internal data: 511,962 documents from nine tools and 500 questions, each citing the documents
 * (`expected_doc_ids`) that answer it, about 8% of them filed in the wrong tool on purpose. Context saves neither email
 * nor chat threads, so its Slack (285,605) and Gmail (121,390) documents are left out, and every question citing one.
 * What is left is what a workspace holds, each kept where Context would keep it, in PARA's folders:
 *
 *   confluence    resources/wiki/<title>.md           google_drive  resources/docs/<title>.md
 *   fireflies     inbox/meetings/<title>.md           hubspot       areas/customers/<title>.md
 *   linear        projects/issues/<title>.md          jira          areas/support/<title>.md
 *   github        projects/pull-requests/<title>.md
 *
 * 104,967 documents and 343 questions with cited documents (plus the 30 with none, which only a memory run could
 * grade). A run of the whole corpus takes hours of embeddings, so the everyday run keeps `corpus` notes: every cited
 * document, then per kind the documents whose titles share the most words with that kind's questions (the hard
 * distractors), filled in the same order every time. Its name says it is ours: these scores are not the leaderboard's.
 *
 * The documents file is 1.4 GB in one row group, sorted by tool: only the rows of the kept tools are read, with HTTP
 * range requests, and the result kept in `<dir>/enterprise-rag-notes/` as BEIR's own files (about 650 MB).
 */

import { join } from "node:path";

import { readBeir, writeBeir } from "../../src/beir.mjs";
import { hubDataset, hubFile, hubParquet } from "../../src/hub.mjs";

export const REPO = "onyx-dot-app/EnterpriseRAG-Bench";

/** The tools a workspace holds, and the folder each one's documents are kept in. Slack and Gmail are left out. */
export const FOLDERS = Object.freeze({
  confluence: "resources/wiki",
  google_drive: "resources/docs",
  fireflies: "inbox/meetings",
  hubspot: "areas/customers",
  linear: "projects/issues",
  jira: "areas/support",
  github: "projects/pull-requests",
});
export const LEFT_OUT = Object.freeze(["slack", "gmail"]);

const say = (line) => process.stderr.write(`${line}\n`);

/** A title as a file name: lower-case words joined by hyphens, never empty, never long. */
export function slugOf(title, fallback = "note") {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || fallback;
}

const listOf = (x) => (Array.isArray(x) ? x.map(String) : typeof x === "string" && x ? [x] : x && typeof x[Symbol.iterator] === "function" ? [...x].map(String) : []);

/**
 * The documents of the kept tools, reading only their rows: the tool column first (a few MB), then each run of kept
 * rows. `readRows({ columns?, rowStart?, rowEnd? })` reads the file (tests hand in their own).
 */
export async function keptDocuments(readRows) {
  const tools = await readRows({ columns: ["source_type"] });
  const ranges = [];
  tools.forEach((row, i) => {
    const keep = Object.hasOwn(FOLDERS, row.source_type);
    const last = ranges.at(-1);
    if (keep && last && last[1] === i) last[1] = i + 1;
    else if (keep) ranges.push([i, i + 1]);
  });
  const docs = [];
  for (const [rowStart, rowEnd] of ranges) docs.push(...(await readRows({ rowStart, rowEnd })).filter((d) => Object.hasOwn(FOLDERS, d.source_type)));
  return docs;
}

/** The dataset as one BEIR set: the kept documents as notes in their folders, the questions none of whose citations is left out. */
export function toBeir({ revision = null, documents, questions }) {
  const corpus = documents.map((d) => ({ _id: String(d.doc_id), title: String(d.title ?? ""), text: String(d.content ?? ""), path: `${FOLDERS[d.source_type]}/${slugOf(d.title, String(d.doc_id))}.md`, tool: d.source_type }));
  const kept = new Set(corpus.map((d) => d._id));
  const queries = [];
  const qrels = {};
  for (const q of questions) {
    const tools = listOf(q.source_types);
    if (tools.some((t) => LEFT_OUT.includes(t))) continue;
    const id = String(q.question_id);
    queries.push({ _id: id, text: String(q.question ?? ""), kind: String(q.question_type ?? "other"), answer: String(q.gold_answer ?? ""), tools });
    for (const d of listOf(q.expected_doc_ids)) if (kept.has(d)) (qrels[id] ??= {})[d] = 1;
  }
  return { id: "enterprise-rag-notes", revision, corpus, queries, qrels };
}

const words = (text) => new Set(String(text ?? "").toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** FNV-1a, for an order that is the same on every run. */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * `size` documents of the set: every cited one, then the hardest distractors, per tool in proportion to its size: the
 * documents whose titles share the most words with the questions citing that tool, ties in a fixed hash order.
 */
export function sliceCorpus(set, size) {
  if (!size || set.corpus.length <= size) return set;
  const cited = new Set(Object.values(set.qrels).flatMap((docs) => Object.keys(docs)));
  const keep = new Set(cited);
  const byTool = new Map();
  for (const d of set.corpus) {
    if (cited.has(d._id)) continue;
    if (!byTool.has(d.tool)) byTool.set(d.tool, []);
    byTool.get(d.tool).push(d);
  }
  const asked = new Map();
  for (const q of set.queries) {
    for (const t of q.tools ?? []) {
      if (!asked.has(t)) asked.set(t, new Set());
      for (const w of words(q.text)) asked.get(t).add(w);
    }
  }
  const room = Math.max(0, size - keep.size);
  const rest = set.corpus.length - cited.size;
  for (const [tool, docs] of byTool) {
    const vocab = asked.get(tool) ?? new Set();
    const score = (d) => [...words(d.title)].filter((w) => vocab.has(w)).length;
    const take = Math.floor((room * docs.length) / rest);
    docs
      .map((d) => ({ d, s: score(d), h: hashOf(d._id) }))
      .sort((a, b) => b.s - a.s || a.h - b.h)
      .slice(0, take)
      .forEach(({ d }) => keep.add(d._id));
  }
  return { ...set, corpus: set.corpus.filter((d) => keep.has(d._id)) };
}

/** The whole adapted set, from `<dir>/enterprise-rag-notes/` when kept before, else from the Hub (and kept there). */
export async function loadSet(dir, options = {}) {
  const folder = join(dir, "enterprise-rag-notes");
  const kept = readBeir(folder);
  if (kept) return kept;
  const { revision, files } = await hubDataset(REPO, options);
  const questions = await hubParquet(REPO, revision, files, "data/questions", options);
  const readRows = options.readRows ?? (await rangeReader(hubFile(REPO, revision, "data/documents/test.parquet")));
  const documents = await keptDocuments(readRows);
  const set = toBeir({ revision, documents, questions });
  writeBeir(folder, set);
  say(`fetched EnterpriseRAG-Bench: kept ${set.corpus.length} documents and ${set.queries.length} questions (Slack and email left out)`);
  return set;
}

/** Rows of a remote parquet file read with HTTP range requests (hyparquet), the file's metadata read once. */
async function rangeReader(url) {
  const { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } = await import("hyparquet");
  const file = await asyncBufferFromUrl({ url });
  const metadata = await parquetMetadataAsync(file);
  return (options) => parquetReadObjects({ file, metadata, ...options });
}

/** The run's set: the adapted set, cut to the run's `corpus` notes when it names a size. */
export async function load({ run, dir, ...options }) {
  const set = await loadSet(dir, options);
  const out = sliceCorpus(set, run.corpus ?? null);
  say(`EnterpriseRAG Notes: ${out.corpus.length} notes, ${Object.keys(out.qrels).length} questions with cited notes${set.revision ? ` (revision ${set.revision.slice(0, 7)})` : ""}`);
  return [out];
}
