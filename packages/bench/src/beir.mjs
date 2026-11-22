/**
 * BEIR'S FORMAT, THE OPEN STANDARD A SEARCH BENCHMARK IS WRITTEN IN (Dev2, 2026-11-21: "is there an open
 * format/structure for defining bench marks? would love to reuse").
 *
 * BEIR (Thakur et al., 2021) put every retrieval set in one layout, and MTEB, NanoBEIR, ir_datasets and most
 * retrieval sets on Hugging Face read and write it:
 *
 *   corpus.jsonl      one document a line: { "_id", "title", "text" }
 *   queries.jsonl     one query a line:    { "_id", "text" }
 *   qrels/test.tsv    a header line, then  query-id <TAB> corpus-id <TAB> score   (score > 0: judged relevant)
 *
 * A set in memory is the same three things: { id, revision, corpus: [doc], queries: [query], qrels: { [query id]:
 * { [doc id]: score } } }. What BEIR has no field for, we add as optional fields of a line, which every BEIR reader
 * ignores, so a set of ours is still a BEIR set anyone can run:
 *
 *   a document's  "path"       where it is kept as a note ("projects/launch/plan.md"), and "workspace" whose it is
 *                 "date"       when it was written (ISO 8601): a dated document is a past session, saved on its day
 *                 "group"      the haystack it belongs to, when each query has its own (LongMemEval: one a question)
 *   a query's     "kind"       the group it is scored in (NanoBEIR's set, HERB's question type)
 *                 "as"         who searches (a person of the bench world), and "bm25", a reference ranking (doc ids)
 *                 "answer"     the answer a reader should give, which a memory run's judge grades against
 *                 "date"       when it is asked (ISO 8601), and "group", the haystack it is asked over
 *                 "ability"    what it tests, for a memory run's scores (LongMemEval's five)
 *
 * One set runs two ways. A search run (`beirWorlds`) keeps every document as a note and scores where the judged ones
 * come back. A memory run (`memoryCases`) saves the documents as an AI client saves sessions, on their dates, then a
 * reader answers each question from Context and a judge grades it against `answer`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** A document id as a file name: letters, digits, `_` and `-` kept, anything else `-`, never empty. */
export function fileOf(id) {
  const name = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  return name || "doc";
}

const lines = (text) => text.split("\n").filter((line) => line.trim() !== "");

/** Rows as JSON lines into `file`, a few MB at a time: a corpus can be larger than the longest string V8 holds. */
function writeJsonl(file, rows) {
  const fd = openSync(file, "w");
  try {
    let chunk = "";
    for (const row of rows) {
      chunk += `${JSON.stringify(row)}\n`;
      if (chunk.length > 4_000_000) {
        writeSync(fd, chunk);
        chunk = "";
      }
    }
    if (chunk) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
}

/** JSON lines read from `file` as bytes and cut at each newline, for the same reason. */
function readJsonl(file) {
  const bytes = readFileSync(file);
  const rows = [];
  for (let start = 0; start < bytes.length; ) {
    let end = bytes.indexOf(10, start);
    if (end === -1) end = bytes.length;
    const line = bytes.toString("utf8", start, end);
    if (line.trim() !== "") rows.push(JSON.parse(line));
    start = end + 1;
  }
  return rows;
}

/** Write a set as BEIR's three files (and `set.json`: its id and revision) in `dir`, each file whole or not at all. */
export function writeBeir(dir, set) {
  mkdirSync(join(dir, "qrels"), { recursive: true });
  const put = (name, text) => {
    if (typeof text === "string") writeFileSync(join(dir, `${name}.part`), text);
    else writeJsonl(join(dir, `${name}.part`), text);
    renameSync(join(dir, `${name}.part`), join(dir, name));
  };
  const qrels = Object.entries(set.qrels).flatMap(([q, docs]) => Object.entries(docs).map(([d, score]) => `${q}\t${d}\t${score}`));
  put("corpus.jsonl", set.corpus);
  put("queries.jsonl", set.queries);
  put(join("qrels", "test.tsv"), `query-id\tcorpus-id\tscore\n${qrels.join("\n")}${qrels.length ? "\n" : ""}`);
  // Written last: a folder with set.json is a whole set.
  put("set.json", `${JSON.stringify({ id: set.id, revision: set.revision ?? null }, null, 2)}\n`);
}

/** A set read from BEIR's three files in `dir`, or null when `dir` holds no whole set. */
export function readBeir(dir, id = null) {
  if (!existsSync(join(dir, "set.json"))) return null;
  const meta = JSON.parse(readFileSync(join(dir, "set.json"), "utf8"));
  const qrels = {};
  const [, ...rows] = lines(readFileSync(join(dir, "qrels", "test.tsv"), "utf8"));
  for (const row of rows) {
    const [q, d, score] = row.split("\t");
    (qrels[q] ??= {})[d] = Number(score);
  }
  return {
    id: id ?? meta.id,
    revision: meta.revision ?? null,
    corpus: readJsonl(join(dir, "corpus.jsonl")),
    queries: readJsonl(join(dir, "queries.jsonl")),
    qrels,
  };
}

/** A query's judged documents, in qrels order: those scored above 0. */
export const relevantOf = (set, queryId) => Object.entries(set.qrels[queryId] ?? {}).filter(([, score]) => score > 0).map(([doc]) => doc);

/** `n` of `items`: the first n, or n spread evenly over all of them (so a short run still sees every kind). */
export function sliceOf(items, n, how = "first") {
  if (n === null || n >= items.length) return items;
  if (how === "spread") return Array.from({ length: n }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / n)]);
  return items.slice(0, n);
}

