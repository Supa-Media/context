/**
 * Checks for src/search/query.js — parseQuery, computeRanks, searchIndex —
 * against CONTRACT.md's pinned scoring constants.
 *
 * Fixtures are built entirely by hand as Maps in the contract's in-memory
 * shape (`buildIndex` below), never imported from indexer.js: that module is
 * owned by somebody else's work in this same directory, and a query-side test
 * that depended on it would start failing the moment the indexer's own
 * behavior changed, for reasons that have nothing to do with query.js. The
 * one thing borrowed from the indexer's world is `termsOf` from text.js — the
 * one copy of the tokenization rule — used here only to turn each fixture's
 * plain-text fields into realistic tf counts and lengths, the same way a real
 * indexer would, without re-implementing stemming.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to src/search/query.js and reverted:
 *
 * 1. **FIELD_WEIGHT.title and FIELD_WEIGHT.body swapped** (title given
 *    body's 1.0, body given title's 4.0). Broke "a title hit outranks the
 *    same term in body" — the title-hit doc lost to the body-hit doc, since
 *    the low-weight field could no longer out-contribute the high-weight one.
 * 2. **Coverage multiplier inverted** (`coverage ? bm25 : bm25 *
 *    COVERAGE_MULTIPLIER`, i.e. the ×2.0 applied to the doc missing a term
 *    instead of the doc matching every term). Broke "a doc matching every
 *    query term outranks a doc matching only one" and "a doc matching every
 *    phrase term outranks one missing a phrase term" — both flipped to the
 *    partial-match doc winning.
 */

import { parseQuery, computeRanks, searchIndex } from "../src/search/query.js";
import { termsOf } from "../src/search/text.js";

// -- fixture builder ---------------------------------------------------
//
// Takes plain-text per field and derives tf/len the way an indexer would,
// via termsOf — so a fixture's expected matches are whatever the real
// stemmer produces, never a hand-typed guess that could quietly drift from
// text.js's actual rules.

function fieldTermFrequencies(text) {
  const counts = new Map();
  for (const term of termsOf(text)) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}

const FIELD_ORDER = ["title", "headings", "tags", "body"];

/**
 * @param {{ path: string, title?: string, headings?: string, tags?: string,
 *   body?: string, links?: string[], uploaded?: string|null, rank?: number }[]} specs
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
      rank: spec.rank ?? 0,
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

function scoreOf(results, path) {
  return results.find((r) => r.path === path)?.score ?? 0;
}

/** Runs a thunk and reports whether it threw, instead of crashing the suite. */
function attempt(fn) {
  try {
    fn();
    return { threw: false };
  } catch (err) {
    return { threw: true, err };
  }
}

