/**
 * HERB: A PUBLIC BENCHMARK OF SEARCH OVER MESSY WORKPLACE DATA (Dev2, 2026-11-21: "look for a new benchmark public
 * that's better suited", then "ok, let's use herb then and see where we fall"; `docs/decisions/search/search-suite.md`).
 *
 * NanoBEIR's corpora are clean public text, one kind per set. What our own searches lose to is clutter: chat, meeting
 * transcripts, forwarded mail and logs that share a word with the question and crowd out the note that answers it.
 * HERB (Choubey et al., Salesforce AI Research, EMNLP 2025 industry track, arXiv 2506.23139; `Salesforce/HERB` on
 * Hugging Face, CC BY-NC 4.0) is built for that: 30 made-up products, each with its team's Slack messages, meeting
 * transcripts and chats, documents, shared links and pull requests (39,772 artifacts in all), and 815 answerable
 * questions about content, people, customers, pull requests and links. Each question cites the artifacts its answer
 * comes from, and the paper finds retrieval is what holds every system back.
 *
 * The licence lets us score with it, never ship it: the data is downloaded into --fetch at run time and never kept
 * in this repository. Only our numbers are published.
 *
 * One world, as the paper's retrieval pool is one: Sam's empty personal workspace holding every artifact of every
 * product as one note (Slack under `herb/slack/<channel>/`, then `docs/`, `meetings/`, `chats/`, `links/`, `prs/`),
 * and the people and customers as notes too (`herb/people/`, `herb/customers/`), since a person's role and name live
 * there and not in the messages. Each question is one `search_notes` call as Sam on both ways production answers.
 * Only the embedder is called: a run costs embeddings and minutes, never Claude. The `team` and `customers` fields
 * of a product are left out, as the dataset card says a retrieval run must.
 *
 * Scored as NanoBEIR is (nDCG@10, Recall@10, MRR@10, right note first, top 5), with a cited artifact as a relevant
 * note, and per question type (content, person, customer, pull request, link) where NanoBEIR has its sets. A question
 * cites 11 to several hundred artifacts (median 52), so Recall@10 is small by construction: nDCG@10 and right note
 * first are the numbers to compare.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EVAL_PERSON, EVAL_WORKSPACE, evalBench } from "./memoryRun.mjs";
import { fileOf, irScores } from "./nanoBeir.mjs";
import { overlay, runSearchCases, searchScores } from "./searchSuite.mjs";

export const HERB_REPO = "Salesforce/HERB";

/** HERB's question types, as the dataset names them, and how the Lab says them. */
export const HERB_TYPES = Object.freeze({ content: "content", person: "person", company: "customer", pr: "pull request", url: "link" });

/** The folder every artifact is a note under, in Sam's personal workspace. */
export const HERB_FOLDER = "herb";

const HF = "https://huggingface.co";
const WAITS_MS = [2_000, 5_000, 15_000, 30_000];
const say = (line) => process.stderr.write(`${line}\n`);

async function fetchOk(url, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let tried = 0; ; tried += 1) {
    const response = await fetchImpl(url).catch((error) => ({ ok: false, status: String(error?.message ?? error) }));
    if (response.ok) return response;
    if (tried >= WAITS_MS.length) throw new Error(`${url}: ${response.status}`);
    await sleep(WAITS_MS[tried]);
  }
}

/**
 * HERB as { revision, products: { <name>: <product file> }, employees, customers }, from `dir/herb.json` when it was
 * fetched before, else every product and metadata file from the Hub at the revision it names (and kept there).
 */
