// One word scale across workspaces (src/search/sharedWords.js, src/search/fuse.js): every workspace's word hits scored
// with the statistics of them all together, a word rare in one small workspace no longer counting as rare everywhere,
// each workspace optionally weighed by its share of the best evidence (never below the floor), and a search that cannot
// put every workspace on the scale ranking as it always has.
import { test } from "node:test";
import assert from "node:assert/strict";

import { bm25Of, fieldWordCounts, pooledStats, queryTerms, sharedWordRanks, termsOf, wordCounts } from "../src/search/sharedWords.js";
import { fuseEverywhere } from "../src/search/fuse.js";
import { FUSE_RANKING, rankingOf } from "../src/search/ranking.js";

const hit = (key, wordRank, text, terms) => ({ key, title: key, snippets: [], wordRank, words: wordCounts(text, terms) });

test("words are cut as FTS5's unicode61 cuts them: lower-case, no accents, letters and digits", () => {
  assert.deepEqual(termsOf("Café Q3-budget, NAÏVE!"), ["cafe", "q3", "budget", "naive"]);
  assert.deepEqual(queryTerms("the the budget The"), ["the", "budget"]);
  assert.deepEqual(wordCounts("budget the budget", ["budget", "plan"]), { tf: { budget: 2 }, len: 3 });
});

test("fields count as the word index weighs them: a short note named for the query beats one only saying it in its text", () => {
  // Juniper logo (search-real's Dev part): the brand note is titled and named for the product; another note says
  // "Juniper" and "logo" in a longer title and more often in its text. FTS5 ranks the brand note first in its own
  // workspace (title 4, file name 2.5, each normalized by its own length); the shared scale must too.
  const terms = queryTerms("Juniper logo");
  assert.deepEqual(fieldWordCounts({ title: "Juniper", path: "brand/juniper.md", body: "the logo" }, terms), {
    tf: { logo: 1 }, len: 2, title: { tf: { juniper: 1 }, len: 1 }, name: { tf: { juniper: 1 }, len: 1 },
  });
  const brand = { key: "brand/juniper.md", wordRank: 0, words: fieldWordCounts({ title: "Juniper", path: "resources/brand/juniper.md", body: `${"colour type spacing ".repeat(40)} logo logo` }, terms) };
  const rewrite = { key: "projects/juniper-prompt-rewrite.md", wordRank: 1, words: fieldWordCounts({ title: "Juniper prompt rewrite", path: "projects/juniper-prompt-rewrite.md", body: `juniper juniper ${"prompt ".repeat(20)} logo logo` }, terms) };
  const shared = sharedWordRanks([[brand, rewrite]], [{ n: 9, df: { juniper: 3, logo: 3 } }], "Juniper logo");
  assert.equal(shared.rank.get(brand), 0);
  // Body counts alone (a hit counted before fields) still score.
  assert.ok(bm25Of({ tf: { logo: 1 }, len: 5 }, terms, { n: 9, df: { logo: 3 } }, 5) > 0);
});

test("inside one workspace its own order stands: the scale only places workspaces against each other", () => {
  // The workspace's index ranked the host note first with columns the scale cannot see; the index page, more words
  // on the scale, must not jump it, while another workspace's hit is still placed by its shared score.
  const query = "who is hosting the book club in November";
  const terms = queryTerms(query);
  const host = { key: "club/meetings/2026-11-host.md", wordRank: 0, words: wordCounts("hosting November", terms) };
  const index = { key: "club/index.md", wordRank: 1, words: wordCounts("book club book club who is hosting in November the club", terms) };
  const other = { key: "band/gigs/open-mic-nov.md", wordRank: 0, words: wordCounts("November", terms) };
  const stats = [{ n: 20, df: { book: 5, club: 6, hosting: 2, november: 3 } }, { n: 20, df: { november: 4 } }];
  const shared = sharedWordRanks([[host, index], [other]], stats, query);
  assert.ok(shared.rank.get(host) < shared.rank.get(index));
  assert.ok(shared.score.get(index) <= shared.score.get(host));
  assert.ok(shared.rank.get(host) < shared.rank.get(other));
});

test("pooled statistics add chunks and per-word counts, skipping a workspace with none", () => {
  assert.deepEqual(pooledStats([{ n: 10, df: { a: 2 } }, null, { n: 5, df: { a: 1, b: 3 } }]), { n: 15, df: { a: 3, b: 3 } });
});

test("a rare word counts more than a common one on the pooled scale", () => {
  const pooled = { n: 1000, df: { rare: 2, common: 900 } };
  assert.ok(bm25Of({ tf: { rare: 1 }, len: 10 }, ["rare", "common"], pooled, 10) > bm25Of({ tf: { common: 1 }, len: 10 }, ["rare", "common"], pooled, 10));
});

