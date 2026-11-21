/**
 * The hard search set (`packages/bench/benchmarks/search-hard/`): forty questions, every kind used, every expected
 * note real, none of them in an archive, and a small end-to-end run of the first three through the search suite
 * (`evals/searchSuite.mjs`) with the fake embedder, on the bench with the set's notes laid in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { KINDS as HARD_KINDS, loadHardSet } from "../../../../packages/bench/benchmarks/search-hard/source.mjs";
import { missingExpected } from "../evals/searchCli.mjs";
import { embedderFor, overlay, runSearchCases } from "../evals/searchSuite.mjs";
import { REPO_BENCH_FOLDER } from "../folder.mjs";
import { expandWorkspaces, parseTest, readBenchFolder } from "../load.mjs";

const set = await loadHardSet({ parseTest });

test("the hard set has forty questions, numbered and run as Priya", () => {
  assert.equal(set.cases.length, 40);
  assert.deepEqual(set.cases.map((c) => c.id), Array.from({ length: 40 }, (_, i) => `hard-${i + 1}`));
  assert.equal(set.runAs, "Priya");
  assert.equal(set.today, "2026-10-08");
});

test("every kind is used, and no kind is unknown", () => {
  const used = new Set(set.cases.map((c) => c.kind));
  for (const kind of HARD_KINDS) assert.ok(used.has(kind), `no question of kind ${kind}`);
  for (const kind of used) assert.ok(HARD_KINDS.includes(kind), `unknown kind ${kind}`);
});

test("every expected note exists, as an overlay note or in the bench", async () => {
  const bench = overlay(expandWorkspaces(await readBenchFolder(REPO_BENCH_FOLDER)), set.notes);
  assert.deepEqual(missingExpected(bench, set.cases), []);
  for (const c of set.cases) {
    assert.ok(c.expect.length >= 1 && c.expect.length <= 2, `${c.id} expects ${c.expect.length} notes`);
  }
});

test("no expected note is in an archive", () => {
  for (const c of set.cases) {
    for (const address of c.expect) {
      assert.doesNotMatch(address, /\/archive\//, `${c.id} expects an archived note ${address}`);
    }
  }
});

test("question 1 is the reading list rewrite, with the handoff note that quotes it as a distractor", () => {
  const first = set.cases[0];
  assert.equal(first.query, "band leaders reading list");
  assert.deepEqual(first.expect, ["@priya/resources/books/band-leader-reading-list.md"]);
  assert.match(set.notes["@day-job/areas/bots/assistant-handoff-2026-10-02.md"], /band leaders reading list/);
});

test("the first three cases run end to end with the fake embedder and come back with hits", async () => {
  const bench = overlay(expandWorkspaces(await readBenchFolder(REPO_BENCH_FOLDER)), set.notes);
  const records = await runSearchCases({
    bench,
    cases: set.cases.slice(0, 3),
    ai: embedderFor({ fake: true }),
    today: set.today,
  });
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.ok(Array.isArray(record.hits), `${record.id} has no hits array`);
    assert.equal(record.error, null, `${record.id} failed: ${record.error}`);
    assert.ok(record.expect.length >= 1);
  }
});