export async function loadHerb(dir, options = {}) {
  const file = join(dir, "herb.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const info = await (await fetchOk(`${HF}/api/datasets/${HERB_REPO}`, options)).json();
  const revision = typeof info?.sha === "string" && /^[0-9a-f]{40}$/.test(info.sha) ? info.sha : "main";
  const files = (info?.siblings ?? []).map((f) => f?.rfilename).filter((f) => typeof f === "string");
  const get = async (path) => (await fetchOk(`${HF}/datasets/${HERB_REPO}/resolve/${revision}/${path}`, options)).json();
  const productFiles = files.filter((f) => /^products\/[A-Za-z0-9]+\.json$/.test(f)).sort();
  if (productFiles.length === 0) throw new Error(`${HERB_REPO} lists no products/*.json`);
  const products = {};
  for (const path of productFiles) products[path.slice("products/".length, -".json".length)] = await get(path);
  const data = { revision: revision === "main" ? null : revision, products, employees: await get("metadata/employee.json"), customers: await get("metadata/customers_data.json") };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, JSON.stringify(data));
  renameSync(`${file}.part`, file);
  say(`fetched HERB: ${productFiles.length} products`);
  return data;
}

const text = (x) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x));

/**
 * HERB as notes and cases. `notes` "@sam/herb/…/<artifact>.md" → the artifact as a person would keep it, a person's
 * id beside their name; per answerable question a case expecting the notes of the artifacts it cites. `products`
 * narrows to some products (tests, a local run); `n` takes that many questions spread evenly over all of them.
 */
export function herbWorldOf(data, { products = null, n = null } = {}) {
  const notes = {};
  const addressOf = new Map();
  const used = new Set();
  const people = data.employees ?? {};
  const who = (id) => (people[id]?.name ? `${people[id].name} (${id})` : text(id));
  const add = (artifactId, folder, body) => {
    let name = fileOf(artifactId);
    for (let k = 2; used.has(`${folder}/${name}`); k += 1) name = `${fileOf(artifactId)}-${k}`;
    used.add(`${folder}/${name}`);
    const address = `@${EVAL_WORKSPACE}/${HERB_FOLDER}/${folder}/${name}.md`;
    if (artifactId) addressOf.set(text(artifactId), address);
    notes[address] = `${body.trim()}\n`;
  };
  for (const [id, p] of Object.entries(people)) add(id, "people", `# ${text(p.name)}\n\n- id: ${id}\n- role: ${text(p.role)}\n- location: ${text(p.location)}\n- org: ${text(p.org)}`);
  for (const c of data.customers ?? []) add(c.id, "customers", `# ${text(c.name)}\n\n- id: ${text(c.id)}\n- role: ${text(c.role)}\n- company: ${text(c.company)}`);
  const names = Object.keys(data.products).filter((p) => products === null || products.includes(p)).sort();
  const questions = [];
  for (const product of names) {
    const d = data.products[product];
    for (const s of d.slack ?? []) {
      const channel = text(s.Channel?.name) || "channel";
      const m = s.Message?.User ?? {};
      add(s.id, `slack/${fileOf(channel)}`, `# #${channel}\n\n${who(m.userId)} · ${text(m.timestamp)}\n\n${text(m.text)}`);
    }
    for (const doc of d.documents ?? []) add(doc.id, "docs", `# ${text(doc.type) || "Document"}: ${text(doc.id)}\n\nBy ${who(doc.author)} · ${text(doc.date)}\n${doc.document_link ? `Link: ${text(doc.document_link)}\n` : ""}\n${text(doc.content)}`);
    for (const t of d.meeting_transcripts ?? []) add(t.id, "meetings", `# ${text(t.document_type) || "Meeting"}: ${text(t.id)}\n\n${text(t.date)} · ${(t.participants ?? []).map(who).join(", ")}\n\n${text(t.transcript)}`);
    for (const c of d.meeting_chats ?? []) add(c.id, "chats", `# Meeting chat: ${text(c.id)}\n\n${text(c.date)}\n\n${text(c.transcript ?? c.chat ?? c.content ?? JSON.stringify(c))}`);
    for (const u of d.urls ?? []) add(u.id, "links", `# ${text(u.description) || text(u.link)}\n\n${text(u.link)}`);
    for (const pr of d.prs ?? []) {
      const reviews = (pr.reviews ?? []).map((r) => `- ${text(r.state)} by ${text(r.user?.login)}: ${text(r.comment)}`).join("\n");
      add(pr.id, "prs", `# ${text(pr.title)}\n\n${text(pr.link)} · #${text(pr.number)} · ${text(pr.state)}${pr.merged === "True" ? ", merged" : ""} · by ${text(pr.user?.login)} · ${text(pr.created_at)}\n\n${text(pr.summary)}${reviews ? `\n\nReviews:\n${reviews}` : ""}`);
    }
    (d.answerable_questions ?? []).forEach((q, i) => questions.push({ id: `${product}-${i + 1}`, product, ...q }));
  }
  // `n` spread evenly over every product's questions, so a short run still sees every product and type.
  const chosen = n === null || n >= questions.length ? questions : Array.from({ length: n }, (_, i) => questions[Math.floor(((i + 0.5) * questions.length) / n)]);
  const cases = chosen.map((q) => ({
    id: q.id,
    query: text(q.question),
    as: EVAL_PERSON,
    kind: HERB_TYPES[q.type] ?? text(q.type),
    expect: (q.citations ?? []).map((c) => addressOf.get(text(c))).filter(Boolean),
  }));
  return { notes, cases, products: names, artifacts: addressOf.size };
}