const isoDay = (iso) => String(iso).slice(0, 10);

/**
 * A document as the note it is kept as. A dated one is a saved session: front matter naming its day (and a title,
 * "Chat <day>" when it has none), then its text. Any other: its title as the heading when it has one, then its text.
 */
export function noteOf(doc) {
  if (doc.date) return `---\ntitle: ${JSON.stringify(doc.title || `Chat ${isoDay(doc.date)}`)}\ndate: ${isoDay(doc.date)}\n---\n\n${doc.text ?? ""}\n`;
  return `${doc.title ? `# ${doc.title}\n\n` : ""}${doc.text ?? ""}\n`;
}

/**
 * A set as notes and cases. `notes` "@<workspace>/<path>" → the document as a note: its title as the heading when it
 * has one, then its text. A document with no `path` is `<folder>/<file of its id>.md`; two that would share a path get
 * `-2`, `-3`. Each query with a judged document is one case expecting those documents' notes, searched as `as`, with
 * `bm25` (when the query carries a reference ranking) as notes too, so both lists are scored the same way. A query
 * no document is judged relevant to is dropped, as BEIR's evaluator does.
 *
 * Options: `workspace` and `as` (whose notes, who searches), `folder`, `n` and `slice` ("first" | "spread"), and
 * `caseIds` ("set": `<set id>-<query id>`, the default; "query": the query's own id).
 */
export function beirWorld(set, { workspace = "sam", as = "Sam", folder = "beir", n = null, slice = "first", caseIds = "set" } = {}) {
  const notes = {};
  const addressOf = new Map();
  const used = new Set();
  for (const doc of set.corpus) {
    const id = String(doc._id);
    const ws = doc.workspace ?? workspace;
    const wanted = doc.path ?? `${folder}/${fileOf(id)}.md`;
    let path = wanted;
    for (let k = 2; used.has(`${ws}/${path}`); k += 1) path = wanted.replace(/\.md$/, `-${k}.md`);
    used.add(`${ws}/${path}`);
    const address = `@${ws}/${path}`;
    addressOf.set(id, address);
    notes[address] = noteOf(doc);
  }
  const judged = set.queries.filter((q) => relevantOf(set, String(q._id)).length > 0);
  // Every workspace a document names besides the searcher's own is a shared one the searcher is a member of, so a
  // search with no workspace named reaches all of them, as a person's own search does.
  const others = [...new Set(set.corpus.map((doc) => doc.workspace ?? workspace))].filter((ws) => ws !== workspace).sort();
  const people = others.map((ws) => ({ person: as, workspace: ws, personal: false, role: "member" }));
  const cases = sliceOf(judged, n, slice).map((q) => {
    const qid = String(q._id);
    return {
      id: caseIds === "query" ? qid : `${set.id}-${qid}`,
      query: String(q.text ?? ""),
      as: q.as ?? as,
      kind: q.kind ?? set.id,
      expect: relevantOf(set, qid).map((d) => addressOf.get(d)).filter(Boolean),
      // A judged document the set has no text for cannot be found: named, never silently dropped.
      missing: relevantOf(set, qid).filter((d) => !addressOf.has(d)),
      ...(q.ability ? { ability: q.ability } : {}),
      ...(Array.isArray(q.bm25) ? { bm25: q.bm25.map((d) => addressOf.get(String(d))).filter(Boolean) } : {}),
    };
  });
  return { notes, cases, people };
}

