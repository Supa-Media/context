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
**not** snapshotted anywhere — it is a derivative, and versioning a
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

- `.index/v2/manifest.json` — **the query surface**, and the pass's single
  commit point. Carries `{version: 3, shardCount, generatedAt, stats, filters,
  freshness}` where `stats` is an array of per-shard `{docCount, lenTotals:
  {title, headings, tags, body}}`, `filters` is an array of `shardCount` base64
  Bloom filters over each shard's own vocabulary (or `null`, which every reader
  must treat as "read that shard"), and `freshness` is
  `{listedAt, pending, truncated}` — what the last pass that listed the bucket
  found. A query reads this object and no other bookkeeping.
- `.index/v2/docmap.json` — **the diff surface**, read by maintenance and by
  nothing else. `{version: 3, shardCount, docsByShard}`, where `docsByShard` is
  an array of `shardCount` arrays of `[path, version]` pairs (the same
  listing-derived token v1 stores). Serialized as arrays of pairs throughout —
  the v1 prototype-pollution rule. It carries the shard count so a docmap
  cannot be applied to an index that has since been re-sharded.

  **This was inside the manifest, and moving it is why a query got fast.** One
  `[path, version]` pair per note in the bucket is ~900KB at eight thousand
  notes, downloaded by every search to learn a shard count it could have had in
  five. Manifests are read at version 2 (diff inline, no filters, no freshness)
  or 3, and written at 3, so an upgrade is seamless and a **rollback rebuilds**
  — expensive, correct, and what a disposable derivative is for. Writing the
  diff into both objects to keep an older reader happy would be one list
  authored twice, and the direction that fails is two copies disagreeing about
  what a shard holds.
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
The manifest and the docmap share `MANIFEST_PARSE_BYTE_CAP = 4MB`; an
unreadable or oversized manifest is a full rebuild, and an unreadable docmap is
a re-index of what is already indexed. `NOTE_INDEX_CHAR_CAP` stays as v1.

A routing filter is sized at `FILTER_BITS_PER_TERM = 8` with `FILTER_HASHES = 5`
— a false-positive rate near 2%, measured — clamped to `[FILTER_MIN_BYTES,
FILTER_MAX_BYTES]`. A vocabulary past the cap gets a denser filter, which costs
recall nothing and the walk an occasional extra shard.

## Maintenance

**Maintenance never runs inside an answer.** A search reads a ready index; the
pass below runs behind the response — `ctx.waitUntil` in the gateway, a
scheduled Convex action in the console — with one exception, stated in § Query.
That is the whole of why a search over a 7,961-note context went from 20-60
seconds to a fraction of one, and it is a rule rather than a tuning: the
subrequest budget bounds what a search may *spend* and cannot see what a person
*waits for*.

Per pass, budget-bounded exactly as v1: GET manifest → GET docmap (the diff;
skipped for a v2 manifest, which carries it inline) → list notes → diff against
`docsByShard` → group stale docs by shard → for each shard with stale docs (in
shard-id order): GET shard (skip if the manifest says it has no docs yet), fetch
stale notes in waves, addDoc/removeDoc, write the shard (byte-capped,
unconditional — the manifest is the concurrency point), rebuild that shard's
routing filter, update its `docsByShard`/`stats` entries → record what the
listing found in `freshness` → write the manifest conditional on the etag it was
read at, and **then** the docmap. On a manifest conflict, serve the query and
skip, as v1 does.

**The docmap is written after the manifest, and the order is the safety
argument.** A docmap *ahead* of the manifest tells the next pass that a note is
already indexed while the manifest's stats and routing filter still describe the
shard before it: the note is never re-indexed, the filter never learns its
terms, and the query that would have found it skips its shard — permanently. A
docmap *behind* the manifest costs the next pass a re-fetch of notes that were
already indexed. Slow, self-correcting, and the direction every unknown in this
format falls.

`MANIFEST_WRITE_RESERVE` is **two** ops for the same reason: the pass's commit
is two objects. At one, every pass spent its last op on the manifest and had
none left for the docmap, so the next pass re-diffed against an empty map —
measured on 1,500 notes at a budget of 600, 591 documents indexed on pass one
and 591 on pass eight, with `pending` stuck at 909 forever. The shards were
written; nothing remembered that they had been.