/**
 * The scores of a HERB run, in NanoBEIR's summary shape so the Lab shows it the same way: `searchScores` over every
 * question, nDCG@10, Recall@10 and MRR@10 as the mean over question types, the object world's nDCG@10 beside it, and
 * `bySet` per question type. HERB has no BM25 list, so `bm25Ndcg10` is null.
 */
export function herbScores(records) {
  const r3 = (x) => (x === null ? null : Math.round(1000 * x) / 1000);
  const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
  const bySet = {};
  for (const kind of [...new Set(records.map((r) => r.kind))]) {
    const group = records.filter((r) => r.kind === kind);
    const object = group.some((r) => r.object && typeof r.object === "object") ? irScores(group.filter((r) => r.object), (r) => r.object.hits) : null;
    bySet[kind] = { n: group.length, ...irScores(group), firstPct: searchScores(group).firstPct, bm25Ndcg10: null, ...(object ? { objectNdcg10: object.ndcg10 } : {}) };
  }
  const avg = (key) => r3(mean(Object.values(bySet).map((s) => s[key]).filter((x) => typeof x === "number")));
  return {
    ...searchScores(records),
    ndcg10: avg("ndcg10"),
    recall10: avg("recall10"),
    mrr10: avg("mrr10"),
    bm25Ndcg10: null,
    ...(Object.values(bySet).some((s) => s.objectNdcg10 !== undefined) ? { objectNdcg10: avg("objectNdcg10") } : {}),
    bySet,
  };
}

/** Run HERB through search: one world of every artifact, `n` questions (null = all 815). */
export async function runHerb({ dir, n = null, products = null, ai, objects = true, log = say }) {
  const data = await loadHerb(dir);
  const world = herbWorldOf(data, { products, n });
  log(`HERB: ${world.products.length} products, ${Object.keys(world.notes).length} notes (${world.artifacts} artifacts and profiles), ${world.cases.length} questions${data.revision ? ` (revision ${data.revision.slice(0, 7)})` : ""}`);
  const started = Date.now();
  const records = await runSearchCases({ bench: overlay(evalBench(), world.notes), cases: world.cases, ai, objects, log: () => {} });
  const search = herbScores(records);
  log(`HERB: nDCG@10 ${search.ndcg10}${search.objectNdcg10 !== undefined ? ` (objects ${search.objectNdcg10})` : ""}, right note first ${search.firstPct}% in ${Math.round((Date.now() - started) / 1000)} s; ${Object.entries(search.bySet).map(([k, v]) => `${k} ${v.ndcg10}`).join(", ")}`);
  return { records, search };
}
