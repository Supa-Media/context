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

## What is indexed of a note

**The first `NOTE_INDEX_CHAR_CAP` characters of the source, and no more.** The
cut is by characters of raw text before tokenization, so `len` and every `tf`
are consistent with what was actually indexed rather than with the file — and
`extractFields` runs on the sliced text, so a heading past the cut is not a
heading as far as this index is concerned.

This is a real, user-visible loss of recall, not an implementation detail: a
term deep inside a long note does not match, though `read_note` returns the
whole file. `toolSearchNotes` says so on a miss, because a search that is
silently partial is a search that tells an agent the thing is not written down.
The cap's own comment in `maintain.js` carries why the number is what it is.

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
    len: { title, headings, tags, body },  // token counts per field, over the
                                          // CAPPED text — see below
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
free tier allows 50 per invocation, so search defaults to ≤ 40 total, and a
paid-plan deployment raises it with `SEARCH_SUBREQUEST_BUDGET` in the
environment — clamped, and unparseable values fall back to the default,
because a typo'd var must not take search down or unbounded):

1. `store.get(".index/search-v1.json")` → parse (null ⇒ empty index). An
   object larger than `INDEX_PARSE_BYTE_CAP` is **refused unparsed** and
   treated exactly like a corrupt one: `JSON.parse` of a many-MB index
   inflates several-fold in a 128MB heap, and an index big enough to kill the
   invocation kills it before any pass can shrink it.
2. One bounded listing of note keys (paths + etags where the store reports
   them; the R2/S3 listings do).
3. Diff: keys whose etag differs or is absent from `docs` ⇒ stale; `docs`
   entries absent from the listing ⇒ removed.
4. Re-fetch and re-index as many stale notes as the remaining budget allows
   (removals are free); recompute ranks; conditional `put` with the etag read
   in step 1 — on conflict, **serve the query from what was built and skip the
   write**: a lost write is one extra sync later, a retry loop is budget spent
   on plumbing. The same cap applies here, in UTF-8 bytes, and it is the same
   number: **an index that would exceed it is not written at all.** A cap on
   one side only is not a smaller cap, it is a loop — the write stores an
   object the read then refuses, so the next pass rebuilds from empty and the
   index never converges.
5. Answer from the (possibly still partial) index and report honestly:
   `pending > 0` means results carry the same kind of floor language the
   census and orient already use. `pending` describes *the answer*, not the
   object: a pass that refused its own write can still report `pending: 0`,
   because the index it answered from was complete in memory even though
   nothing was persisted.

The index never gates correctness: a search with no usable index falls back to
the bounded scan, and the scan is itself capped below the subrequest budget so
it degrades instead of throwing `Too many subrequests`.

# The sharded index — format contract (v2)

v1's single object has a hard ceiling: it must be parsed whole, so
`INDEX_PARSE_BYTE_CAP` bounds it, and a brain whose capped index exceeds that
bound plateaus at partial coverage forever — measured live at roughly a
thousand docs of contact-heavy vocabulary. v2 removes the whole-object parse:
many small shards, each always under its own cap, streamed at query time so
peak memory is one shard.

## Objects

- `.index/v2/manifest.json` — the diff surface and the stats. Carries
  `{version: 2, shardCount, generatedAt, docsByShard, stats}` where
  `docsByShard` is an array of `shardCount` arrays of `[path, version]` pairs
  (the same listing-derived version token v1 stores), and `stats` is an array
  of per-shard `{docCount, lenTotals: {title, headings, tags, body}}`. The
  maintenance diff needs no shard reads: listing vs manifest decides staleness.
  Serialized as arrays of pairs throughout — the v1 prototype-pollution rule.
- `.index/v2/shard-<nnn>.json` — `nnn` is the zero-padded decimal shard id.
  Written as `{version: 3, generatedAt, docs, terms}` over only its docs, where
  `docs` is a sorted array of `[path, meta]` pairs and each posting in `terms`
  is `[docIndex, tf]` — the doc's position in that `docs` array, not its path.
  The interning is load-bearing, not cosmetic: path-keyed postings repeat every
  doc's path once per unique term (~150-250 terms against 50-80-byte paths),
  which crossed `SHARD_PARSE_BYTE_CAP` at about half of the 300-doc target and
  plateaued the live brain's backfill permanently — every pass rebuilt the same
  oversized shard and had its write refused. Readers also accept the earlier
  `{version: 2, docs, terms}` dialect (postings keyed by path string), because
  refusing it would rebuild every under-cap shard a working index already
  holds; writers emit version 3 only. A version-3 posting whose index is not an
  integer inside the `docs` array refuses the shard whole.

A note belongs to shard `fnv1a32(path) % shardCount` (FNV-1a, 32-bit,
offset-basis 2166136261, prime 16777619 — pinned so every writer agrees).
`shardCount` is chosen when the manifest is first created —
`clamp(ceil(listedNoteCount / 300), 1, 64)` — and never changes for the life
of the index; a brain that outgrows it is re-sharded by deleting the manifest
(everything here is disposable). A one-note brain gets one shard, so small
contexts pay v1's costs plus one manifest read.

