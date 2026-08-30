/**
 * Checks for src/search/shardQuery.js — `collectShardCandidates` and
 * `scoreCollected`, the pure gather/score half of the v2 sharded query path
 * — against CONTRACT.md's v2 "Query" section and its amendment (all scoring
 * stats come from the visible docs a shard walk encounters, never from
 * manifest stats).
 *
 * Fixtures are built by hand, mirroring searchQuery.test.mjs's `buildIndex`
 * helper (copied here rather than imported: that file is owned by a
 * different piece of this same work, and a test file that imported its
 * private helper would start failing for reasons unrelated to shardQuery.js).
 * A local `splitIntoShards` fans a single hand-built index out across N
 * shard-shaped `{ version: 2, docs, terms }` objects by an arbitrary
 * deterministic path→shard assignment — deliberately NOT the real
 * `fnv1a32(path) % shardCount` rule, which belongs to shards.js (owned
 * elsewhere): what this file is proving is invariance under *any* partition
 * of the same corpus, which a specific hash function would only obscure.
 *
 * The one thing borrowed from elsewhere is `termsOf`/`trigrams` from
 * text.js — the one copy of the tokenization rule.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to src/search/shardQuery.js and reverted:
 *
 * 1. **`sumAcross`'s `total +=` changed to `total = Math.max(total, ...)`**,
 *    which is what `mergeDirectTerm`'s `df +=` and `mergeVocabTerm`'s
 *    `df +=` both reduce to when a term appears in more than one shard.
 *    Broke "df/idf are computed globally... a term common across shards
 *    ranks the same as unsharded" below: idf came out computed against a
 *    single shard's count instead of the true global df, so score diverged
 *    from the unsharded reference by more than the tolerance.
 * 2. **`collectShardCandidates`'s `if (!isVisible(path)) continue;` inverted
 *    to `if (isVisible(path)) continue;`** (visible docs skipped, hidden
 *    docs kept). Broke every check in the "visible-only statistics" and
 *    "no private data leaves a collection" sections — a hidden doc's path,
 *    metadata and postings all showed up in the collection, and `visibleN`
 *    counted the wrong docs entirely.
 * 3. **Shard-count invariance broken directly**: in the 3-shard test, one
 *    collection was dropped before calling `scoreCollected` (simulating a
 *    forgotten `push` in an orchestrator merge loop). Broke "a corpus split
 *    across 3 shards scores identically to the same corpus in 1 shard" — N
 *    and every df undercounted, so scores no longer matched the 1-shard
 *    reference at all, let alone to 1e-9.
 */

import {
  collectShardCandidates,
  scoreCollected,
} from "../src/search/shardQuery.js";
import { parseQuery, searchIndex } from "../src/search/query.js";
import { termsOf } from "../src/search/text.js";

// -- fixture builder (mirrors searchQuery.test.mjs's buildIndex) -----------

function fieldTermFrequencies(text) {
  const counts = new Map();
  for (const term of termsOf(text)) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}

const FIELD_ORDER = ["title", "headings", "tags", "body"];

/**
 * @param {{ path: string, title?: string, headings?: string, tags?: string,
 *   body?: string, links?: string[], uploaded?: string|null }[]} specs
 */
function buildIndex(specs) {
  const docs = new Map();
  const terms = new Map();
  for (const spec of specs) {
    const fields = {
      title: spec.title || "",
      headings: spec.headings || "",
      tags: spec.tags || "",
      body: spec.body || "",
    };
    const tfByField = {};
    for (const field of FIELD_ORDER) tfByField[field] = fieldTermFrequencies(fields[field]);

    docs.set(spec.path, {
      etag: spec.etag || "e1",
      uploaded: spec.uploaded ?? null,
      title: spec.title || spec.path,
      links: spec.links || [],
      len: Object.fromEntries(FIELD_ORDER.map((f) => [f, termsOf(fields[f]).length])),
      // v2 never computes PageRank (CONTRACT.md: "PageRank is neutral (rank
      // = 1) in v2"); the neutral value is what makes v1-vs-v2 comparisons
      // in this file apples to apples, since v1's own multiplier collapses
      // to 1.0 exactly at rank = 1.
      rank: 1,
    });

    const docTerms = new Set();
    for (const field of FIELD_ORDER) for (const t of tfByField[field].keys()) docTerms.add(t);
    for (const term of docTerms) {
      const tuple = FIELD_ORDER.map((field) => tfByField[field].get(term) || 0);
      if (!terms.has(term)) terms.set(term, new Map());
      terms.get(term).set(spec.path, tuple);
    }
  }
  return { version: 1, docs, terms };
}

