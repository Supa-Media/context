# The search index — format contract (v1)

This directory is the gateway's full-text search: a **disposable derivative**
of the notes, per CLAUDE.md's plain-files rule. It is rebuildable from the
bucket at any time, never the only copy of anything, and losing it costs one
rebuild, not data. It exists because the brute-force scan (`scanVisibleNotes`
fetching every note per query) exceeds Cloudflare's per-invocation subrequest
limit on real contexts — measured live at 154 notes — and cannot rank.

## Where it lives

One object per bucket: `.index/search-v1.json`. Dot-prefixed on purpose:
`isPlumbing` already hides every dot-segment key from every tool and every
scope, so the index is unreachable through the note surface without a single
new rule. It is written only by the gateway's own maintenance path
(`store.put`, conditional on etag), never through `write_note`, and it is
**not** snapshotted to `.history/` — it is a derivative, and versioning a
derivative of versioned files is waste.

**The index contains text drawn from private notes.** That is acceptable where
it lives — inside the customer's own bucket, beside those notes — and never
acceptable in what leaves the gateway: every result path is filtered through
`canSee` at query time, and snippets are cut from a fresh `store.get` of notes
the caller may read, never from index data. Nothing derived from a term's
presence in the vocabulary may reach a caller who could not read every note — a
"did you mean" built from vocabulary is an oracle for private note content and
must not be added.

**A query is scored against the caller's own view of the index, not the whole
one** (`visibleIndex`). An earlier version of this paragraph said instead that
"fuzzy/prefix expansions are query rewrites, not output", and that step is what
licensed the bug: expansion fires only at `df === 0`, df was counted over every
doc, so whether a visible note came back was a function of whether some private
note held the exact query word. A rewrite whose *trigger* is private content is
an output channel however it is spelled. The same is true of `N`, `avglen` and
`rank`, which reorder the results a caller *can* see. `visibleIndex` narrows
`docs`, which narrows all four, and recomputes `rank` over the visible subgraph
because that one is stored rather than derived at query time.

## In-memory shape

Maps, not plain objects: note paths and note words become keys, and
`__proto__` / `constructor` as an object key is prototype pollution waiting
for a caller. `parseIndex` must never place attacker-chosen strings on an
object as property names.

```js
{
  version: 1,
  docs: Map<path, {
    etag: string,          // bucket etag the indexed content came from
    uploaded: string|null, // ISO timestamp from the listing, for recency
    title: string,         // first ATX heading's text, else filename sans .md
    links: string[],       // resolved in-bucket .md paths this note links to
    len: { title, headings, tags, body },  // token counts per field
    rank: number,          // PageRank prior; 0 until computeRanks runs
  }>,
  terms: Map<term, Map<path, [tfTitle, tfHeadings, tfTags, tfBody]>>,
}
```

Fields are **disjoint**: heading lines and frontmatter are removed from body
before body is tokenized; the title's tokens are not double-counted anywhere.

## Serialized shape

`JSON.stringify` of:

```json
{
  "version": 1,
  "generatedAt": "<ISO>",
  "docs": [["<path>", {"etag": "...", "uploaded": "...", "title": "...",
             "links": ["..."], "len": {"title":0,"headings":0,"tags":0,"body":0},
             "rank": 0}], ...],
  "terms": [["<term>", [["<path>", [0,0,0,0]], ...]], ...]
}
```

Arrays of pairs, never keyed objects — same prototype-pollution rule.
`parseIndex(text)` returns the in-memory shape, or `null` for anything it
cannot fully validate (wrong version, wrong types, truncated JSON): a corrupt
index is a rebuild, never a throw and never a partial read.

## Field extraction (indexer.js)

- **frontmatter**: a leading `---\n…\n---` block. `tags:` inside it (inline
  `[a, b]` or a `- ` list) feeds the tags field. The block is stripped from body.
- **title**: text of the first ATX heading (`# …`); else the filename without
  `.md`.
- **headings**: text of every ATX heading line (all levels, title's line included
  — title is scored separately as its own field).