**A pass may be given a backfill cap and a walk reserve**, and both exist
because the subrequest budget bounds spending rather than waiting.

- `backfillOps` caps the **note reads** one pass performs. It matters in two
  places now that maintenance is behind the response: a host with no
  `waitUntil` to defer to, which runs the pass inline and must bound what it
  makes the caller wait for, and the one refresh a miss may buy (§ Query).
  It caps reads and not every op: the listing is what tells the diff which notes
  are stale, and a pass that cannot finish listing reports `listingTruncated` on
  a converged bucket, which renders as "the index is still catching up" forever.
- `walkReserve` keeps back one op **per occupied shard**, on top of `reserve`,
  because a walk that follows a pass on the same budget opens those shards
  before it can read a snippet. Both are the caller's work and neither may be
  spent by maintenance. Without it a bucket wide enough to need several passes
  answered **`0 matching notes` over a term every note carried** — measured on a
  1,500-note fixture at a budget of 120 (passes 4 onward, permanently) and on a
  7,961-note fixture at 600 (thirteen consecutive searches). Only the miss
  refresh still puts a pass in front of an answer, and it is exactly the caller
  that must not get a miss wrong twice.

**Folder listings run in bounded waves** (`LIST_CONCURRENCY`). Pagination
inside one folder stays sequential — the next page is addressed by the previous
page's cursor — and the folders are independent of each other.

**One shard the diff wanted nothing from is audited per pass**, on budget the
real work left over. The diff reads the manifest, so a shard whose stored
object is unreadable — corrupt, truncated, half-written, or in a dialect this
gateway refuses — is in no worklist: the manifest keeps vouching for its
docs, `pending` reads 0 over them, and it heals only when somebody happens to
edit one of those notes. An audit that arrives unreadable is an empty shard on
the loop's own terms and rebuilds through the ordinary path. It is **one** and
never all of them because it is spare-budget work, and it rotates on the clock
rather than on `generatedAt`, which does not advance on the passes that find
nothing and would stick the rotation on one shard forever.

**And up to `FILTER_BACKFILL_PER_SYNC` shards are opened purely to give them a
routing filter.** Every index that existed before filters did is one, and a
converged bucket's pass touches no shard, so without this the migration would
complete only as each shard happened to be edited — which for a shard nobody
edits is never. It is spare-budget work on the same gate as the audit, and the
list is permanently empty once a bucket has been through it.

Two things about the audit are worth stating rather than leaving to be
inferred. **The refused dialect is a future one, not the version-2/3 pair**: the
gateway that refuses a version-3 shard predates this audit and so cannot run it,
and the gateway that runs it reads both dialects, so those shards are healthy to
it. The audit is what makes the *next* such rollback survivable. And **the audit
has a budget cutoff above which it never runs**: the gate is `callerReserve + 1 +
AUDIT_OPS + shardCount`. Where that line falls depends on what the listing
costs, so it is measured rather than derived — on a two-root fixture at the
default `SEARCH_SUBREQUEST_BUDGET` of 40, the last shard count that audits is
**9** (~2,700 notes). Coverage is eventual below that line and absent above it;
raising the budget restores it, and a background pass on a paid deployment is
comfortably above it.

## Query

**A query reads the manifest and the shards its terms can be in, and nothing
else.** No listing, no diff, no note read that is not being quoted, no write.

GET manifest → **route**: each shard's `filters[id]` is a Bloom filter over that
shard's own vocabulary, and a shard whose filter holds none of the query's terms
is not opened. The filter has no false negatives, so this can never lose a hit;
every way it can be wrong costs one extra shard read. Three rules make that
true rather than nearly true:

- **An absent or unreadable filter means "read the shard".** A manifest written
  before filters existed has none, and reading absence as "no terms" is every
  search on every existing index answering nothing.