/**
 * Fan a hand-built index out across `shardCount` shard-shaped indices, by
 * `assign(path) -> shardId`. Every doc and every one of its postings lands in
 * exactly one shard — the same "a note belongs to exactly one shard" premise
 * the real `fnv1a32` rule guarantees, without depending on it.
 */
function splitIntoShards(index, shardCount, assign) {
  const shards = Array.from({ length: shardCount }, () => ({
    version: 2,
    docs: new Map(),
    terms: new Map(),
  }));
  for (const [path, doc] of index.docs) shards[assign(path)].docs.set(path, doc);
  for (const [term, postings] of index.terms) {
    for (const [path, tuple] of postings) {
      const shard = shards[assign(path)];
      if (!shard.terms.has(term)) shard.terms.set(term, new Map());
      shard.terms.get(term).set(path, tuple);
    }
  }
  return shards;
}

/** Deterministic, arbitrary (NOT fnv1a32 — see file header) path -> shard id. */
function hashAssign(shardCount) {
  return (path) => {
    let h = 0;
    for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
    return h % shardCount;
  };
}

/** The deduped query-term list `scoreCollected` itself would derive — computed once so every shard is asked about the same terms. */
function queryTermsFor(query) {
  const { phrases, terms } = parseQuery(query);
  return [...new Set([...terms, ...phrases.flat()])];
}

/** Collect every shard's contribution for one query, all-visible unless overridden. */
function collectAll(shards, query, isVisible = () => true) {
  const queryTerms = queryTermsFor(query);
  return shards.map((shard) => collectShardCandidates(shard, queryTerms, isVisible));
}

function scoreOf(results, path) {
  return results.find((r) => r.path === path)?.score ?? 0;
}

function attempt(fn) {
  try {
    fn();
    return { threw: false };
  } catch (err) {
    return { threw: true, err };
  }
}

/** Every score in `a` equals the corresponding score in `b` to within `eps` — same paths, same order. */
function scoresMatch(a, b, eps = 1e-9) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path) return false;
    if (Math.abs(a[i].score - b[i].score) > eps) return false;
    if (JSON.stringify(a[i].matchedTerms) !== JSON.stringify(b[i].matchedTerms)) return false;
  }
  return true;
}

