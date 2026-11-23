/**
 * The Search suite's harness (`evals/searchSuite.mjs`, `evals/searchCli.mjs`): notes laid over the bench, the scores,
 * a real-query part read, and the repo's real parts sound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HERE as REAL_DIR, PARTS as REAL_PARTS, readPart, realSetOf } from "../../../../packages/bench/benchmarks/search-real/source.mjs";
import { overlay, pathOf, searchScores, splitAddress } from "../evals/searchSuite.mjs";
import { REPO_BENCH_FOLDER } from "../folder.mjs";
import { readBenchFolder } from "../load.mjs";

const base = () => ({ people: [{ person: "Sam", workspace: "sam", personal: true, role: "owner" }], workspaces: { sam: { files: { "a.md": "A" }, heldBack: [], generated: [] } } });

test("an address is a workspace and a note path, or nothing", () => {
  assert.deepEqual(splitAddress("@sam/notes/a.md"), ["sam", "notes/a.md"]);
  assert.equal(splitAddress("sam/a.md"), null);
  assert.equal(splitAddress("@sam/a.txt"), null);
});

test("notes are laid over a copy, and a typo'd workspace fails loudly", () => {
  const bench = base();
  const laid = overlay(bench, { "@sam/b.md": "B" });
  assert.equal(laid.workspaces.sam.files["b.md"], "B");
  assert.equal(bench.workspaces.sam.files["b.md"], undefined, "the bench passed in is not changed");
  assert.throws(() => overlay(bench, { "@nobody/b.md": "B" }), /no workspace nobody/);
  const shared = overlay(bench, { "@club/c.md": "C" }, [{ person: "Sam", workspace: "club", personal: false, role: "member" }]);
  assert.equal(shared.workspaces.club.files["c.md"], "C");
});

test("scores: first, top 5, found, MRR and times; a privacy case counts only as a leak", () => {
  const records = [
    { id: "a", expect: ["@x/a.md"], hits: ["@x/a.md"], rank: 1, ms: 10 },
    { id: "b", expect: ["@x/b.md"], hits: ["@x/q.md", "@x/r.md", "@x/b.md"], rank: 3, ms: 30 },
    { id: "c", expect: ["@x/c.md"], hits: [], rank: null, ms: 20 },
    { id: "d", expect: ["@x/d.md"], hits: [1, 2, 3, 4, 5, "@x/d.md"], rank: 6, ms: 40 },
    { id: "p", expect: [], forbid: ["@x/secret.md"], hits: ["@x/secret.md"], rank: null, ms: 5 },
  ];
  const s = searchScores(records);
  assert.equal(s.n, 4);
  assert.equal(s.first, 1);
  assert.equal(s.top5, 2);
  assert.equal(s.found, 3);
  assert.equal(s.firstPct, 25);
  assert.equal(s.mrr, Math.round(1000 * (1 + 1 / 3 + 1 / 6) / 4) / 1000);
  assert.deepEqual(s.leaks, ["p"]);
  assert.equal(s.p50Ms, 20);
  assert.deepEqual(s.byPath, { unknown: 5 });
});

test("a search's path is read from the gateway's trace lines: object, database, index or scan", () => {
  assert.deepEqual(pathOf([{ objectSearch: "served", fast: true, indexed: true }]), { path: "object", object: "served" });
  assert.deepEqual(pathOf([{ objectSearch: "catching_up", fast: true, indexed: true }]), { path: "database", object: "catching_up" });
  assert.deepEqual(pathOf([{ fast: true, indexed: true }]), { path: "database", object: null });
  assert.deepEqual(pathOf([{ indexed: true, index: "words" }]), { path: "index", object: null });
  assert.deepEqual(pathOf([{ indexed: false }, { objectSearch: "served" }]), { path: "scan+object", object: "served" });
  assert.deepEqual(pathOf([]), { path: null, object: null });
});

test("a real-query part: cases need a query and an expected note, and shared notes must agree", () => {
  const one = { id: "r1", query: "q", as: "Priya", expect: ["@priya/a.md"], notes: { "@priya/a.md": "A" } };
  const set = realSetOf([one, { ...one, id: "r2" }]);
  assert.equal(set.cases.length, 2);
  assert.equal(set.cases[0].notes, undefined, "a case's notes move into the overlay");
  assert.throws(() => realSetOf([one, { ...one, id: "r2", notes: { "@priya/a.md": "other" } }]), /differs/);
  assert.throws(() => realSetOf([{ ...one, expect: [] }]), /expect/);
});

test("the repo's real parts are sound: unique ids, expected notes that exist, and no Test part here", async () => {
  const bench = await readBenchFolder(REPO_BENCH_FOLDER);
  const ids = new Set();
  assert.equal(existsSync(join(REAL_DIR, "test.json")), false, "the Test part lives only in the eval service");
  for (const part of REAL_PARTS) {
    if (!existsSync(join(REAL_DIR, `${part}.json`))) continue;
    const { notes, cases } = realSetOf(await readPart(part));
    const laid = overlay(bench, notes);
    for (const c of cases) {
      assert.ok(!ids.has(c.id), `${c.id} is used twice`);
      ids.add(c.id);
      for (const address of c.expect) {
        const [ws, path] = splitAddress(address) ?? [];
        assert.ok(laid.workspaces[ws]?.files[path] !== undefined, `${c.id}: ${address} exists nowhere`);
      }
      assert.ok(laid.people.some((row) => row.person === c.as && row.personal), `${c.id}: ${c.as} is a bench person`);
    }
  }
});

test("a real-set part is its file and every numbered file beside it, in order", async () => {
  const first = JSON.parse(readFileSync(join(REAL_DIR, "training.json"), "utf8"));
  const second = JSON.parse(readFileSync(join(REAL_DIR, "training-2.json"), "utf8"));
  const part = await readPart("training");
  assert.deepEqual(part.map((c) => c.id), [...first, ...second].map((c) => c.id));
});
