/**
 * Hits that only matched inside a URL (`src/search/linkMatch.js`).
 *
 * Production, 2026-11-03: "workers comp renewal" ranked a review note first
 * whose only match was a URL inside it, above the real note. These cases pin
 * the rule that tells such a hit apart: every matching term sits in a link,
 * and at least one does.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   Link stripping removed (URLs and link targets read as prose) → "a bare
 *     URL holding every term is a link-only hit" fails.
 *   Prose check dropped (any term in prose ignored) → "a term in the title is
 *     prose, not a link" fails.
 *   Link requirement dropped (no term in a link still returns true) → "empty
 *     texts are not a link-only hit" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesOnlyInLinks } from "../src/search/linkMatch.js";
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "../src/search/d1/query.js";

const QUERY = "workers comp renewal";
const LINK = "https://notes.example/note/@acme/projects/workers-comp-renewal/shiftmed-coverage";

test("a bare URL holding every term is a link-only hit", () => {
  assert.equal(matchesOnlyInLinks(QUERY, ["Shiftmed coverage review", LINK]), true);
});

test("a www address holding the terms is a link-only hit", () => {
  assert.equal(matchesOnlyInLinks(QUERY, ["Coverage review", "see www.notes.example/workers-comp-renewal"]), true);
});

test("a Markdown link target holding the terms is a link-only hit", () => {
  const snippet = "See [the shiftmed review](https://notes.example/workers-comp-renewal) for details";
  assert.equal(matchesOnlyInLinks("workers renewal", ["Coverage review", snippet]), true);
});

test("a relative Markdown target holding a term is a link-only hit", () => {
  assert.equal(matchesOnlyInLinks("renewal", ["Coverage review", "[notes](2-areas/workers-comp-renewal.md)"]), true);
});

test("a term in the visible part of a Markdown link is prose, not a link", () => {
  const snippet = "[workers comp renewal](https://notes.example/x)";
  assert.equal(matchesOnlyInLinks(QUERY, ["Coverage review", snippet]), false);
});

test("a term in the title is prose, not a link", () => {
  assert.equal(matchesOnlyInLinks(QUERY, ["Workers comp renewal", LINK]), false);
});

test("one term in prose and the rest only in a link is not a link-only hit", () => {
  assert.equal(matchesOnlyInLinks("renewal shiftmed", ["Shiftmed coverage", "https://notes.example/renewal"]), false);
});

test("highlight markers around a term in a URL are stripped before matching", () => {
  // The markers are empty strings today (query.js, on purpose), so this also
  // proves an empty marker does not split every character apart.
  const marked = `https://notes.example/${SNIPPET_OPEN}workers${SNIPPET_CLOSE}-${SNIPPET_OPEN}renewal${SNIPPET_CLOSE}`;
  assert.equal(matchesOnlyInLinks("workers renewal", ["Coverage review", marked]), true);
});

test("highlight markers around a term in prose still count as prose", () => {
  const marked = `${SNIPPET_OPEN}Workers${SNIPPET_CLOSE} comp review`;
  assert.equal(matchesOnlyInLinks("workers", [marked, LINK]), false);
});

test("matching is case-insensitive and whole-token", () => {
  // "comp" inside "compensation" is not the term "comp", so nothing matches in
  // prose and the URL's whole-token "comp" is the only hit.
  assert.equal(matchesOnlyInLinks("COMP", ["Compensation plan", "https://notes.example/comp"]), true);
  assert.equal(matchesOnlyInLinks("comp", ["Compensation plan", "https://notes.example/x"]), false);
});

test("a plural in prose matches the singular in a URL, as the word index does", () => {
  assert.equal(matchesOnlyInLinks("renewals", ["Workers comp renewal", "https://notes.example/renewal"]), false);
});

test("1-2 letter words are ignored, so they cannot make a hit prose", () => {
  assert.equal(matchesOnlyInLinks("a renewal", ["Coverage notes for a client", "https://notes.example/renewal"]), true);
});

test("a query term no text mentions does not block a link-only hit", () => {
  assert.equal(matchesOnlyInLinks("renewal zebra", ["Coverage review", "https://notes.example/renewal"]), true);
});

test("empty texts are not a link-only hit", () => {
  assert.equal(matchesOnlyInLinks(QUERY, []), false);
  assert.equal(matchesOnlyInLinks(QUERY, [""]), false);
  assert.equal(matchesOnlyInLinks(QUERY, ["", ""]), false);
});

test("an empty or stop-word-only query is not a link-only hit", () => {
  assert.equal(matchesOnlyInLinks("", [LINK]), false);
  assert.equal(matchesOnlyInLinks("   ", [LINK]), false);
  assert.equal(matchesOnlyInLinks("a of", [LINK]), false);
});

test("texts that name no query term are not a link-only hit", () => {
  assert.equal(matchesOnlyInLinks(QUERY, ["Coverage review", "https://notes.example/unrelated"]), false);
});

test("non-string input is not a link-only hit", () => {
  assert.equal(matchesOnlyInLinks(undefined, [LINK]), false);
  assert.equal(matchesOnlyInLinks(QUERY, undefined), false);
});