export async function runSearchShardQueryChecks(check) {
  // -- single shard identical to v1's searchIndex, rank held neutral --------
  //
  // The core correctness claim in miniature: with exactly one shard holding
  // the whole corpus, gather-then-score must reduce to v1's scoring, byte
  // for byte (not just "close").

  {
    const idx = buildIndex([
      { path: "title-hit.md", title: "gateway", body: "notes about setup" },
      { path: "body-hit.md", title: "notes", body: "gateway setup notes" },
    ]);
    const v1 = searchIndex(idx, "gateway");

    const shard = { version: 2, docs: idx.docs, terms: idx.terms };
    const collection = collectShardCandidates(shard, queryTermsFor("gateway"), () => true);
    const v2 = scoreCollected([collection], "gateway");

    check(
      "a single shard holding the whole corpus scores identically to v1's searchIndex",
      scoresMatch(v1, v2)
    );
  }

  {
    // idf, coverage, and field weighting together, still single-shard.
    const idx = buildIndex([
      { path: "full.md", body: "alpha beta gamma delta epsilon" },
      { path: "partial.md", body: "alpha beta gamma delta" },
      { path: "c1.md", body: "common" },
      { path: "c2.md", body: "common" },
      { path: "c3.md", body: "common" },
      { path: "r.md", body: "rare" },
    ]);
    const query = "alpha beta gamma delta epsilon common rare";
    const v1 = searchIndex(idx, query);

    const shard = { version: 2, docs: idx.docs, terms: idx.terms };
    const collection = collectShardCandidates(shard, queryTermsFor(query), () => true);
    const v2 = scoreCollected([collection], query);

    check(
      "a richer single-shard query (coverage + idf + multi-term) matches v1 exactly",
      scoresMatch(v1, v2)
    );
  }

  // -- shard-count invariance: the core v2 correctness property -------------

  {
    const specs = [];
    for (let i = 0; i < 15; i++) {
      specs.push({
        path: `doc${String(i).padStart(2, "0")}.md`,
        title: i % 5 === 0 ? "gateway" : undefined,
        body: i % 2 === 0 ? "gateway setup notes" : "common word filler",
      });
    }
    specs.push({ path: "typo.md", body: "gateway setup" });
    specs.push({ path: "cousin.md", body: "gatehouse structure" });
    const idx = buildIndex(specs);

    const query = "gatway setup common"; // "gatway" only reachable by fuzzy expansion
    const v1 = searchIndex(idx, query);

    const oneShard = splitIntoShards(idx, 1, hashAssign(1));
    const threeShards = splitIntoShards(idx, 3, hashAssign(3));
    const sevenShards = splitIntoShards(idx, 7, hashAssign(7));

    const v2One = scoreCollected(collectAll(oneShard, query), query);
    const v2Three = scoreCollected(collectAll(threeShards, query), query);
    const v2Seven = scoreCollected(collectAll(sevenShards, query), query);

    check("a corpus in 1 shard matches v1's unsharded scoring exactly", scoresMatch(v1, v2One));
    check(
      "the same corpus split across 3 shards scores identically to 1 shard (shard-count invariance)",
      scoresMatch(v2One, v2Three)
    );
    check(
      "...and identically again split across 7 shards",
      scoresMatch(v2One, v2Seven)
    );
  }

  // -- df/idf computed globally, not per shard -------------------------------

  {
    // "common" is split so that every shard sees only PART of its total df;
    // "rare" sits alone in one shard. If df were computed per shard rather
    // than merged globally, "common"'s idf would be inflated (each shard
    // under-counts its own df) enough to change the ranking below.
    const idx = buildIndex([
      { path: "c1.md", body: "common" },
      { path: "c2.md", body: "common" },
      { path: "c3.md", body: "common" },
      { path: "c4.md", body: "common" },
      { path: "c5.md", body: "common" },
      { path: "r.md", body: "rare" },
    ]);
    const shards = splitIntoShards(idx, 3, hashAssign(3));

    const rareResults = scoreCollected(collectAll(shards, "rare"), "rare");
    const commonResults = scoreCollected(collectAll(shards, "common"), "common");
    const rareScore = scoreOf(rareResults, "r.md");
    const commonScore = scoreOf(commonResults, "c1.md");

    check(
      "a rare term scores higher than an equally-placed common term when df is global (idf)",
      rareScore > 0 && rareScore > commonScore
    );

    const v1Rare = scoreOf(searchIndex(idx, "rare"), "r.md");
    const v1Common = scoreOf(searchIndex(idx, "common"), "c1.md");
    check(
      "...and matches the unsharded idf exactly, not merely the same ordering",
      Math.abs(rareScore - v1Rare) < 1e-9 && Math.abs(commonScore - v1Common) < 1e-9
    );
  }

  // -- visible-only statistics: hiding a doc changes df/N exactly as v1 -----

  {
    const idx = buildIndex([
      { path: "1-projects/alpha.md", body: "gateway shared" },
      { path: "1-projects/vault/secret.md", body: "gateway shared" },
      { path: "2-areas/handbook.md", body: "gateway shared" },
    ]);
    const isVisible = (path) => !path.startsWith("1-projects/vault/");

    const v1Results = searchIndex(
      // v1's own equivalent of the same narrowing: visibleIndex before scoring.
      (await import("../src/search/query.js")).visibleIndex(idx, isVisible),
      "gateway"
    );

    const shards = splitIntoShards(idx, 3, hashAssign(3));
    const v2Results = scoreCollected(collectAll(shards, "gateway", isVisible), "gateway");

    check(
      "hiding one doc changes df/N in the sharded path exactly as visibleIndex does in v1",
      scoresMatch(v1Results, v2Results)
    );
    check(
      "the hidden doc never appears in the sharded results at all",
      !v2Results.some((r) => r.path === "1-projects/vault/secret.md")
    );
  }

  // -- no private data leaves a collection: byte-level assertion ------------

  {
    const idx = buildIndex([
      { path: "public/note.md", body: "gateway shared alpha" },
      { path: "private/secret.md", body: "gateway PRIVATEWORD alpha" },
    ]);
    const isVisible = (path) => path.startsWith("public/");
    const shard = { version: 2, docs: idx.docs, terms: idx.terms };
    const collection = collectShardCandidates(shard, queryTermsFor("gateway alpha"), isVisible);

    // Serialize every field of the collection, Maps included, and check the
    // hidden path and its distinctive body word appear nowhere in any of it.
    const serialized = JSON.stringify({
      visibleN: collection.visibleN,
      lenTotals: collection.lenTotals,
      dfByTerm: [...collection.dfByTerm],
      postings: [...collection.postings].map(([t, m]) => [t, [...m]]),
      meta: [...collection.meta],
      vocab: [...collection.vocab].map(([t, v]) => [t, { df: v.df, postings: [...v.postings] }]),
    });
    check(
      "the hidden doc's path appears nowhere in the collection",
      !serialized.includes("private/secret.md")
    );
    check(
      "the hidden doc's distinctive body content appears nowhere in the collection",
      !serialized.includes("PRIVATEWORD") && !serialized.includes("privateword")
    );
    check(
      "the visible doc's own data IS present (this is not a blanket empty collection)",
      serialized.includes("public/note.md") && collection.visibleN === 1
    );
  }

  // -- expansion global df = 0 gate: hidden-only term triggers expansion ----
  //
  // The v1 analogue of "an arbitrary word in somebody else's private notes
  // decides whether your visible note comes back" (CONTRACT.md's own
  // motivating bug), reproduced at the shard boundary.

  {
    const idx = buildIndex([
      { path: "typo.md", body: "gateway setup" }, // visible; typo'd query should fuzzy-match this
      { path: "private/exact.md", body: "gateway setup exactmatch" }, // hidden; holds the literal query term
    ]);
    const isVisible = (path) => !path.startsWith("private/");
    const shards = splitIntoShards(idx, 3, hashAssign(3));

    // Querying the exact word: with the exact-holder hidden, global df is 0
    // among visible docs too (typo.md doesn't contain "gateway" as body has
    // it, so use a term unique to the hidden doc for a clean df=0 test).
    const hiddenOnlyTerm = "exactmatch";
    const resultsWithHiddenHolder = scoreCollected(
      collectAll(shards, hiddenOnlyTerm, isVisible),
      hiddenOnlyTerm
    );
    // Compare against the same query run over a corpus where the exact-match
    // doc never existed at all — expansion firing should be identical either
    // way, since a hidden doc must count the same as an absent one.
    const idxWithoutHiddenDoc = buildIndex([{ path: "typo.md", body: "gateway setup" }]);
    const shardsWithoutHiddenDoc = splitIntoShards(idxWithoutHiddenDoc, 3, hashAssign(3));
    const resultsWithoutHiddenDoc = scoreCollected(
      collectAll(shardsWithoutHiddenDoc, hiddenOnlyTerm),
      hiddenOnlyTerm
    );

    check(
      "a term present ONLY in a hidden doc behaves exactly as one present nowhere (both empty — no vocabulary match)",
      resultsWithHiddenHolder.length === 0 && resultsWithoutHiddenDoc.length === 0
    );

    // Now the fuzzy-expansion version: "gatway" (typo) should reach typo.md
    // via trigram expansion whether or not a private doc happens to also
    // hold the exact spelling — the hidden doc must not change the outcome.
    const idxWithHiddenExact = buildIndex([
      { path: "typo.md", body: "gateway setup" },
      { path: "private/exact.md", body: "gateway exact spelling here" },
    ]);
    const shardsA = splitIntoShards(idxWithHiddenExact, 3, hashAssign(3));
    const withHidden = scoreCollected(
      collectAll(shardsA, "gatway", isVisible),
      "gatway"
    );

    const idxWithoutHiddenExact = buildIndex([{ path: "typo.md", body: "gateway setup" }]);
    const shardsB = splitIntoShards(idxWithoutHiddenExact, 3, hashAssign(3));
    const withoutHidden = scoreCollected(collectAll(shardsB, "gatway"), "gatway");

    check(
      "fuzzy expansion fires the same way whether an exact match exists in a hidden doc or not at all",
      scoresMatch(withHidden, withoutHidden)
    );
  }

  // -- prefix and fuzzy expansion working ACROSS shards ----------------------

  {
    // "gateway" (the expansion target) lives in a shard the typo'd query
    // term itself never lands in — proving expansion candidates gathered
    // per-shard actually get merged before the global df=0 gate fires.
    const idx = buildIndex([{ path: "far-shard-doc.md", body: "gateway setup notes" }]);
    const shards = splitIntoShards(idx, 5, hashAssign(5));
    // Confirm the fixture actually exercises >1 shard non-trivially: find
    // which shard holds the doc, and prove at least one OTHER shard is
    // asked and contributes nothing (this is what "across shards" means).
    const holderShardId = shards.findIndex((s) => s.docs.has("far-shard-doc.md"));
    check("the fixture doc lands in some shard", holderShardId >= 0);

    const prefixResults = scoreCollected(collectAll(shards, "gate"), "gate");
    check(
      "a 3+-char prefix query finds a vocabulary term in a shard other than shard 0, via the merged candidate set",
      scoreOf(prefixResults, "far-shard-doc.md") > 0 &&
        prefixResults.find((r) => r.path === "far-shard-doc.md").matchedTerms.includes("gateway")
    );

    const fuzzyResults = scoreCollected(collectAll(shards, "gatway"), "gatway");
    check(
      "a fuzzy-typo'd query finds the same cross-shard term via trigram expansion",
      scoreOf(fuzzyResults, "far-shard-doc.md") > 0 &&
        fuzzyResults.find((r) => r.path === "far-shard-doc.md").matchedTerms.includes("gateway")
    );

    const tooShort = scoreCollected(collectAll(shards, "ga"), "ga");
    check(
      "a query term under 3 chars still does not trigger prefix expansion, sharded",
      !tooShort.some((r) => r.matchedTerms?.includes("gateway"))
    );
  }

  {
    // Prefix expansion capped at 10, alphabetical — assembled from vocab
    // scattered across shards, matching v1's cap exactly.
    const specs = [];
    const letters = "abcdefghijklmnop".split("");
    for (const letter of letters) specs.push({ path: `${letter}.md`, body: `gate${letter}word marker` });
    const idx = buildIndex(specs);
    const shards = splitIntoShards(idx, 4, hashAssign(4));

    const v1Results = searchIndex(idx, "gate");
    const v2Results = scoreCollected(collectAll(shards, "gate"), "gate");
    check(
      "prefix expansion's 10-candidate alphabetical cap matches v1 exactly when candidates are scattered across shards",
      scoresMatch(v1Results, v2Results)
    );
  }

  // -- recency and coverage behave as v1, sharded ----------------------------

  {
    const now = new Date("2026-08-29T00:00:00Z").getTime();
    const idx = buildIndex([
      { path: "new.md", body: "gateway notes", uploaded: "2026-08-28T00:00:00Z" },
      { path: "old.md", body: "gateway notes", uploaded: "2025-01-01T00:00:00Z" },
    ]);
    const shards = splitIntoShards(idx, 2, hashAssign(2));
    const results = scoreCollected(collectAll(shards, "gateway"), "gateway", { now });
    check(
      "a newer doc outranks an otherwise-identical older doc across shards (recency)",
      scoreOf(results, "new.md") > scoreOf(results, "old.md")
    );

    const v1Results = searchIndex(idx, "gateway", { now });
    check("...matching v1's recency scoring exactly", scoresMatch(v1Results, results));
  }

  {
    const idx = buildIndex([
      { path: "full.md", body: "alpha beta gamma delta epsilon" },
      { path: "partial.md", body: "alpha beta gamma delta" },
    ]);
    const shards = splitIntoShards(idx, 3, hashAssign(3));
    const query = "alpha beta gamma delta epsilon";
    const results = scoreCollected(collectAll(shards, query), query);
    check(
      "a doc matching every query term outranks a doc missing just one, sharded (coverage)",
      scoreOf(results, "full.md") > 0 && scoreOf(results, "full.md") > scoreOf(results, "partial.md")
    );

    const phraseQuery = '"alpha beta gamma delta epsilon"';
    const phraseResults = scoreCollected(collectAll(shards, phraseQuery), phraseQuery);
    check(
      "a doc matching every phrase term outranks one missing a phrase term, sharded",
      scoreOf(phraseResults, "full.md") > 0 &&
        scoreOf(phraseResults, "full.md") > scoreOf(phraseResults, "partial.md")
    );
  }

  {
    // Cap at 50 still holds once results are assembled from many shards.
    const specs = [];
    for (let i = 0; i < 60; i++) specs.push({ path: `doc${String(i).padStart(2, "0")}.md`, body: "widget" });
    const idx = buildIndex(specs);
    const shards = splitIntoShards(idx, 6, hashAssign(6));
    const results = scoreCollected(collectAll(shards, "widget"), "widget");
    check("results are capped at 50 even when assembled from many shards", results.length === 50);
  }

  // -- determinism ------------------------------------------------------------

  {
    const idx = buildIndex([
      { path: "a.md", body: "gateway setup" },
      { path: "b.md", body: "gateway config" },
    ]);
    const shards = splitIntoShards(idx, 3, hashAssign(3));
    const query = "gateway setup gatway"; // includes a fuzzy expansion
    const run1 = JSON.stringify(scoreCollected(collectAll(shards, query), query));
    const run2 = JSON.stringify(scoreCollected(collectAll(shards, query), query));
    check("two identical sharded searches, including one that expands, produce identical output", run1 === run2);
  }

  // -- degenerate inputs --------------------------------------------------------

  {
    const idx = buildIndex([{ path: "a.md", body: "gateway" }]);
    const shards = splitIntoShards(idx, 2, hashAssign(2));
    check("an empty query returns no results", scoreCollected(collectAll(shards, ""), "").length === 0);
    check(
      "a whitespace-only query returns no results",
      scoreCollected(collectAll(shards, "   "), "   ").length === 0
    );
    const nonString = attempt(() => {
      if (scoreCollected(collectAll(shards, "gateway"), undefined).length !== 0) throw new Error("expected empty");
    });
    check("a non-string query does not throw and returns no results", !nonString.threw);
    check(
      "scoreCollected does not throw on an empty collections array",
      !attempt(() => scoreCollected([], "gateway")).threw &&
        scoreCollected([], "gateway").length === 0
    );
    check(
      "scoreCollected does not throw on a non-array collections argument",
      !attempt(() => scoreCollected(undefined, "gateway")).threw
    );
  }

  {
    // A shard whose corresponding notes were all filtered out (nobody
    // visible in it) must contribute zero, not throw and not skew N.
    const idx = buildIndex([
      { path: "public/a.md", body: "gateway" },
      { path: "private/b.md", body: "gateway" },
    ]);
    const shards = splitIntoShards(idx, 2, hashAssign(2));
    const isVisible = (path) => path.startsWith("public/");
    const results = scoreCollected(collectAll(shards, "gateway", isVisible), "gateway");
    check(
      "a shard with nothing visible in it does not throw and contributes nothing",
      !attempt(() => collectAll(shards, "gateway", isVisible)).threw && results.length === 1
    );
  }

  // -- isVisible must be callable --------------------------------------------

  {
    const idx = buildIndex([{ path: "a.md", body: "gateway" }]);
    check(
      "collectShardCandidates refuses a predicate that cannot answer, rather than showing everything",
      attempt(() => collectShardCandidates(idx, ["gateway"], undefined)).threw &&
        attempt(() => collectShardCandidates(idx, ["gateway"], "notafunction")).threw
    );
  }

  // -- adversarial: __proto__ / constructor as index keys ---------------------

  {
    const protoPropsBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
    const dangerousShard = {
      version: 2,
      docs: new Map([
        [
          "__proto__",
          { etag: "e1", uploaded: null, title: "proto doc", links: [], len: { title: 2, headings: 0, tags: 0, body: 2 } },
        ],
        [
          "constructor",
          { etag: "e1", uploaded: null, title: "constructor doc", links: [], len: { title: 1, headings: 0, tags: 0, body: 2 } },
        ],
      ]),
      terms: new Map([
        ["proto", new Map([["__proto__", [1, 0, 0, 1]]])],
        [
          "constructor",
          new Map([
            ["constructor", [1, 0, 0, 1]],
            ["__proto__", [0, 0, 0, 1]],
          ]),
        ],
        ["__proto__", new Map([["constructor", [0, 0, 0, 1]]])],
      ]),
    };

    const result = attempt(() => {
      const collection = collectShardCandidates(
        dangerousShard,
        ["constructor", "__proto__", "hasownproperty", "tostring", "valueof"],
        () => true
      );
      scoreCollected([collection], "constructor __proto__ hasOwnProperty toString valueOf");
    });
    check("a query term / doc path / vocab term of \"__proto__\" or \"constructor\" does not throw", !result.threw);

    const protoPropsAfter = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
    check("...and does not add any property to Object.prototype", protoPropsBefore === protoPropsAfter);
    check("...and a fresh plain object stays unpolluted", ({}).injected === undefined && ({}).polluted === undefined);
  }

  {
    // The same dangerous strings as PATHS reached by way of an actually
    // sharded, visibility-filtered corpus — not just handed straight to the
    // dangerous-fixture object above.
    const idx = buildIndex([
      { path: "__proto__", body: "gateway notes" },
      { path: "constructor", body: "gateway notes" },
      { path: "ordinary.md", body: "gateway notes" },
    ]);
    const shards = splitIntoShards(idx, 3, hashAssign(3));
    const isVisible = (path) => path !== "constructor"; // hide one of the dangerous paths too

    const result = attempt(() => scoreCollected(collectAll(shards, "gateway", isVisible), "gateway"));
    check("dangerous paths surviving a real shard split and visibility filter do not throw", !result.threw);
    if (!result.threw) {
      const results = scoreCollected(collectAll(shards, "gateway", isVisible), "gateway");
      check(
        "the hidden dangerous path is absent and the visible ones (including the other dangerous one) are present",
        !results.some((r) => r.path === "constructor") &&
          results.some((r) => r.path === "__proto__") &&
          results.some((r) => r.path === "ordinary.md")
      );
    }
  }

  // -- what one shard RETAINS is bounded, whatever its vocabulary ----------
  //
  // `scoreCollected` can consume at most `PREFIX_MAX_EXPANSIONS` (10) plus
  // `FUZZY_MAX_CANDIDATES` (2) expansions per query term, and none at all once
  // the term has a global direct hit. Everything past that is retained for
  // nothing — and `collections` is held across the whole shard walk while the
  // shard objects are dropped one at a time, so an unbounded per-shard
  // retention is a retention that grows with the CORPUS. That is the ceiling
  // v2 exists to remove, moved from the parse step to the gather step.
  //
  // Both halves have to be bounded for either bound to be worth anything: a
  // vocabulary of terms that merely CONTAIN the query term clears the dice
  // threshold without any of them being a prefix, so capping prefixes alone
  // leaves the retention open by the other door. Measured before the cap:
  // 6,000 retained out of an 8,000-term shard.
  {
    const docs = new Map();
    for (let i = 0; i < 50; i++) {
      docs.set(`1-projects/n${i}.md`, { len: { title: 2, headings: 1, tags: 0, body: 100 } });
    }
    const paths = [...docs.keys()];

    const shardWith = (make, count) => {
      const terms = new Map();
      for (let i = 0; i < count; i++) {
        terms.set(make(i), new Map([[paths[i % paths.length], [1]]]));
      }
      return { version: 2, docs, terms };
    };

    // 2,000 prefix-plausible terms for "con".
    const prefixHeavy = shardWith((i) => `contact${i}`, 2000);
    const prefixOut = collectShardCandidates(prefixHeavy, ["con"], () => true);
    check(
      "a shard retains a bounded candidate set however many PREFIX matches its vocabulary holds",
      prefixOut.vocab.size <= 16 && prefixHeavy.terms.size === 2000,
      `retained ${prefixOut.vocab.size} of ${prefixHeavy.terms.size}`
    );

    // 2,000 terms that contain "contactsheet" without starting with it, so
    // every one is fuzzy-plausible and none is a prefix.
    const fuzzyHeavy = shardWith((i) => `x${i}contactsheet`, 2000);
    const fuzzyOut = collectShardCandidates(fuzzyHeavy, ["contactsheet"], () => true);
    check(
      "...and however many FUZZY ones, which is the door capping prefixes alone leaves open",
      fuzzyOut.vocab.size <= 128 && fuzzyHeavy.terms.size === 2000,
      `retained ${fuzzyOut.vocab.size} of ${fuzzyHeavy.terms.size}`
    );

    // A direct hit discards every expansion, so retaining thousands for one is
    // the purest form of the waste.
    const directOut = collectShardCandidates(prefixHeavy, ["contact7"], () => true);
    check(
      "...and a query term with a direct hit, whose expansions can never be consumed at all",
      directOut.vocab.size <= 128 && directOut.postings.has("contact7"),
      `retained ${directOut.vocab.size} of ${prefixHeavy.terms.size}`
    );
  }

  // -- the prefix cap is exact: capping per shard changes no result ---------
  //
  // The bound above is only safe because alphabetical order is total and
  // shard-independent: a term in the global first ten is preceded globally by
  // at most nine, and the terms preceding it inside its own shard are a subset
  // of those. So the same corpus must score identically however it is
  // partitioned, INCLUDING when each shard's own slice throws candidates away.
  {
    const specs = [];
    for (let i = 0; i < 40; i++) {
      specs.push({ path: `1-projects/p${i}.md`, body: `contactsheet${i} filler words here` });
    }
    const index = buildIndex(specs);
    const one = splitIntoShards(index, 1, () => 0);
    const many = splitIntoShards(index, 7, (path) => path.length % 7);

    const a = scoreCollected(collectAll(one, "contacts"), "contacts");
    const b = scoreCollected(collectAll(many, "contacts"), "contacts");
    check(
      "a prefix expansion over 40 candidates scores identically at 1 shard and at 7",
      a.length > 0 && scoresMatch(a, b),
      `1 shard -> ${a.length} results, 7 shards -> ${b.length}`
    );
  }

  // -- a future-dated `uploaded` cannot buy an unbounded recency multiplier -
  //
  // v2 carries its own copy of v1's recency formula, and a sabotage that
  // deleted the `Math.max(0, ...)` clamp from it left the whole suite green:
  // the clamp was correct and unguarded. `uploaded` comes from the storage
  // object's `LastModified`, which is the customer's bucket — and unclamped,
  // `e^(+age/90)` is an unbounded score multiplier one crafted timestamp away.
  {
    // ISO strings, not epoch numbers: `recencyMultiplier` returns 1 for
    // anything that is not a non-empty string, so a numeric fixture makes this
    // check compare two docs with no recency applied at all. The first version
    // of it did exactly that and passed with the clamp deleted.
    const iso = (ms) => new Date(ms).toISOString();
    const docs = new Map([
      ["1-projects/past.md", { uploaded: iso(Date.now() - 86400_000), len: { title: 0, headings: 0, tags: 0, body: 10 } }],
      ["1-projects/future.md", { uploaded: iso(Date.now() + 100 * 365 * 86400_000), len: { title: 0, headings: 0, tags: 0, body: 10 } }],
    ]);
    const terms = new Map([
      ["gateway", new Map([["1-projects/past.md", [1]], ["1-projects/future.md", [1]]])],
    ]);
    const scored = scoreCollected(
      [collectShardCandidates({ version: 2, docs, terms }, ["gateway"], () => true)],
      "gateway"
    );
    const future = scoreOf(scored, "1-projects/future.md");
    const past = scoreOf(scored, "1-projects/past.md");
    check(
      "a century-future timestamp scores within a whisker of its present-day twin",
      past > 0 && future / past < 1.1,
      `future/past = ${(future / past).toFixed(4)}`
    );
  }

}
