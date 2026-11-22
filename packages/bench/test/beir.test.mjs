/**
 * The benchmarks' package: BEIR's format written and read back, a set as notes and cases (one world per haystack) and
 * as memory cases, BEIR's scores as its evaluator computes them, every folder's source on made-up data (the real data
 * is only ever fetched at run time), and the folders' list.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { beirOf, load as loadLongMemEval, slugOf } from "../benchmarks/longmemeval/source.mjs";
import { loadRaw as loadHerb, toBeir as herbBeir } from "../benchmarks/herb/source.mjs";
import { FOLDERS, SPLIT, keptDocuments, sliceCorpus, slugOf as noteSlug, splitSet, toBeir as erbBeir } from "../benchmarks/enterprise-rag-notes/source.mjs";
import { loadSet as loadNanoSet, SETS as NANO_SETS } from "../benchmarks/nanobeir/source.mjs";
import { beirWorld, beirWorlds, fileOf, memoryCases, readBeir, relevantOf, writeBeir } from "../src/beir.mjs";
import { mrrAt, ndcgAt, recallAt } from "../src/score.mjs";
import { build, problemsOf } from "../scripts/registry.mjs";

const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

test("nDCG@10 is BEIR's: binary gains, log2 discount, the ideal list puts every relevant note first", () => {
  assert.equal(ndcgAt(["a", "b"], ["a"]), 1);
  assert.equal(ndcgAt(["x", "a"], ["a"]).toFixed(4), (1 / Math.log2(3)).toFixed(4));
  assert.equal(ndcgAt(["a", "x"], ["a", "b"]).toFixed(4), (1 / (1 + 1 / Math.log2(3))).toFixed(4));
  // Past the tenth place counts for nothing, and a note listed twice counts once.
  assert.equal(ndcgAt([..."0123456789".split(""), "a"], ["a"]), 0);
  assert.equal(ndcgAt(["a", "a", "b"], ["a", "b"]), 1);
  assert.equal(ndcgAt([], ["a"]), 0);
  assert.equal(recallAt(["a", "x", "b"], ["a", "b", "c", "d"]), 0.5);
  assert.equal(mrrAt(["x", "y", "a"], ["a"]).toFixed(4), (1 / 3).toFixed(4));
  assert.equal(mrrAt(["x"], ["a"]), 0);
});

const SET = {
  id: "t",
  revision: "a".repeat(40),
  corpus: [
    { _id: "a/b", title: "", text: "one" },
    { _id: "a-b", title: "Two", text: "two" },
    { _id: "p", title: "Plan", text: "the plan", path: "projects/launch/plan.md", workspace: "team" },
  ],
  queries: [
    { _id: "q", text: "two", bm25: ["a/b", "a-b"] },
    { _id: "q2", text: "plan", kind: "project", as: "Ada" },
    { _id: "q3", text: "nothing judged" },
  ],
  qrels: { q: { "a-b": 1 }, q2: { p: 2, gone: 1 } },
};

test("BEIR's three files are written whole and read back the same", () => {
  const dir = tmp("beir");
  try {
    writeBeir(dir, SET);
    for (const f of ["corpus.jsonl", "queries.jsonl", "qrels/test.tsv", "set.json"]) assert.ok(existsSync(join(dir, f)), f);
    assert.match(readFileSync(join(dir, "qrels/test.tsv"), "utf8"), /^query-id\tcorpus-id\tscore\nq\ta-b\t1\n/);
    assert.deepEqual(readBeir(dir), SET);
    assert.equal(readBeir(join(dir, "none")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a set is notes and cases: a document id is a safe file name, clashes both kept, a path and a workspace honoured", () => {
  assert.equal(fileOf("doc57226"), "doc57226");
  assert.equal(fileOf("../etc/passwd"), "---etc-passwd");
  assert.equal(fileOf(""), "doc");
  const { notes, cases } = beirWorld(SET);
  assert.deepEqual(Object.keys(notes), ["@sam/beir/a-b.md", "@sam/beir/a-b-2.md", "@team/projects/launch/plan.md"]);
  assert.equal(notes["@sam/beir/a-b-2.md"], "# Two\n\ntwo\n");
  // A query no document is judged relevant to is dropped, as BEIR's evaluator does.
  assert.deepEqual(cases.map((c) => c.id), ["t-q", "t-q2"]);
  assert.deepEqual(cases[0], { id: "t-q", query: "two", as: "Sam", kind: "t", expect: ["@sam/beir/a-b-2.md"], missing: [], bm25: ["@sam/beir/a-b.md", "@sam/beir/a-b-2.md"] });
  // A judged document the set has no text for is named missing, never silently dropped.
  assert.deepEqual({ as: cases[1].as, kind: cases[1].kind, expect: cases[1].expect, missing: cases[1].missing }, { as: "Ada", kind: "project", expect: ["@team/projects/launch/plan.md"], missing: ["gone"] });
  assert.deepEqual(beirWorld(SET, { caseIds: "query", n: 1 }).cases.map((c) => c.id), ["q"]);
  assert.deepEqual(relevantOf(SET, "q2"), ["p", "gone"]);
});

const lme = {
  question_id: "lme-1",
  question_type: "single-session-user",
  question: "Which bicycle did I buy?",
  answer: "A red bicycle",
  question_date: "2023/05/20 (Sat) 02:21",
  answer_session_ids: ["bike", "lost"],
  haystack_session_ids: ["a b", "bike", "a-b"],
  haystack_dates: ["2023/05/01 (Mon) 09:00", "2023/05/01 (Mon) 10:00", "2023/05/01 (Mon) 11:00"],
  haystack_sessions: [[{ role: "user", content: "pancakes" }], [{ role: "user", content: "I bought a red bicycle." }], [{ role: "user", content: "ferns" }]],
};

test("a LongMemEval question is its own haystack: dated sessions as notes, the answer sessions its qrels", () => {
  assert.equal(slugOf("Plant Care/2"), "plant-care-2");
  assert.equal(slugOf("!!!"), "session");
  const one = beirOf(lme);
  const set = { id: "longmemeval-retrieval", corpus: one.corpus, queries: [one.query], qrels: one.qrels };
  const [world, ...rest] = beirWorlds(set, { caseIds: "query", folder: "inbox/sessions/longmemeval" });
  assert.equal(rest.length, 0);
  assert.equal(world.id, "lme-1");
  assert.equal(world.today, "2023-05-20");
  assert.deepEqual(Object.keys(world.notes), ["@sam/inbox/sessions/longmemeval/2023-05-01-a-b.md", "@sam/inbox/sessions/longmemeval/2023-05-01-bike.md", "@sam/inbox/sessions/longmemeval/2023-05-01-a-b-2.md"]);
  assert.match(world.notes["@sam/inbox/sessions/longmemeval/2023-05-01-bike.md"], /^---\ntitle: "Chat 2023-05-01"\ndate: 2023-05-01\n---\n\n\*\*User:\*\* I bought a red bicycle\.\n$/);
  const [c] = world.cases;
  assert.deepEqual({ id: c.id, ability: c.ability, expect: c.expect, missing: c.missing }, { id: "lme-1", ability: "extraction", expect: ["@sam/inbox/sessions/longmemeval/2023-05-01-bike.md"], missing: ["lme-1/lost"] });
});

test("the same set is memory cases: each question with its own sessions, oldest first, and its answer", () => {
  const two = beirOf({ ...lme, question_id: "lme-2", haystack_dates: ["2023/05/03 (Wed) 09:00", "2023/05/02 (Tue) 09:00", "2023/05/04 (Thu) 09:00"] });
  const one = beirOf(lme);
  const set = { id: "x", corpus: [...one.corpus, ...two.corpus], queries: [one.query, two.query], qrels: { ...one.qrels, ...two.qrels } };
  const cases = memoryCases(set);
  assert.deepEqual(cases.map((c) => c.id), ["lme-1", "lme-2"]);
  assert.equal(cases[0].answer, "A red bicycle");
  assert.equal(cases[0].asked, "2023/05/20 (Sat) 02:21");
  assert.equal(cases[0].date, "2023-05-20T02:21:00.000Z");
  assert.deepEqual(cases[1].sessions.map((s) => s.id), ["bike", "a b", "a-b"], "each question's own sessions, by date");
  assert.equal(cases[1].sessions[0].content, "**User:** I bought a red bicycle.");
});

test("LongMemEval's run set: the same stratified slice, abstention left out of retrieval, total what it sliced from", async () => {
  const dir = tmp("lme");
  try {
    const { writeFileSync } = await import("node:fs");
    const items = [lme, { ...lme, question_id: "lme-9_abs" }];
    writeFileSync(join(dir, "data.json"), JSON.stringify(items));
    const [search] = await loadLongMemEval({ run: { id: "longmemeval-retrieval", kind: "search", file: "longmemeval-s" }, data: join(dir, "data.json") });
    assert.equal(search.total, 1);
    assert.deepEqual(search.queries.map((q) => q._id), ["lme-1"]);
    const [memory] = await loadLongMemEval({ run: { id: "longmemeval-s", kind: "memory" }, data: join(dir, "data.json"), n: 2 });
    assert.equal(memory.total, 2);
    assert.equal(memory.queries.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a NanoBEIR set is read from its parquet files at the Hub's revision, a busy answer tried again, kept as BEIR's files", async () => {
  const dir = tmp("nanobeir");
  const sha = "a".repeat(40);
  const tables = {
    corpus: Array.from({ length: 130 }, (_, i) => ({ _id: `d${i}`, text: `text ${i}` })),
    queries: [{ _id: "q1", text: "text 5" }, { _id: "q2", text: "nothing" }],
    relevance: [{ "query-id": "q1", "positive-corpus-ids": ["d5"], "bm25-ranked-ids": ["d5", "d1"] }],
  };
  const asked = [];
  let busy = true;
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith("/api/datasets/sentence-transformers/NanoSciFact-bm25")) {
      return new Response(JSON.stringify({ sha, siblings: ["README.md", "corpus/train-00000-of-00001.parquet", "queries/train-00000-of-00001.parquet", "relevance/train-00000-of-00001.parquet"].map((rfilename) => ({ rfilename })) }));
    }
    if (url.includes("/corpus/") && busy) {
      busy = false;
      return new Response("busy", { status: 503 });
    }
    const config = /resolve\/[0-9a-f]{40}\/(\w+)\//.exec(url)?.[1];
    return new Response(JSON.stringify(tables[config]));
  };
  const readParquet = async (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  try {
    assert.equal(NANO_SETS.length, 13);
    const data = await loadNanoSet("scifact", dir, { fetchImpl, readParquet, sleep: async () => {} });
    assert.equal(data.revision, sha);
    assert.ok(asked.every((u) => !u.includes("/resolve/") || u.includes(`/resolve/${sha}/`)), "files are read at the pinned revision");
    assert.equal(data.corpus.length, 130);
    assert.deepEqual(data.queries, [{ _id: "q1", text: "text 5", bm25: ["d5", "d1"] }]);
    assert.deepEqual(data.qrels, { q1: { d5: 1 } });
    assert.ok(existsSync(join(dir, "nanobeir", "scifact", "corpus.jsonl")), "kept as BEIR's own files");
    const again = asked.length;
    assert.deepEqual(await loadNanoSet("scifact", dir, { fetchImpl, readParquet }), data);
    assert.equal(asked.length, again, "a kept set is not fetched again");
    await assert.rejects(loadNanoSet("nope", dir, { fetchImpl }), /no NanoBEIR set nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const herb = {
  revision: null,
  employees: { eid_a1: { employee_id: "eid_a1", name: "Ada Park", role: "QA Specialist", location: "Austin", org: "slack" } },
  customers: [{ id: "CUST-0001", name: "Bo Reyes", role: "Product Manager", company: "BlueWave" }],
  products: {
    AlphaForce: {
      team: ["eid_a1"],
      customers: ["CUST-0001"],
      slack: [{ Channel: { name: "planning-alpha" }, Message: { User: { userId: "eid_a1", timestamp: "2026-03-12T08:24:00", text: "QA found a login bug in the last release." } }, id: "20260312-0-aaaaa" }],
      documents: [{ id: "alpha_spec", type: "Spec", author: "eid_a1", date: "2026-03-01", content: "Alpha spec text." }],
      meeting_transcripts: [{ id: "alpha_meet_1", document_type: "Planning", date: "2026-03-02", participants: ["eid_a1"], transcript: "We agreed to fix login." }],
      urls: [{ id: "alpha_demo", link: "https://example.test/demo", description: "A demo video." }],
      prs: [{ id: "alpha_pr_1", title: "Fix login", link: "https://example.test/pr/1", number: "1", state: "closed", merged: "True", user: { login: "EMP_1" }, summary: "Fixes the login bug.", reviews: [{ state: "APPROVED", user: { login: "EMP_2" }, comment: "ok" }] }],
      answerable_questions: [
        { question: "What issues did QA report for AlphaForce?", citations: ["20260312-0-aaaaa", "alpha_meet_1"], type: "content" },
        { question: "Which PRs fixed login in AlphaForce?", citations: ["alpha_pr_1"], type: "pr" },
      ],
      unanswerable_questions: [{ question: "Not answerable?" }],
    },
    BetaForce: { slack: [], documents: [], meeting_transcripts: [], urls: [], prs: [], answerable_questions: [{ question: "Who owns BetaForce?", citations: ["missing_id"], type: "person" }] },
  },
};

test("HERB is one BEIR set: every artifact a document under herb/, a person's id beside their name, citations its qrels", () => {
  const set = herbBeir(herb);
  assert.deepEqual(set.products, ["AlphaForce", "BetaForce"]);
  const { notes, cases } = beirWorld(set, { folder: "herb", caseIds: "query" });
  assert.ok(notes["@sam/herb/slack/planning-alpha/20260312-0-aaaaa.md"].includes("Ada Park (eid_a1)"));
  assert.ok(notes["@sam/herb/people/eid_a1.md"] && notes["@sam/herb/customers/CUST-0001.md"]);
  assert.match(notes["@sam/herb/prs/alpha_pr_1.md"], /merged/);
  assert.deepEqual(cases[0].expect, ["@sam/herb/slack/planning-alpha/20260312-0-aaaaa.md", "@sam/herb/meetings/alpha_meet_1.md"]);
  assert.equal(cases[1].kind, "pull request");
  // A citation that names no artifact expects nothing, so the question is not scored rather than failed forever.
  assert.deepEqual(cases[2].expect, []);
  assert.deepEqual(cases[2].missing, ["missing_id"]);
  // The product's own team and customer lists are never laid out: the dataset card says a retrieval run must not use them.
  assert.ok(!Object.values(notes).some((t) => /"team"|CUST-0001", /.test(t)));
  assert.deepEqual(beirWorld(set, { caseIds: "query", n: 2, slice: "spread" }).cases.map((c) => c.id), ["AlphaForce-1", "BetaForce-1"]);
  const alpha = herbBeir(herb, { products: ["AlphaForce"] });
  assert.equal(alpha.queries.length, 2);
});

test("HERB's download reads every product and the metadata at the revision the Hub names, then keeps it", async () => {
  const dir = tmp("herb");
  const sha = "a".repeat(40);
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith("/api/datasets/Salesforce/HERB")) return Response.json({ sha, siblings: [{ rfilename: "products/AlphaForce.json" }, { rfilename: "README.md" }, { rfilename: "metadata/employee.json" }] });
    if (url.endsWith("products/AlphaForce.json")) return Response.json(herb.products.AlphaForce);
    if (url.endsWith("metadata/employee.json")) return Response.json(herb.employees);
    if (url.endsWith("metadata/customers_data.json")) return Response.json(herb.customers);
    return new Response("no", { status: 404 });
  };
  try {
    const got = await loadHerb(dir, { fetchImpl, sleep: async () => {} });
    assert.deepEqual(Object.keys(got.products), ["AlphaForce"]);
    assert.equal(got.revision, sha);
    assert.ok(asked.every((u) => !u.includes("/resolve/") || u.includes(`/resolve/${sha}/`)));
    assert.ok(existsSync(join(dir, "herb.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every folder checks, run ids are unique, and a folder missing what it must say is refused by name", async () => {
  const { benchmarks, runs } = await build();
  assert.ok(benchmarks.length >= 5);
  assert.equal(new Set(runs.map((r) => r.id)).size, runs.length);
  for (const r of runs) assert.equal(r.search, r.kind === "search");
  assert.deepEqual(runs.find((r) => r.id === "nanobeir-gate")?.sets, ["msmarco", "nq", "fiqa", "scifact"]);
  const good = { id: "x", title: "X", about: "a", kind: "search", format: "beir", score: "beir", source: { name: "n", license: "MIT" }, runs: [{ id: "x", variant: "v", total: 3, about: "a" }] };
  assert.deepEqual(problemsOf("x", good), []);
  assert.match(problemsOf("x", { ...good, source: { name: "n" } }).join(), /license/);
  assert.match(problemsOf("y", good).join(), /folder's name/);
  assert.match(problemsOf("x", { ...good, runs: [{ id: "x", variant: "v", total: 0, about: "a" }] }).join(), /total/);
  assert.match(problemsOf("x", { ...good, score: "nope" }).join(), /score/);
  // The committed list is what the folders build.
  const listed = JSON.parse(readFileSync(new URL("../benchmarks.generated.json", import.meta.url), "utf8"));
  assert.deepEqual(listed, { benchmarks, runs });
});

test("EnterpriseRAG Notes reads only the kept tools' rows, files each in its PARA folder, and drops every question citing Slack or email", async () => {
  const rows = [
    { doc_id: "c1", source_type: "confluence", title: "Billing Runbook!", content: "How refunds work." },
    { doc_id: "c2", source_type: "confluence", title: "Onboarding", content: "Day one." },
    { doc_id: "g1", source_type: "gmail", title: "Re: refunds", content: "mail" },
    { doc_id: "l1", source_type: "linear", title: "Refund bug", content: "Fix it." },
    { doc_id: "s1", source_type: "slack", title: "#general", content: "chat" },
  ];
  const asked = [];
  const readRows = async ({ columns, rowStart = 0, rowEnd = rows.length }) => {
    asked.push(columns ? "tools" : `${rowStart}-${rowEnd}`);
    return rows.slice(rowStart, rowEnd).map((r) => (columns ? { source_type: r.source_type } : r));
  };
  const documents = await keptDocuments(readRows);
  assert.deepEqual(asked, ["tools", "0-2", "3-4"], "the email and chat rows are never read");
  assert.deepEqual(documents.map((d) => d.doc_id), ["c1", "c2", "l1"]);
  const set = erbBeir({
    revision: "r",
    documents,
    questions: [
      { question_id: "q1", question: "How do refunds work?", question_type: "basic", source_types: ["confluence"], expected_doc_ids: ["c1"], gold_answer: "Like so." },
      { question_id: "q2", question: "What did the email say?", question_type: "basic", source_types: ["confluence", "gmail"], expected_doc_ids: ["c1", "g1"] },
      { question_id: "q3", question: "Is there a ticket?", question_type: "info_not_found", source_types: [], expected_doc_ids: [] },
    ],
  });
  assert.equal(set.corpus[0].path, `${FOLDERS.confluence}/billing-runbook.md`);
  assert.equal(set.corpus[2].path, "projects/issues/refund-bug.md");
  assert.deepEqual(set.queries.map((q) => q._id), ["q1", "q3"]);
  assert.deepEqual(set.qrels, { q1: { c1: 1 } }, "a question with nothing cited is kept for memory, never scored for search");
  assert.equal(noteSlug("  ", "dsid_1"), "dsid_1");
  const world = beirWorld(set, { folder: "resources" });
  assert.ok(world.notes["@sam/resources/wiki/billing-runbook.md"].startsWith("# Billing Runbook!"));
  assert.deepEqual(world.cases.map((c) => c.expect), [["@sam/resources/wiki/billing-runbook.md"]]);
  assert.deepEqual(world.people, [], "one workspace: nobody else to reach");
  // The split run: each note in its tool's workspace, and the searcher a member of every shared one.
  const split = beirWorld(splitSet(set), { folder: "resources" });
  assert.ok(split.notes[`@${SPLIT.confluence}/resources/wiki/billing-runbook.md`]);
  assert.ok(split.notes[`@${SPLIT.linear}/projects/issues/refund-bug.md`]);
  assert.deepEqual(split.cases.map((c) => c.expect), [[`@${SPLIT.confluence}/resources/wiki/billing-runbook.md`]]);
  assert.deepEqual(
    split.people,
    ["acme-eng", "acme-wiki"].map((workspace) => ({ person: "Sam", workspace, personal: false, role: "member" })),
  );
});

test("EnterpriseRAG Notes' everyday slice keeps every cited note, then the closest-titled of each tool, the same every run", () => {
  const corpus = [{ _id: "cited", title: "Refund policy", tool: "confluence" }];
  for (let i = 0; i < 20; i += 1) corpus.push({ _id: `w${i}`, title: i < 3 ? `Refund process ${i}` : `Holiday party ${i}`, tool: "confluence" });
  for (let i = 0; i < 20; i += 1) corpus.push({ _id: `l${i}`, title: `Ticket ${i}`, tool: "linear" });
  const set = { corpus, queries: [{ _id: "q", text: "What is the refund process?", tools: ["confluence"] }], qrels: { q: { cited: 1 } } };
  const cut = sliceCorpus(set, 11);
  const ids = cut.corpus.map((d) => d._id);
  assert.ok(ids.includes("cited"));
  for (const id of ["w0", "w1", "w2"]) assert.ok(ids.includes(id), `${id} shares the question's words`);
  assert.equal(ids.filter((id) => id.startsWith("l")).length, 5, "each tool in proportion to its size");
  assert.deepEqual(sliceCorpus(set, 11).corpus, cut.corpus);
  assert.equal(sliceCorpus(set, null), set);
});