/** The set's haystacks: one per `group` when its documents carry one, else the whole set as one. */
export function groupsOf(set) {
  if (!set.corpus.some((d) => d.group !== undefined)) return [set];
  const docs = new Map();
  for (const d of set.corpus) {
    const g = String(d.group ?? "");
    if (!docs.has(g)) docs.set(g, []);
    docs.get(g).push(d);
  }
  const queries = new Map();
  for (const q of set.queries) {
    const g = String(q.group ?? "");
    if (!queries.has(g)) queries.set(g, []);
    queries.get(g).push(q);
  }
  return [...queries.keys()].map((g) => ({ ...set, id: g, corpus: docs.get(g) ?? [], queries: queries.get(g) }));
}

/**
 * The search worlds of a set: one per haystack (`groupsOf`), each `{ id, notes, cases, today }`, `today` the day its
 * queries are asked when they carry one. `n` and `slice` apply over the whole set's queries; `caseIds` "set" names a
 * grouped set's cases by the set, not the group.
 */
export function beirWorlds(set, options = {}) {
  const groups = groupsOf(set);
  if (groups.length === 1 && groups[0] === set) return [{ id: set.id, ...beirWorld(set, options), today: dayOf(set.queries) }];
  const keep = new Set(sliceOf(set.queries.filter((q) => relevantOf(set, String(q._id)).length > 0), options.n ?? null, options.slice ?? "first").map((q) => q._id));
  return groups
    .map((g) => ({ ...g, id: set.id, queries: g.queries.filter((q) => keep.has(q._id)) }))
    .filter((g) => g.queries.length > 0)
    .map((g) => ({ id: String(g.queries[0].group), ...beirWorld(g, { ...options, n: null }), today: dayOf(g.queries) }));
}

const dayOf = (queries) => {
  const days = [...new Set(queries.map((q) => q.date).filter(Boolean).map(isoDay))];
  return days.length === 1 ? days[0] : null;
};

/**
 * A set as memory cases: per query `{ id, kind, ability, question, answer, date, asked, sessions }` (`asked`: the date as the dataset wrote it), `sessions` its
 * haystack's dated documents oldest first as `{ id, at (ms), title, content }`. A document with no date has no day to
 * be saved on and is left out.
 */
export function memoryCases(set) {
  return groupsOf(set).flatMap((g) => {
    const sessions = g.corpus
      .filter((d) => d.date && Number.isFinite(Date.parse(d.date)))
      .map((d, k) => ({ k, id: String(d.session ?? d._id), at: Date.parse(d.date), title: d.title ?? "", content: String(d.text ?? "") }))
      .sort((a, b) => a.at - b.at || a.k - b.k)
      .map(({ k: _k, ...s }) => s);
    return g.queries.map((q) => ({
      id: String(q._id),
      kind: q.kind ?? null,
      ability: q.ability ?? q.kind ?? "answer",
      question: String(q.text ?? ""),
      answer: String(q.answer ?? ""),
      date: q.date ?? null,
      asked: q.asked ?? q.date ?? null,
      sessions,
    }));
  });
}