- **body**: everything else.
- **links**: `[[target]]` / `[[target|alias]]` (target gains `.md` if missing)
  and `[text](relative/path.md)` resolved against the note's folder with `.`/`..`
  segments normalized; keep only paths that stay inside the bucket root and end
  in `.md`; drop URLs with a scheme.

## Scoring (query.js) — pinned constants

BM25F, simplified (field-weighted tf folded before saturation):

**Every corpus statistic below — `N`, `df`, `avglen`, `rank` — is read over the
`index` argument, which is the caller's view rather than the stored index. The
constants are pinned; the corpus they are computed against is per-caller.**

- weights: title 4.0 · tags 3.0 · headings 2.5 · body 1.0
- length normalization b: title 0.4 · tags 0.3 · headings 0.5 · body 0.75
- k1 = 1.2
- idf = ln(1 + (N − df + 0.5)/(df + 0.5)), df = docs containing the term in any
  field
- per term: wtf = Σ_f weight_f · tf_f / (1 − b_f + b_f · len_f/avglen_f);
  contribution = idf · wtf/(k1 + wtf)
- coverage: a doc matching **every** query term scores ×2.0
- expansions: a prefix-expanded term contributes at ×0.7, a fuzzy-expanded term
  at ×0.5; expansion happens only for query terms with df = 0, prefix first
  (min 3 chars, ≤10 vocab expansions), then trigram fuzzy (Dice ≥ 0.55, best 2
  by df)
- PageRank prior: d = 0.85, 20 iterations over `docs[*].links` (edges to paths
  absent from `docs` are dropped; dangling mass redistributed uniformly), then
  min-max normalized to [0,1]; final = bm25f × (0.75 + 0.25 · rankNorm)
- recency: × (1 + 0.3 · e^(−ageDays/90)) from `uploaded`; missing `uploaded`
  uses ageDays = ∞ (multiplier 1)
- quoted phrases: their terms are required (part of coverage); v1 stores no
  positions, so adjacency is not verified — a phrase is an AND, documented as
  such.
- `searchIndex(index, query, { now }) → [{ path, score, matchedTerms }]`,
  sorted desc, ties by path, capped at 50. Empty/stopword-only query → [].
- `visibleIndex(index, isVisible) → index'`, the docs `isVisible` accepts, with
  `rank` recomputed over their subgraph and `terms` shared unchanged
  (`searchIndex` already drops postings whose doc is absent). Returns `index`
  itself when nothing is hidden, and throws on a predicate it cannot call —
  returning the index whole would silently restore the leak.
- `rankedVisibleTo(ranked, isVisible, prefix) → ranked'`, the same predicate
  applied to the output. Redundant with `visibleIndex` by construction and kept
  anyway: it is the half that does not depend on `visibleIndex` being correct.
  Being redundant, it is also unreachable by any end-to-end test, so it is a
  separate function with its own checks rather than an inline filter.

## Maintenance (maintain.js) — the sync loop

On each search call, under one subrequest budget (callers pass it; the worker
free tier allows 50 per invocation, so search uses ≤ 40 total):

1. `store.get(".index/search-v1.json")` → parse (null ⇒ empty index).
2. One bounded listing of note keys (paths + etags where the store reports
   them; the R2/S3 listings do).
3. Diff: keys whose etag differs or is absent from `docs` ⇒ stale; `docs`
   entries absent from the listing ⇒ removed.
4. Re-fetch and re-index as many stale notes as the remaining budget allows
   (removals are free); recompute ranks; conditional `put` with the etag read
   in step 1 — on conflict, **serve the query from what was built and skip the
   write**: a lost write is one extra sync later, a retry loop is budget spent
   on plumbing.
5. Answer from the (possibly still partial) index and report honestly:
   `pending > 0` means results carry the same kind of floor language the
   census and orient already use.

The index never gates correctness: a search with no usable index falls back to
the bounded scan, and the scan is itself capped below the subrequest budget so
it degrades instead of throwing `Too many subrequests`.
