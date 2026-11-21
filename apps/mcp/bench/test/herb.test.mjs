// HERB (`bench/evals/herb.mjs`): Salesforce's public workplace benchmark laid out as notes, scored as NanoBEIR is.
// The fixture is made up and tiny; the real data is only ever downloaded at run time (CC BY-NC 4.0).
import test from "node:test";
import assert from "node:assert/strict";
import { herbScores, herbWorldOf, loadHerb } from "../evals/herb.mjs";

const data = {
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
        { question: "What issues did QA report for AlphaForce?", ground_truth: ["login bug"], citations: ["20260312-0-aaaaa", "alpha_meet_1"], type: "content" },
        { question: "Which PRs fixed login in AlphaForce?", ground_truth: ["https://example.test/pr/1"], citations: ["alpha_pr_1"], type: "pr" },
      ],
      unanswerable_questions: [{ question: "Not answerable?" }],
    },
    BetaForce: { slack: [], documents: [], meeting_transcripts: [], urls: [], prs: [], answerable_questions: [{ question: "Who owns BetaForce?", citations: ["missing_id"], type: "person" }] },
  },
};

test("every artifact is one note, a person's id beside their name, and a question expects the notes it cites", () => {
  const w = herbWorldOf(data);
  assert.equal(w.products.join(","), "AlphaForce,BetaForce");
  const paths = Object.keys(w.notes);
  assert.ok(paths.includes("@sam/herb/slack/planning-alpha/20260312-0-aaaaa.md"));
  assert.ok(paths.includes("@sam/herb/people/eid_a1.md") && paths.includes("@sam/herb/customers/CUST-0001.md"));
  assert.match(w.notes["@sam/herb/slack/planning-alpha/20260312-0-aaaaa.md"], /Ada Park \(eid_a1\)/);
  assert.match(w.notes["@sam/herb/prs/alpha_pr_1.md"], /merged/);
  assert.deepEqual(w.cases[0].expect, ["@sam/herb/slack/planning-alpha/20260312-0-aaaaa.md", "@sam/herb/meetings/alpha_meet_1.md"]);
  assert.equal(w.cases[1].kind, "pull request");
  // A citation that names no artifact expects nothing, so the question is not scored rather than failed forever.
  assert.deepEqual(w.cases[2].expect, []);
  // The product's own team and customer lists are never laid out: the dataset card says a retrieval run must not use them.
  assert.ok(!Object.values(w.notes).some((t) => /"team"|CUST-0001", /.test(t)));
  assert.equal(w.cases.length, 3);
});

test("a short run takes questions spread over every product, and products narrows the pool", () => {
  assert.deepEqual(herbWorldOf(data, { n: 2 }).cases.map((c) => c.id), ["AlphaForce-1", "BetaForce-1"]);
  const alpha = herbWorldOf(data, { products: ["AlphaForce"] });
  assert.equal(alpha.cases.length, 2);
  assert.ok(!Object.keys(alpha.notes).some((p) => p.includes("BetaForce")));
});

test("scores are NanoBEIR's shape per question type, with no BM25 row", () => {
  const a = "@sam/herb/a.md";
  const b = "@sam/herb/b.md";
  const records = [
    { kind: "content", expect: [a], hits: [a, b], rank: 1, ms: 10, object: { hits: [b, a], rank: 2, ms: 5 } },
    { kind: "person", expect: [b], hits: [a], rank: null, ms: 20, object: { hits: [b], rank: 1, ms: 5 } },
  ];
  const s = herbScores(records);
  assert.equal(s.bm25Ndcg10, null);
  assert.equal(s.bySet.content.ndcg10, 1);
  assert.equal(s.bySet.person.ndcg10, 0);
  assert.equal(s.ndcg10, 0.5);
  assert.equal(s.bySet.person.objectNdcg10, 1);
});

test("the download reads every product and the metadata at the revision the Hub names, then keeps it", async (t) => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "herb-"));
  const sha = "a".repeat(40);
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url.endsWith("/api/datasets/Salesforce/HERB")) return Response.json({ sha, siblings: [{ rfilename: "products/AlphaForce.json" }, { rfilename: "README.md" }, { rfilename: "metadata/employee.json" }] });
    if (url.endsWith("products/AlphaForce.json")) return Response.json(data.products.AlphaForce);
    if (url.endsWith("metadata/employee.json")) return Response.json(data.employees);
    if (url.endsWith("metadata/customers_data.json")) return Response.json(data.customers);
    return new Response("no", { status: 404 });
  };
  const got = await loadHerb(dir, { fetchImpl, sleep: async () => {} });
  assert.deepEqual(Object.keys(got.products), ["AlphaForce"]);
  assert.equal(got.revision, sha);
  assert.ok(asked.every((u) => !u.includes("/resolve/") || u.includes(`/resolve/${sha}/`)));
  assert.ok(existsSync(join(dir, "herb.json")));
  t.diagnostic(`asked ${asked.length}`);
});
