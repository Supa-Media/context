/**
 * Code-looking passages and queries (`src/search/codeLike.js`).
 *
 * Production, 2026-11-03: the search "workers comp renewal" added three
 * "Same topic, different words" rows, found only by meaning, and all three
 * were passages of source code: an auth check
 * (`entId && state.tokenUrl && ORIGIN && ORIGIN.matcher(state.tokenUrl)…`)
 * and a test-name list. The embedding model scores code close to many
 * plain-language questions, so with a prose query those rows are noise. The
 * fixtures below are the production shapes, and the prose that must NOT be
 * called code: a meeting note, a table of scores, a bulleted plan with a code
 * span, a short title.
 *
 * Sabotage record (temporary local edits, suite run, reverted):
 *   symbol and identifier thresholds set to 0 → "a meeting note paragraph is not code",
 *       "a Markdown table of scores is not code", "a bulleted plan with one code span
 *       is not code" and "prose that mentions a few code spans is not code" fail
 *   identifier-only rule removed              → "a test-name list is code" fails
 *   under-40-characters guard removed         → "a short title is not code, whatever
 *       its characters" fails
 *   the table's `|` and `/` counted as symbols → "a Markdown table of scores is not
 *       code" fails
 *   the code-operator rule removed            → "code whose string literal is prose is
 *       still code" fails
 *   `queryLooksLikeCode` always false         → "a query with a dotted call", "a camelCase
 *       identifier query", "a snake_case query" and "the other code-ish query tokens"
 *       fail
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { looksLikeCode, queryLooksLikeCode } from "../src/search/codeLike.js";

// The production auth check, verbatim (the ellipsis is the snippet's own).
const AUTH_CHECK = "entId && state.tokenUrl && ORIGIN && ORIGIN.matcher(state.tokenUrl).matches()); if ((state.refresh || …";

// A test-name list as it appeared in the results: identifiers, no prose.
const TEST_NAME_LIST = `["searchNotesReturnsFolderLinkChildren", "searchNotesRefusesPrivateSubfolder", "toolSearchNotesMissCopy", "accessRowsGrantViewOrEdit"]`;

const TEST_BODY = `test("search_notes returns hits", async () => { const hits = await searchNotes({ query: "x" }); assert.equal(hits.length, 1); });`;

const MEETING_NOTE = "Met with Priya about the workers comp renewal on Tuesday. The broker wants the payroll figures (last year was about $4,200 a month) before they will quote. Sam will pull the numbers and send them by Friday, and we agreed to revisit the deductible once the quote is in.";

const SCORE_TABLE = `| Run | Score |
|---|---|
| 3/3 v80 | 1/3 v40 |
| 2/3 v80 | 0/3 v40 |`;

const SCORE_TABLE_WITH_NAME = `| Run | Score | Check |
|---|---|---|
| 3/3 v80 | 1/3 v40 | searchPriors |
| 2/3 v80 | 0/3 v40 | ok |`;

const BULLET_PLAN ="- Ship the renewal reminder by Friday\n- Use `searchPriors` for the lookup\n- Ask Priya about the quote before the call";

const CODE_SPANS_IN_PROSE = "The `search_notes` tool reads `query` and `limit`, and the `context` argument names the workspace; ask Priya whether the `renewal` folder is shared with the broker.";

const SHORT_TITLE = "Workers comp renewal 2026";

test("the production auth check is code", () => {
  assert.equal(looksLikeCode(AUTH_CHECK), true);
});

test("a test-name list is code", () => {
  assert.equal(looksLikeCode(TEST_NAME_LIST), true);
});

test("a test body is code", () => {
  assert.equal(looksLikeCode(TEST_BODY), true);
});

test("a meeting note paragraph is not code", () => {
  assert.equal(looksLikeCode(MEETING_NOTE), false);
});

test("a Markdown table of scores is not code", () => {
  assert.equal(looksLikeCode(SCORE_TABLE), false);
  assert.equal(looksLikeCode("| 3/3 v80 | 1/3 v40 |"), false);
  // A score table that names one function: the pipes must not read as code symbols.
  assert.equal(looksLikeCode(SCORE_TABLE_WITH_NAME), false);
});

test("a bulleted plan with one code span is not code", () => {
  assert.equal(looksLikeCode(BULLET_PLAN), false);
});

test("prose that mentions a few code spans is not code", () => {
  assert.equal(looksLikeCode(CODE_SPANS_IN_PROSE), false);
});

test("a short title is not code, whatever its characters", () => {
  assert.equal(looksLikeCode(SHORT_TITLE), false);
  // Code-shaped, but under 40 characters: the length guard, not the shape, says no.
  assert.equal(looksLikeCode("ORIGIN.matcher(state.tokenUrl) && ok"), false, "under 40 characters is never code");
});

test("empty and non-string input is not code", () => {
  assert.equal(looksLikeCode(""), false);
  assert.equal(looksLikeCode(undefined), false);
  assert.equal(looksLikeCode(null), false);
});

test("the workers comp query is prose", () => {
  assert.equal(queryLooksLikeCode("workers comp renewal"), false);
});

test("a query with a dotted call is code-ish", () => {
  assert.equal(queryLooksLikeCode("ORIGIN.matcher"), true);
});

test("a camelCase identifier query is code-ish", () => {
  assert.equal(queryLooksLikeCode("toolSearchNotes"), true);
});

test("a snake_case query is code-ish", () => {
  assert.equal(queryLooksLikeCode("search_notes args"), true);
});

test("the other code-ish query tokens count: parens, equals, slash, scope", () => {
  assert.equal(queryLooksLikeCode("fn(x)"), true);
  assert.equal(queryLooksLikeCode("tokenUrl=abc"), true);
  assert.equal(queryLooksLikeCode("src/search"), true);
  assert.equal(queryLooksLikeCode("Foo::bar"), true);
});

test("an empty or non-string query is not code-ish", () => {
  assert.equal(queryLooksLikeCode(""), false);
  assert.equal(queryLooksLikeCode(undefined), false);
});

test("code whose string literal is prose is still code (production, 2026-11-03)", () => {
  assert.equal(
    looksLikeCode('ientId || state.tokenUrl) && !canRefresh) { print("ZAP_MCP_REFRESH_OFF incomplete or off-origin refresh settings; the token will expire after an hour"); } function form(value) { return URLEncoder.enco'),
    true,
  );
  // Prose that says "and/or" in words, or names one function, is not.
  assert.equal(looksLikeCode("We agreed the renewal starts on December 13, and the broker will call back with quotes for both plans before Friday."), false);
});
