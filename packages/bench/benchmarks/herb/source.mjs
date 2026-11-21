/**
 * HERB: A PUBLIC BENCHMARK OF SEARCH OVER MESSY WORKPLACE DATA, AS ONE BEIR SET (Dev2, 2026-11-21: "look for a new
 * benchmark public that's better suited", then "ok, let's use herb then and see where we fall";
 * `docs/decisions/search/search-suite.md`).
 *
 * NanoBEIR's corpora are clean public text, one kind per set. What our own searches lose to is clutter: chat, meeting
 * transcripts and logs that share a word with the question and crowd out the note that answers it. HERB (Choubey et
 * al., Salesforce AI Research, EMNLP 2025 industry track, arXiv 2506.23139; `Salesforce/HERB` on Hugging Face, CC
 * BY-NC 4.0) is built for that: 30 made-up products, each with its team's Slack messages, meeting transcripts and
 * chats, documents, shared links and pull requests (39,772 artifacts in all), and 815 answerable questions about
 * content, people, customers, pull requests and links. Each question cites the artifacts its answer comes from.
 *
 * The licence lets us score with it, never ship it: the data is fetched into the run's folder and never kept in this
 * repository. Only our numbers are published.
 *
 * One set, as the paper's retrieval pool is one: every artifact of every product one document, kept as a note under
 * `herb/` (Slack under `herb/slack/<channel>/`, then `docs/`, `meetings/`, `chats/`, `links/`, `prs/`), and the people
 * and customers as documents too (`herb/people/`, `herb/customers/`), since a person's role and name live there and
 * not in the messages. A question's cited artifacts are its qrels and its type its `kind`. The `team` and `customers`
 * fields of a product are left out, as the dataset card says a retrieval run must. A question cites 11 to several
 * hundred artifacts (median 52), so Recall@10 is small by construction: nDCG@10 and right note first are the numbers.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fileOf } from "../../src/beir.mjs";
import { hubDataset, hubJson } from "../../src/hub.mjs";

export const REPO = "Salesforce/HERB";

/** HERB's question types, as the dataset names them, and how the Lab says them. */
export const TYPES = Object.freeze({ content: "content", person: "person", company: "customer", pr: "pull request", url: "link" });

/** The folder every artifact is a note under. */
export const FOLDER = "herb";

const say = (line) => process.stderr.write(`${line}\n`);
const text = (x) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x));

/**
 * HERB as the dataset has it: { revision, products: { <name>: <product file> }, employees, customers }, from
 * `dir/herb.json` when fetched before, else every product and metadata file from the Hub (and kept there).
 */
export async function loadRaw(dir, options = {}) {
  const file = join(dir, "herb.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const { revision, files } = await hubDataset(REPO, options);
  const productFiles = files.filter((f) => /^products\/[A-Za-z0-9]+\.json$/.test(f)).sort();
  if (productFiles.length === 0) throw new Error(`${REPO} lists no products/*.json`);
  const products = {};
  for (const path of productFiles) products[path.slice("products/".length, -".json".length)] = await hubJson(REPO, revision, path, options);
  const data = { revision, products, employees: await hubJson(REPO, revision, "metadata/employee.json", options), customers: await hubJson(REPO, revision, "metadata/customers_data.json", options) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.part`, JSON.stringify(data));
  renameSync(`${file}.part`, file);
  say(`fetched HERB: ${productFiles.length} products`);
  return data;
}

/** HERB as one BEIR set. `products` narrows to some products (tests, a local run). */
export function toBeir(data, { products = null } = {}) {
  const corpus = [];
  const people = data.employees ?? {};
  const who = (id) => (people[id]?.name ? `${people[id].name} (${id})` : text(id));
  const add = (id, folder, body) => corpus.push({ _id: text(id), title: "", text: body.trim(), path: `${FOLDER}/${folder}/${fileOf(id)}.md` });
  for (const [id, p] of Object.entries(people)) add(id, "people", `# ${text(p.name)}\n\n- id: ${id}\n- role: ${text(p.role)}\n- location: ${text(p.location)}\n- org: ${text(p.org)}`);
  for (const c of data.customers ?? []) add(c.id, "customers", `# ${text(c.name)}\n\n- id: ${text(c.id)}\n- role: ${text(c.role)}\n- company: ${text(c.company)}`);
  const names = Object.keys(data.products).filter((p) => products === null || products.includes(p)).sort();
  const queries = [];
  const qrels = {};
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
    (d.answerable_questions ?? []).forEach((q, i) => {
      const id = `${product}-${i + 1}`;
      queries.push({ _id: id, text: text(q.question), kind: TYPES[q.type] ?? text(q.type), product });
      for (const c of q.citations ?? []) (qrels[id] ??= {})[text(c)] = 1;
    });
  }
  return { id: "herb", revision: data.revision ?? null, corpus, queries, qrels, products: names };
}

/** The run's set: all of HERB, or the products `sets` names. */
export async function load({ dir, sets = null, ...options }) {
  const set = toBeir(await loadRaw(dir, options), { products: sets });
  say(`HERB: ${set.products.length} products, ${set.corpus.length} documents (artifacts and profiles), ${set.queries.length} questions${set.revision ? ` (revision ${set.revision.slice(0, 7)})` : ""}`);
  return [set];
}