## Caps

`SHARD_PARSE_BYTE_CAP = 2MB` per shard and the same rule in both directions as
v1: a shard too big to read is refused unparsed and rebuilt; a shard the sync
built past the cap is not written (that shard plateaus, `pending` says so).
The manifest has its own `MANIFEST_PARSE_BYTE_CAP = 4MB`; an unreadable or
oversized manifest is a full rebuild. `NOTE_INDEX_CHAR_CAP` stays as v1.

## Maintenance

Per pass, budget-bounded exactly as v1: GET manifest → list notes → diff
against `docsByShard` → group stale docs by shard → for each shard with stale
docs (in shard-id order): GET shard (skip if the manifest says it has no docs
yet), fetch stale notes in waves, addDoc/removeDoc, write the shard
(byte-capped, unconditional — the manifest is the concurrency point), update
that shard's `docsByShard`/`stats` entries → finally write the manifest
conditional on the etag it was read at; on conflict serve the query and skip,
as v1 does. A legacy `.index/search-v1.json` found while a manifest exists is
deleted when budget allows — disposable, and dead weight.

**One shard the diff wanted nothing from is audited per pass**, on budget the
real work left over. The diff reads the manifest, so a shard whose stored
object is unreadable — corrupt, truncated, half-written, or in a dialect this
gateway refuses — is in no worklist: the manifest keeps vouching for its
docs, `pending` reads 0 over them, and it heals only when somebody happens to
edit one of those notes. An audit that arrives unreadable is an empty shard on
the loop's own terms and rebuilds through the ordinary path. It is **one** and
never all of them because the sync does not own its budget — the query walk and
the snippet reads that answer the search spend what is left — so it runs only
with comfortably more than the write reserves spare, and it rotates on the
clock rather than on `generatedAt`, which does not advance on the passes that
find nothing and would stick the rotation on one shard forever.

Two things about that are worth stating rather than leaving to be inferred.
**The refused dialect is a future one, not the version-2/3 pair**: the gateway
that refuses a version-3 shard predates this audit and so cannot run it, and the
gateway that runs it reads both dialects, so those shards are healthy to it. The
audit is what makes the *next* such rollback survivable. And **the audit has a
budget cutoff above which it never runs**: the gate is `reserve + 1 +
AUDIT_OPS + shardCount`, so on the default `SEARCH_SUBREQUEST_BUDGET` of 40 it
stops firing at `shardCount >= 20` — about 5,700 notes. Coverage is eventual
below that line and absent above it, which is the opposite of where it is most
needed; raising the budget restores it.

## Query

Gather-then-score, streaming: GET manifest → for each non-empty shard (the
manifest's docCount decides — an empty shard is never fetched), sequentially
today: parse, collect the
query terms' postings, each term's per-shard df, per-shard prefix/fuzzy vocab
expansions, and doc metadata for candidate paths only, then release the shard.
After all shards: assemble global `N`, `avglen` and per-term df **from the
visible docs encountered during the walk** — never from manifest stats, which
are bookkeeping only, and never over all docs: the v1 inference-oracle rule
(`visibleIndex`) carries over whole, so every statistic and every expansion
vocabulary is computed on the caller's visible corpus. Score the merged
candidates with v1 semantics; `rankedVisibleTo`/`canSee` apply unchanged at
the output. The sequential walk is a known wall-clock cost at high shard
counts (64 serial GETs); a fetch/parse split that reads in bounded waves while
parsing one at a time is the queued follow-up, and amending this sentence
without building it would be the contract describing code that does not exist.

**What a shard retains while the walk runs is bounded.** The shard objects
themselves are streamed and dropped one at a time, which is the memory bound v2
exists for — but the collections built from them are held until the walk ends,
so an unbounded per-shard retention is the same blowup by another route.
`collectShardCandidates` therefore caps expansion candidates per query term:
alphabetically at `PREFIX_MAX_EXPANSIONS`, which is exact because alphabetical
order is total and shard-independent, and by descending in-shard df at
`SHARD_FUZZY_RETAIN`, which is an approximation of a global ranking and is
documented as one at the call site. Both halves must be capped for either cap to
bound anything: terms that merely CONTAIN a query term clear the dice threshold
without being prefixes.

**PageRank is neutral (rank = 1) in v2**, deliberately: a global link graph
needs every shard in memory at maintenance time, which is the exact blowup v2
exists to remove. The 0.75–1.0 multiplier band is given up; BM25F, coverage,
expansion and recency carry ranking. Revisit only with a design that keeps the
one-shard memory bound.

## Costs

Steady state: 1 manifest GET + `shardCount` shard GETs + 2–4 lists + 10
snippet reads. At 64 shards that is ~80 ops — paid-plan territory; a
deployment on the free tier keeps small brains (shardCount 1–2) inside its
budget and larger ones degrade to the bounded scan honestly, which is v1's
behavior too.