export async function runSearchQueryChecks(check) {
  // -- parseQuery ---------------------------------------------------

  {
    const pq = parseQuery("");
    check("parseQuery of an empty string returns empty phrases and terms", pq.phrases.length === 0 && pq.terms.length === 0);
  }

  {
    const pq = parseQuery('"alpha beta" gamma');
    check(
      "parseQuery splits a quoted span into a phrase and leaves the rest as terms",
      pq.phrases.length === 1 && pq.phrases[0].join(" ") === "alpha beta" && pq.terms.join(",") === "gamma",
    );
  }

  {
    const pq = parseQuery("gateway gateway setup setup");
    check(
      "parseQuery dedupes repeated terms",
      pq.terms.length === 2 && pq.terms.includes("gateway") && pq.terms.includes("setup"),
    );
  }

  {
    const pq = parseQuery('an unterminated "quote stays as loose text');
    check("parseQuery does not throw on an unterminated quote", Array.isArray(pq.terms));
  }

  // -- field weighting: title vs. body -------------------------------

  {
    const idx = buildIndex([
      { path: "title-hit.md", title: "gateway", body: "notes about setup" },
      { path: "body-hit.md", title: "notes", body: "gateway setup notes" },
    ]);
    computeRanks(idx);
    const results = searchIndex(idx, "gateway");
    check(
      "a title hit outranks the same term appearing only in the body",
      scoreOf(results, "title-hit.md") > scoreOf(results, "body-hit.md"),
    );
  }

  // -- idf: rare term outranks common term at equal placement --------

  {
    const idx = buildIndex([
      { path: "c1.md", body: "common" },
      { path: "c2.md", body: "common" },
      { path: "c3.md", body: "common" },
      { path: "c4.md", body: "common" },
      { path: "c5.md", body: "common" },
      { path: "r.md", body: "rare" },
    ]);
    computeRanks(idx);
    const rareScore = scoreOf(searchIndex(idx, "rare"), "r.md");
    const commonScore = scoreOf(searchIndex(idx, "common"), "c1.md");
    check(
      "a rare term scores higher than an equally-placed common term (idf)",
      rareScore > 0 && rareScore > commonScore,
    );
  }

  // -- coverage --------------------------------------------------------
  //
  // "both.md"/"one.md" (2 terms vs. 1) would pass this even with the ×2.0
  // deleted or inverted: the extra term's own additive contribution alone is
  // enough to win, so that shape never actually exercises the multiplier.
  // Missing exactly one term out of five keeps the two docs' raw (pre-
  // coverage) sums close enough that only the coverage multiplier — applied
  // in the right direction — decides the order; this is the fixture that
  // caught sabotage #2 below.

  {
    const idx = buildIndex([
      { path: "full.md", body: "alpha beta gamma delta epsilon" },
      { path: "partial.md", body: "alpha beta gamma delta" },
    ]);
    computeRanks(idx);
    const results = searchIndex(idx, "alpha beta gamma delta epsilon");
    check(
      "a doc matching every query term outranks a doc missing just one",
      scoreOf(results, "full.md") > 0 && scoreOf(results, "full.md") > scoreOf(results, "partial.md"),
    );
  }

  // -- phrases: their terms are required for the coverage bonus -------

  {
    const idx = buildIndex([
      { path: "full.md", body: "alpha beta gamma delta epsilon" },
      { path: "partial.md", body: "alpha beta gamma delta" },
    ]);
    computeRanks(idx);
    const results = searchIndex(idx, '"alpha beta gamma delta epsilon"');
    check(
      "a doc matching every phrase term outranks one missing a phrase term",
      scoreOf(results, "full.md") > 0 && scoreOf(results, "full.md") > scoreOf(results, "partial.md"),
    );
  }

  // -- fuzzy expansion (typo) ------------------------------------------

  {
    const idx = buildIndex([{ path: "typo.md", body: "gateway setup" }]);
    computeRanks(idx);
    const direct = scoreOf(searchIndex(idx, "gateway"), "typo.md");
    const fuzzy = searchIndex(idx, "gatway").find((r) => r.path === "typo.md");
    check(
      "a typo (\"gatway\") finds the doc via fuzzy trigram expansion",
      Boolean(fuzzy) && fuzzy.matchedTerms.includes("gateway"),
    );
    check(
      "the fuzzy-expanded match scores lower than the same doc's direct match",
      Boolean(fuzzy) && fuzzy.score > 0 && fuzzy.score < direct,
    );
  }

  // -- prefix expansion --------------------------------------------------

  {
    const idx = buildIndex([{ path: "typo.md", body: "gateway setup" }]);
    computeRanks(idx);
    const prefixed = searchIndex(idx, "gate").find((r) => r.path === "typo.md");
    check(
      "a 3+-char prefix matches a longer vocabulary term",
      Boolean(prefixed) && prefixed.matchedTerms.includes("gateway"),
    );
  }

  {
    const idx = buildIndex([{ path: "short.md", body: "ab startle" }]);
    computeRanks(idx);
    const tooShort = searchIndex(idx, "ab");
    check(
      "a query term under 3 chars does not trigger prefix expansion",
      !tooShort.some((r) => r.matchedTerms.includes("startle")),
    );
  }

  // -- expansion only fires for df = 0 terms --------------------------

  {
    const idx = buildIndex([
      { path: "typo.md", body: "gateway setup" },
      { path: "other.md", body: "gatehouse structure" },
    ]);
    computeRanks(idx);
    const hit = searchIndex(idx, "gateway").find((r) => r.path === "typo.md");
    check(
      "expansion does not fire for a term already present in the vocabulary",
      Boolean(hit) && hit.matchedTerms.length === 1 && hit.matchedTerms[0] === "gateway",
    );
  }

  // -- PageRank ---------------------------------------------------------

  {
    const idx = buildIndex([
      { path: "popular.md", body: "gateway notes" },
      { path: "lonely.md", body: "gateway notes" },
      { path: "l1.md", body: "link", links: ["popular.md"] },
      { path: "l2.md", body: "link", links: ["popular.md"] },
      { path: "l3.md", body: "link", links: ["popular.md"] },
      { path: "l4.md", body: "link", links: ["popular.md"] },
      { path: "l5.md", body: "link", links: ["popular.md"] },
    ]);
    computeRanks(idx);
    check(
      "computeRanks gives the heavily-linked doc a higher rank than the unlinked one",
      idx.docs.get("popular.md").rank > idx.docs.get("lonely.md").rank,
    );
    const results = searchIndex(idx, "gateway");
    check(
      "a heavily-linked-to doc outranks an identical unlinked doc",
      scoreOf(results, "popular.md") > scoreOf(results, "lonely.md"),
    );
  }

  {
    const solo = buildIndex([{ path: "solo.md", body: "gateway" }]);
    computeRanks(solo);
    check("a single-doc graph normalizes rank to the stable neutral value", solo.docs.get("solo.md").rank === 1);

    const linkless = buildIndex([
      { path: "a.md", body: "x" },
      { path: "b.md", body: "y" },
    ]);
    computeRanks(linkless);
    check(
      "a linkless multi-doc graph normalizes every rank to the same stable neutral value",
      linkless.docs.get("a.md").rank === 1 && linkless.docs.get("b.md").rank === 1,
    );
  }

  // -- recency ------------------------------------------------------------

  {
    const now = new Date("2026-08-29T00:00:00Z").getTime();
    const idx = buildIndex([
      { path: "new.md", body: "gateway notes", uploaded: "2026-08-28T00:00:00Z" },
      { path: "old.md", body: "gateway notes", uploaded: "2025-01-01T00:00:00Z" },
    ]);
    computeRanks(idx);
    const results = searchIndex(idx, "gateway", { now });
    check(
      "a newer doc outranks an otherwise-identical older doc (recency)",
      scoreOf(results, "new.md") > scoreOf(results, "old.md"),
    );
  }

  {
    const idx = buildIndex([
      { path: "missing.md", body: "gateway", uploaded: null },
      { path: "bogus.md", body: "gateway", uploaded: "not-a-date" },
    ]);
    computeRanks(idx);
    const attemptResult = attempt(() => searchIndex(idx, "gateway", { now: Date.now() }));
    check("a missing or unparseable uploaded timestamp does not throw", !attemptResult.threw);
  }

  {
    // `uploaded` comes from the backend's listing, so clock skew and a hostile
    // endpoint can both date a note into the future. Unclamped, e^(+age/90) is
    // an unbounded multiplier — one crafted timestamp outranking every real
    // note. Clamped, a future date earns exactly what "written this instant"
    // earns, so it cannot beat an otherwise-stronger doc.
    const now = new Date("2026-08-29T00:00:00Z").getTime();
    const idx = buildIndex([
      { path: "skewed.md", body: "gateway notes", uploaded: "2036-01-01T00:00:00Z" },
      { path: "stronger.md", title: "gateway", body: "gateway notes", uploaded: "2026-08-29T00:00:00Z" },
    ]);
    computeRanks(idx);
    const results = searchIndex(idx, "gateway", { now });
    check(
      "a future-dated uploaded timestamp is clamped to the present-day bonus, never an unbounded one",
      scoreOf(results, "stronger.md") > scoreOf(results, "skewed.md"),
    );
  }

  // -- cap at 50 ------------------------------------------------------------

  {
    const specs = [];
    for (let i = 0; i < 60; i++) specs.push({ path: `doc${String(i).padStart(2, "0")}.md`, body: "widget" });
    const idx = buildIndex(specs);
    computeRanks(idx);
    const results = searchIndex(idx, "widget");
    check("results are capped at 50 even when more docs match", results.length === 50);
  }

  // -- empty / degenerate queries -------------------------------------------

  {
    const idx = buildIndex([{ path: "a.md", body: "gateway" }]);
    computeRanks(idx);
    check("an empty query returns no results", searchIndex(idx, "").length === 0);
    check("a whitespace-only query returns no results", searchIndex(idx, "   ").length === 0);
    check("a punctuation-only query returns no results", searchIndex(idx, "!!! --- ??? ...").length === 0);
    const nonString = attempt(() => {
      if (searchIndex(idx, undefined).length !== 0) throw new Error("expected empty");
      if (searchIndex(idx, null).length !== 0) throw new Error("expected empty");
    });
    check("a non-string query does not throw and returns no results", !nonString.threw);
  }

  // -- absent term, zero-doc index: must not throw --------------------------

  {
    const idx = buildIndex([{ path: "a.md", body: "gateway" }]);
    computeRanks(idx);
    const result = attempt(() => searchIndex(idx, "zzzzznotfoundanywhere"));
    check(
      "a term absent from every doc and unreachable by expansion returns no results without throwing",
      !result.threw,
    );
    if (!result.threw) {
      check("...and the result is actually empty", searchIndex(idx, "zzzzznotfoundanywhere").length === 0);
    }
  }

  {
    const empty = { version: 1, docs: new Map(), terms: new Map() };
    const ranksAttempt = attempt(() => computeRanks(empty));
    check("computeRanks does not throw on a zero-doc index", !ranksAttempt.threw);
    const searchAttempt = attempt(() => searchIndex(empty, "gateway"));
    check("searchIndex does not throw on a zero-doc index", !searchAttempt.threw && searchIndex(empty, "gateway").length === 0);
  }

  // -- determinism ------------------------------------------------------------

  {
    const idx = buildIndex([
      { path: "a.md", body: "gateway setup" },
      { path: "b.md", body: "gateway config" },
    ]);
    computeRanks(idx);
    const query = "gateway setup gatway"; // includes a fuzzy expansion, not just direct hits
    const run1 = JSON.stringify(searchIndex(idx, query));
    const run2 = JSON.stringify(searchIndex(idx, query));
    check("two identical searches, including one that expands, produce identical output", run1 === run2);
  }

  // -- adversarial: __proto__ / constructor as index keys --------------------
  //
  // Real notes reach query.js only through indexer.js's tokenizer, which
  // strips the underscores out of "__proto__" before it could ever become a
  // literal Map key or query term. This index is hand-built specifically to
  // bypass that and put the dangerous strings directly where an indexer bug,
  // a future format change, or a hostile index file could put them: as a doc
  // path, a link target, and a vocabulary term.

  {
    const protoPropsBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
    const dangerousIndex = {
      version: 1,
      docs: new Map([
        [
          "__proto__",
          {
            etag: "e1",
            uploaded: null,
            title: "proto doc",
            links: ["constructor", "hasOwnProperty", "does-not-exist.md"],
            len: { title: 2, headings: 0, tags: 0, body: 2 },
            rank: 0,
          },
        ],
        [
          "constructor",
          {
            etag: "e1",
            uploaded: null,
            title: "constructor doc",
            links: ["__proto__"],
            len: { title: 1, headings: 0, tags: 0, body: 2 },
            rank: 0,
          },
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
      ]),
    };

    const result = attempt(() => {
      computeRanks(dangerousIndex);
      searchIndex(dangerousIndex, "constructor __proto__ hasOwnProperty toString valueOf");
      parseQuery("__proto__ constructor");
    });
    check("a query term / doc path / link of \"__proto__\" or \"constructor\" does not throw", !result.threw);

    const protoPropsAfter = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
    check("...and does not add any property to Object.prototype", protoPropsBefore === protoPropsAfter);
    check("...and a fresh plain object stays unpolluted", ({}).injected === undefined && ({}).polluted === undefined);
  }
}