- **A query term no shard claims has provably no exact match**, so the shards
  opened for it are opened only for expansion vocabulary — the scorer expands a
  term with df 0 against the vocabulary, and the vocabulary lives inside the
  shards. That is worth paying for and not worth paying in full, so it is a
  **sample** of `EXPANSION_SHARD_SAMPLE` shards spread across the id space, in
  the same spirit as `SHARD_FUZZY_RETAIN`: an expansion the sample missed costs
  a suggestion, never a hit.
- **The corpus statistics are computed over the shards that were opened.** `N`,
  `avglen` and every `df` shift together, so this changes scores rather than
  results, and what has not changed is *whose* corpus: every statistic is still
  computed over docs `isVisible` accepts.

Then for each shard to read (the manifest's docCount decides — an empty shard is
never fetched), **read in waves of `SHARD_READ_CONCURRENCY` and decode one at a
time**: parse, collect the query terms' postings, each term's per-shard df,
per-shard prefix/fuzzy vocab expansions, and doc metadata for candidate paths
only, then release the shard. A wave holds **bytes**, never parsed shards: six
`ArrayBuffer`s under `SHARD_PARSE_BYTE_CAP` is at most 12MB, where six parsed
shards would be six times the peak this format exists to keep at one.

After all shards: assemble global `N`, `avglen` and per-term df **from the
visible docs encountered during the walk** — never from manifest stats, which
are bookkeeping only, and never over all docs: the v1 inference-oracle rule
(`visibleIndex`) carries over whole, so every statistic and every expansion
vocabulary is computed on the caller's visible corpus. Score the merged
candidates with v1 semantics; `rankedVisibleTo`/`canSee` apply unchanged at
the output. Snippet reads are a wave too, with every op taken before any read
starts, so a wave can never overspend the counter.

**Honesty without a listing.** `indexIncomplete` is read off the manifest's
`freshness` record — what the last pass that *did* list found — plus whatever
this walk could not open. `listedAt: null` is an index no pass has recorded
this for, and it counts as behind: an unknown reported as complete is the one
direction that tells somebody their note is not written down.

### The one exception: a miss may buy a listing

An answer is as fresh as the last pass that listed the bucket, which is also
written by Obsidian, rclone and the provider's own console. For an answer with
hits in it that is a fine trade. For an empty one it is not — a miss is the
answer an agent acts on by concluding the thing was never written down.

So a caller may pass `refreshOnMiss`, and an empty answer over an index whose
`freshness` says it is **converged** runs one pass and asks again. Four bounds
on it, and each removes a way this could become the search it replaced:

- Only on a miss. A hit never buys a listing.
- Only over an index that believes it is complete. One capped pass out of the
  dozen a cold index still needs would not change the answer, and the cost would
  land on the buckets least able to afford it.
- The pass keeps back the re-ask's own work (`reserve`, `walkReserve`) and caps
  its note reads (`backfillOps`).
- The re-ask is skipped entirely when the pass moved no document, and its result
  is preferred only when it has hits — a refresh must never turn an answer into
  a miss.

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

Steady state, warm: 1 manifest GET + the shards the query's terms are in + up to
10 snippet reads. For an ordinary name that is **one** shard.

**Ops are not the cost a person feels.** Measured on a 7,961-note fixture (27
shards) at a simulated 60ms per store operation, against the same fixture before
a query read a ready index and routed itself:

|                        | before                     | after                    |
| ---------------------- | -------------------------- | ------------------------ |
| warm, one-note term    | 49 ops · 5.21MB · 1,357ms  | 3 ops · 0.19MB · 188ms   |
| warm, term in every note | 58 ops · 5.22MB · 1,471ms | 38 ops · 4.92MB · 752ms |
| warm, a true miss      | —                          | 32 ops · 1.73MB · 1,151ms |
| cold, the answer       | 590 ops · 3,926ms          | 1 op · 61ms              |

The "before" column is the same code with the sync in front of the answer and
the walk reading every shard. The cold row is the honest one to read carefully:
the answer costs one op because there is no index to read, and the gateway
answers that case from the bounded literal scan while the 600-op pass runs
behind the response.

A miss is the slowest warm answer by construction — it reads a sample of shards
for expansion vocabulary and then buys one listing — and that is the trade §
"The one exception" states.