test("each workspace's first word hit no longer ties: the hit holding the rare word wins across workspaces", () => {
  const query = "quarterly budget for the church";
  const terms = queryTerms(query);
  // A small workspace where "the" and "for" are rare-looking, and a big one where "church budget" is.
  const small = [hit("small/filler.md", 0, "for the the for", terms)];
  const big = [hit("big/church-budget.md", 0, "church budget quarterly", terms)];
  const stats = [
    { n: 3, df: { the: 1, for: 1 } },
    { n: 5000, df: { the: 4800, for: 4500, church: 3, budget: 40, quarterly: 20 } },
  ];
  const shared = sharedWordRanks([small, big], stats, query);
  assert.equal(shared.rank.get(big[0]), 0);
  assert.equal(shared.rank.get(small[0]), 1);
  assert.deepEqual(shared.weight, [1, 1], "no floor, no weights");
  const weighed = sharedWordRanks([small, big], stats, query, { floor: 0.15 });
  assert.equal(weighed.weight[0], 0.15, "a workspace with little evidence keeps the floor, never cut");
  assert.ok(weighed.weight[1] > 0.8);
});

test("a workspace with word hits but no statistics, or a hit without counts, leaves the scale off", () => {
  const terms = queryTerms("budget");
  const a = [hit("a.md", 0, "budget", terms)];
  assert.equal(sharedWordRanks([a, [hit("b.md", 0, "budget", terms)]], [{ n: 1, df: {} }, null], "budget"), null);
  assert.equal(sharedWordRanks([a, [{ key: "c.md", wordRank: 0 }]], [{ n: 1, df: {} }, { n: 1, df: {} }], "budget"), null);
  // A workspace with no word hits needs no statistics.
  assert.notEqual(sharedWordRanks([a, [{ key: "m.md", meaningScore: 0.9 }]], [{ n: 1, df: { budget: 1 } }, null], "budget"), null);
});

test("fuse: with sharedWords on, the hit on the shared scale wins; off (main), each workspace's first hit ties as before; counts never reach the answer", () => {
  const query = "quarterly budget for the church";
  const terms = queryTerms(query);
  const lists = () => [
    [{ ...hit("a.md", 0, "for the the for", terms), title: "" }],
    [{ ...hit("@big/b.md", 0, "church budget quarterly", terms), title: "" }],
  ];
  const wordStats = [
    { n: 3, df: { the: 1, for: 1 } },
    { n: 5000, df: { the: 4800, for: 4500, church: 3, budget: 40, quarterly: 20 } },
  ];
  const off = fuseEverywhere(lists(), 12, { query, wordStats, ranking: rankingOf({ sharedWords: 0, workspaceWeight: 0 }, FUSE_RANKING) });
  assert.equal(off[0].key, "a.md", "main: a tie, the first workspace first");
  const on = fuseEverywhere(lists(), 12, { query, wordStats, ranking: rankingOf({ sharedWords: 1 }, FUSE_RANKING) });
  assert.equal(on[0].key, "@big/b.md");
  assert.equal(on.some((h) => "words" in h), false);
  assert.equal(off.some((h) => "words" in h), false);
  const weighed = fuseEverywhere(lists(), 12, { query, wordStats, ranking: rankingOf({ sharedWords: 1, workspaceWeight: 0.15 }, FUSE_RANKING) });
  assert.equal(weighed[0].key, "@big/b.md");
});

test("the two knobs are bounded: out of bounds keeps main's value", () => {
  assert.equal(rankingOf({ sharedWords: 3 }, FUSE_RANKING).sharedWords, FUSE_RANKING.sharedWords);
  assert.equal(rankingOf({ workspaceWeight: 1.5 }, FUSE_RANKING).workspaceWeight, FUSE_RANKING.workspaceWeight);
});

test("fuse with sharedWords 2: the scale orders word hits, and a hit holding every word still outranks an any-word one", () => {
  const query = "church budget";
  const terms = queryTerms(query);
  const strict = { ...hit("a.md", 0, "church budget", terms), title: "" };
  const loose = { ...hit("@big/b.md", 0, "church church church", terms), title: "", loose: true };
  const wordStats = [{ n: 10, df: { church: 5, budget: 5 } }, { n: 10, df: { church: 1 } }];
  const two = fuseEverywhere([[strict], [loose]], 12, { query, wordStats, ranking: rankingOf({ sharedWords: 2 }, FUSE_RANKING) });
  assert.equal(two[0].key, "a.md");
  assert.equal(two.some((h) => h.key === "@big/b.md"), true, "a loose hit stays in the answer, below");
});
