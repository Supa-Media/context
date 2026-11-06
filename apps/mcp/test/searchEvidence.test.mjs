/**
 * The corpus-independent evidence for a word hit (`search/evidence.js`): the
 * title and file-name coverage of the query's terms, and the whole query as a
 * phrase. Read from the query and the hit alone, so it is comparable across
 * workspaces where BM25 is not (`docs/decisions/search/blended-search.md`).
 *
 * Sabotage record (temporary local edits, reverted):
 *   file-name stem read with its folders                 → "a file name is the last path segment…" and "short words are not terms…" fail
 *   the phrase matched as substrings, not words           → "a phrase must be whole words…" fails
 *   hyphens kept in file names                            → "a hyphenated file name holds its words…", "terms are…" and "a phrase is the whole query…" fail
 *   one- and two-letter words counted as terms            → "terms are…" and "short words are not terms…" fail
 *   the phrase bonus dropped                              → "the bonus is the title weight…" fails
 *   TITLE_WEIGHT changed                                  → "the title weight is a fifth of a rank-0 hit…" fails
 *   FILLER_WORDS emptied                                  → "terms are…" and "words that only say how…" fail
 *   coverage read without stems                           → "a word and its other forms count as one…" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PHRASE_BONUS, TITLE_WEIGHT, evidenceBonus, fileStem, hasPhrase, queryTerms, titleCoverage, unmarked } from "../src/search/evidence.js";

test("terms are the query's words in lowercase, without the one- and two-letter ones, once each", () => {
  assert.deepEqual(queryTerms("to be or not"), ["not"]);
  assert.deepEqual(queryTerms("A plan, PLAN of the 2027 Owners-x"), ["plan", "2027", "owners"]);
  assert.deepEqual(queryTerms("  "), []);
});

test("words that only say how a question is asked are not terms", () => {
  assert.deepEqual(queryTerms("how we position Context against other AI memory tools"), ["position", "context", "memory", "tools"]);
  assert.deepEqual(queryTerms("why I started Context"), ["started", "context"]);
});

test("a word and its other forms count as one: positioning holds position, started holds start", () => {
  assert.equal(titleCoverage("how we position Context against other AI memory tools", { key: "products/positioning.md", title: "Context.LC positioning" }), 2 / 4);
  assert.equal(titleCoverage("why I started Context", { key: "yc/why-context-started.page.md", title: "Context began as a notebook" }), 1);
  assert.equal(titleCoverage("start context", { key: "x.md", title: "Context started" }), 1);
  assert.equal(titleCoverage("comp", { key: "x.md", title: "Workers compensation" }), 0);
});

test("short words are not terms: a query of them has no coverage and no phrase", () => {
  const hit = { key: "a/of.md", title: "Of a" };
  assert.equal(titleCoverage("a of", hit), 0);
  assert.equal(evidenceBonus("a of", hit), 0);
});

test("a file name is the last path segment without its .md, so a folder name is not a file name", () => {
  assert.equal(fileStem("@x/plans/2027-plan.md"), "2027-plan");
  assert.equal(fileStem("notes/a.MD"), "a");
  assert.equal(fileStem("no-extension"), "no-extension");
  // A folder called "workers" is not in the file name, so the title is the only holder of "workers".
  assert.equal(titleCoverage("workers", { key: "workers/comp/index.md", title: "Index" }), 0);
});

test("title coverage is the share of the query's terms the title or the file name holds", () => {
  assert.equal(titleCoverage("workers comp renewal", { key: "x.md", title: "Workers comp" }), 2 / 3);
  // The file name holds the third term, the title the first two.
  assert.equal(titleCoverage("workers comp renewal", { key: "@x/renewal.md", title: "Workers comp" }), 1);
  assert.equal(titleCoverage("workers comp renewal", { key: "x.md", title: "Nothing here" }), 0);
});

test("a hyphenated file name holds its words, and a title word counts only as a whole word", () => {
  assert.equal(titleCoverage("2027 plan objectives owners", { key: "2027-plan-objectives-owners.md", title: "Overview" }), 1);
  assert.equal(titleCoverage("comp", { key: "x.md", title: "Workers compensation" }), 0);
});

test("a phrase is the whole query, in order and adjacent, in the title, the file name or a snippet", () => {
  assert.equal(hasPhrase("workers  comp RENEWAL", { key: "x.md", title: "Workers comp renewal" }), true);
  assert.equal(hasPhrase("comp renewal", { key: "x.md", title: "Workers comp renewal" }), true);
  assert.equal(hasPhrase("2027 plan objectives owners", { key: "2027-plan-objectives-owners.md", title: "Overview" }), true);
  assert.equal(hasPhrase("workers comp", { key: "x.md", title: "Notes", snippets: ["the workers comp claim"] }), true);
});

test("a phrase must be whole words in order: the words apart, or split across snippets, are not one", () => {
  assert.equal(hasPhrase("workers comp renewal", { key: "x.md", title: "Renewal workers comp" }), false);
  assert.equal(hasPhrase("workers renewal", { key: "x.md", title: "Workers comp renewal" }), false);
  assert.equal(hasPhrase("workers comp", { key: "x.md", title: "Notes", snippets: ["workers", "comp"] }), false);
  assert.equal(hasPhrase("workers comp", { key: "x.md", title: "Workers compensation" }), false);
});

test("snippet highlight marks are removed before the phrase is read, and typed characters are not", () => {
  // The marks are empty today (`d1/query.js`); a typed ‹ is the person's text and stays.
  assert.equal(unmarked("‹typed› text"), "‹typed› text");
  assert.equal(unmarked(undefined), "");
});

test("the bonus is the title weight times the coverage, plus the phrase bonus when there is a phrase", () => {
  assert.equal(evidenceBonus("workers comp renewal", { key: "x.md", title: "Workers comp" }), TITLE_WEIGHT * (2 / 3));
  assert.equal(evidenceBonus("workers comp renewal", { key: "x.md", title: "Workers comp renewal" }), TITLE_WEIGHT + PHRASE_BONUS);
  assert.equal(evidenceBonus("workers comp", { key: "x.md", title: "Notes", snippets: ["the workers comp claim"] }), PHRASE_BONUS);
});

test("no query is no bonus, whatever the hit holds", () => {
  const hit = { key: "x.md", title: "Workers comp renewal" };
  assert.equal(evidenceBonus(undefined, hit), 0);
  assert.equal(evidenceBonus("   ", hit), 0);
  assert.equal(evidenceBonus(42, hit), 0);
});

test("the title weight is a fifth of a rank-0 hit and the phrase bonus half of one", () => {
  assert.equal(TITLE_WEIGHT, 1 / 305);
  assert.equal(PHRASE_BONUS, 1 / 122);
});
