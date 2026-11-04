// Tests for bench/webExact.mjs: the question set's shape, each normalizer on
// a few spellings, the scorer's misses, and the dry run end to end (no key,
// no network: a scripted model and fixture pages through the real runTurn).
import { test } from "node:test";
import assert from "node:assert/strict";

import { NORMALIZERS, QUESTIONS, runSet, scoreAnswer } from "../webExact.mjs";

test("twenty questions, each with a gold value, a source, a normalizer and a date checked", () => {
  assert.equal(QUESTIONS.length, 20);
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, 20);
  for (const q of QUESTIONS) {
    assert.ok(q.gold.length > 0, q.id);
    assert.ok(q.cite.length > 0 && q.cite.every((url) => url.startsWith("https://")), q.id);
    assert.ok(NORMALIZERS[q.norm], q.id);
    assert.match(q.checked, /^\d{4}-\d\d-\d\dT/);
  }
});

test("normalizers read the usual spellings", () => {
  assert.ok(NORMALIZERS.number("244,554,752 downloads").includes("244554752"));
  assert.ok(NORMALIZERS.number("HRB 13 105").includes("13105"));
  assert.ok(NORMALIZERS.number("8,848.86 m").includes("8848.86"));
  assert.ok(NORMALIZERS.number("2.9% + 30¢").includes("30"));
  assert.ok(NORMALIZERS.number("$0.01 USD").includes("0.01"));
  assert.ok(NORMALIZERS.date("on August 20, 2026").includes("2026-08-20"));
  assert.ok(NORMALIZERS.date("on 27 Oct 2026").includes("2026-10-27"));
  assert.ok(NORMALIZERS.date("2026/10/21").includes("2026-10-21"));
  assert.ok(NORMALIZERS.version("v7.1-beta").includes("7.1"));
  assert.ok(NORMALIZERS.version("requests v2.34.2").includes("2.34.2"));
});

test("a wrong value, a wrong source and a browser step are each scored", () => {
  const q = QUESTIONS.find((x) => x.id === "ruff-utc-date");
  const right = { answer: "2026-10-27, https://github.com/astral-sh/ruff/releases/tag/0.17.3", steps: [], usage: { input: 5, output: 1 } };
  assert.deepEqual([scoreAnswer(q, right, 1).exact, scoreAnswer(q, right, 1).cited, scoreAnswer(q, right, 1).tokens], [true, true, 6]);
  // The US-local date is the trap this question sets.
  assert.equal(scoreAnswer(q, { ...right, answer: "Oct 26, 2026 https://github.com/astral-sh/ruff/releases" }, 1).exact, false);
  assert.equal(scoreAnswer(q, { ...right, answer: "2026-10-27 per https://pypi.org/project/ruff" }, 1).cited, false);
  // A source kept on a step counts as cited; a `browse` step counts as the browser.
  const browsed = scoreAnswer(q, { answer: "2026-10-27", steps: [{ tool: "browse", ok: true, sources: ["https://github.com/astral-sh/ruff/releases"] }] }, 1);
  assert.deepEqual([browsed.cited, browsed.browser], [true, true]);
  // Both values of a pair must be there.
  const notion = QUESTIONS.find((x) => x.id === "notion-plus");
  assert.equal(scoreAnswer(notion, { answer: "$10 a month" }, 1).exact, false);
});

test("the dry run drives runTurn and scores all twenty", async () => {
  const result = await runSet({ dry: true });
  assert.equal(result.of, 20);
  assert.deepEqual(result.rows.filter((r) => !r.exact || !r.cited).map((r) => r.id), []);
  assert.ok(result.rows.every((r) => r.tools.includes("open_page") && r.tokens > 0 && !r.error));
});
