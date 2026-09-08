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
  cannot be applied to an index that has since been re-sharded — with one
  asymmetry that arrived with growth: a docmap for **fewer** shards than the
  manifest is **padded** with empty maps rather than refused, because the
  manifest is written first and the docmap only after it, so a pass that grew
  the count can leave the pair one step apart. Growth moves no doc, so every
  claim in the shorter docmap is still true of the shard it names and the ones
  it does not name are the new, empty ones. A docmap for **more** shards is
  still refused: that is a shrunk manifest or a rolled-back deployment, and
  there the claims really are about a different index.

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

An **ordinary** note belongs to shard `fnv1a32(path) % shardCount` (FNV-1a,
32-bit, offset-basis 2166136261, prime 16777619 — pinned so every writer
agrees). A **bundled** note — one whose documents are a set, which today means
a channel-day note — is placed instead in the least loaded shard that can
still take it (`placeUnclaimed`), because hashing an indivisible object with
hundreds of documents in it puts three of them in one shard often enough to be
certain. Either way, **a doc the manifest already claims never moves**: the
sync routes to the claimed shard first and consults placement only for a note
nothing claims yet.

`shardCount` is

```
clamp(max(ceil(listedNoteCount / 300),
          ceil(listedVolume / (300 * NOTE_INDEX_CHAR_CAP))), 1, MAX_SHARD_COUNT)
```

where `listedVolume` is `indexVolumeOf` summed over the listing: an ordinary
note is worth `min(size, NOTE_INDEX_CHAR_CAP)` and a bundled one is worth
`ceil(size * 1.25)`. The note term is the original formula and the volume term
can never beat it over ordinary notes, by construction — so no existing index
is re-sharded by this — while a bundled note can, which is the point.

The count **may grow on a later pass**, in place, when the volume or the
placement asks for it; it never shrinks, and shrinking is still "delete the
manifest" (everything here is disposable). A one-note brain gets one shard, so
small contexts pay v1's costs plus one manifest read.

## Caps

`SHARD_PARSE_BYTE_CAP = 2MB` per shard and the same rule in both directions as
v1: a shard too big to read is refused unparsed and rebuilt; a shard the sync
built past the cap is **not** written.

Before it gives up on writing one, the sync **sheds**: the note contributing
most to the over-cap body gives up documents — everything after its first, and
that first one blanked if it is all that is left — until the body fits, largest
note first, one note per round with the body re-serialized between rounds
(`SHED_ROUNDS = 8`). A shed note is never removed: it keeps one entry, so
`docsByShard` still records the version it was indexed at and the diff
converges instead of re-fetching it forever. The surviving docs carry
`shed: true`, `stats[id].shed` counts the notes per shard, `stats[id].shedPaths`
names them (written only when non-empty, the same sparse rule as `shed: true`
on a doc entry — an older gateway reading this manifest ignores a key it does
not validate, so both fields travel in both directions with no version bump),
and the sync answers `shed: string[]`. Only a shard with nothing left to shed
is refused, and that is counted separately as `oversizedShards`. Both are the
opposite of `pending`: `pending` says run another pass, these say the corpus
does not fit the index it has.

`shedNotePathsOf(manifest)` flattens `shedPaths` across every shard — raw and
unfiltered, private notes included, exactly like `manifest.filters` — so it
must be run through the caller's own `isVisible` before anything built from it
leaves the gateway. `searchIndexedNotes` does this on every query (never
gated on which shards that query's own routing happened to open, since the
whole failure this exists to fix is a shard whose filter correctly finds
nothing for a term a shed message used to hold) and reports the result as
`reducedRecall` / `reducedRecallNotes`, `indexIncomplete`'s opposite claim
(`docs/decisions/search.md`, "A shed index must say so to the caller it
happened to").

The manifest and the docmap share `MANIFEST_PARSE_BYTE_CAP = 4MB`; an
unreadable or oversized manifest is a full rebuild, and an unreadable docmap is
a re-index of what is already indexed. `NOTE_INDEX_CHAR_CAP` stays as v1.

`MAX_SHARD_COUNT = 64` is therefore also the index's whole capacity —
64 x 2MB = 128MB of index — and it is not free to raise: a routing filter is up
to `FILTER_MAX_BYTES` per shard, and 64 of them already spend ~1.6MB of the
manifest's own 4MB (measured). Past that capacity the index sheds rather than
failing; the numbers are in `docs/decisions/search.md`.

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

**Honesty about a wall a listing cannot move.** `reducedRecall` /
`reducedRecallNotes` are `indexIncomplete`'s opposite claim, read off the
manifest's `stats[id].shedPaths` and filtered through this same `isVisible` —
see § Caps, "sheds rather than taking the rest with it". Never folded into
`indexIncomplete`: that flag means another pass helps, and a shed note stays
shed until it shrinks or the index grows, so saying the same thing about both
would tell somebody to retry a fix that is not coming.

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

# Channel-day notes: one sub-document per message

Phase 2 of `docs/decisions/communications.md`, "Search must index messages,
and today's index cannot". A channel-day note (`0-inbox/email/*/`,
`0-inbox/google-chat/`, `0-inbox/imessage/`, per
`packages/communications/src/paths.js`'s `isChannelDayNotePath`) bundles many
messages into one file, and "What is indexed of a note" above takes the first
`NOTE_INDEX_CHAR_CAP` characters of a note and nothing else — indexing a day's
first two or three messages and silently dropping the rest, no matter how the
day is capped or split. Splitting the *file* does not rescue it: each part
still gets its own single `NOTE_INDEX_CHAR_CAP` window.

**So a channel-day note contributes one sub-document per message anchor,
`<notePath>#<anchor>`, instead of one document for the whole file.** The note
is unchanged in the bucket — this is entirely a shape the index, a disposable
derivative, is free to take. `src/search/commsIndex.js` owns the split:
`subDocumentsFor(path, full)` is the one seam the sync loop calls, answering
one sub-document (the note's own path, whole-file-capped, exactly as before)
for anything that is not a channel-day note, and one sub-document per message
for one that is. **A note that is not a channel-day note is indexed exactly as
it is today** — nothing about this reaches a brain with no mailbox connected.

## Placement, shape and the fields added to a doc entry

- **A channel-day note's messages all live in one shard**, never split across
  shards by anchor — but that shard is chosen by load rather than by hash
  (`placeUnclaimed`, above), and shard *sizing* counts the volume the listing
  implies rather than the objects it found. Both are the fix for the defect the
  first version of this section left open: counting objects sized a 25MB
  mailbox at one shard, whose body then passed `SHARD_PARSE_BYTE_CAP` on every
  pass, and the whole context — the ordinary notes beside the mail included —
  had no index at all. A note is still atomic, so a day too big for any shard
  is shed rather than refused (see Caps).
- **Every doc entry — in both v1's `docs` map and v2's shard `docs` — carries
  three new fields**, all optional so a stored index or shard written before
  this feature parses exactly as before (absent means "an ordinary note",
  `addDoc`'s own default):
  - `notePath: string` — the containing note's own bucket path. Equal to the
    doc's own key for an ordinary note; the part before the `#` for a
    sub-document.
  - `anchor: string|null` — the message anchor (`msg-<16 hex>`,
    `packages/communications/src/anchors.js`), or `null` for an ordinary note.
  - `comms: {channel, date, threadId, participants} | null` — filterable
    metadata read back off the rendered note, or `null` for an ordinary note.
    `channel` and `date` come from the note's own frontmatter. `threadId` is
    the **rendered thread label** the note groups messages under
    (`## Thread — <subject>`), not a hashed provider thread id: the bucket
    never retains the raw id at all (`docs/decisions/communications.md`, "A
    message anchor is a hash"), so re-reading the file back cannot recover
    one, and this is the best-available "which thread" signal that re-read
    can give. `participants` is the mailbox's own address plus the message's
    sender label, both read off the rendered heading and frontmatter — never
    re-derived from raw event data this module never sees.
- **A fourth field, `shed: true`, is written only where it is true.** The three
  above are absent on a pre-change shard and default to "an ordinary note", so
  writing them always is what says which docs are sub-documents. This one marks
  the rare case — a doc surviving in a note the shard could not hold whole —
  and `"shed": false` on every entry of every shard would be a standing cost in
  the customer's bucket for a fact that is almost never true. A stored `shed`
  that is present and not a boolean refuses the shard, like any other
  malformed field.
- **`notePath`/`anchor` are never parsed out of the doc's own key.** A doc's
  key can itself contain a literal `#` in principle, so every consumer that
  needs to tell a sub-document from its note reads the explicit field rather
  than splitting the string.

## `canSee` runs on the containing note, and never on a sub-document's key

This is the load-bearing rule, restated at every call site it touches because
getting it wrong is a privacy leak rather than a ranking mistake: **every
`isVisible`/`canSee` call in the query path is passed `doc.notePath`, never
the doc's own key.** A sub-document's key is `<notePath>#<anchor>`, which is
not a path `canSee` was ever asked about — checking it directly would miss an
*exact*-note override in `privacy.md` naming the note precisely (the override
matches `notePath`, never `notePath#anchor`), which is the concrete way this
goes wrong silently rather than loudly. `collectShardCandidates` in
`shardQuery.js` applies this at the point a shard's docs become "visible for
this caller at all"; `rankedVisibleTo` in `query.js` applies it again at the
ranked-result boundary, `?? path` for a v1 result or an ordinary v2 one that
never set `notePath`. Both stay independently correct rather than one relying
on the other having already narrowed the corpus — the same "two guards, not
one with a spare" reasoning § "A query reads a ready index" already gives for
`visibleIndex`/`rankedVisibleTo`.

A private channel-day note therefore yields **zero** sub-documents to a caller
who may not read it, at both guards, and a folder rule or an exact-note
override that would hide the note hides every message inside it identically —
there is no way to make one message inside a note visible while the note
itself is not, which is exactly the "no per-message share, no third
visibility word" rule `docs/decisions/communications.md` states for this
format.

## Regeneration replaces exactly one note's sub-documents

`removeDocsForNote(index, notePath)` (`indexer.js`) removes every doc whose
`notePath` matches — one for an ordinary note, every surviving anchor for a
channel-day one — and the sync loop in `shards.js` calls it immediately before
re-indexing a note that came back stale, for **every** note, not only
channel-day ones (a no-op for an ordinary note, which only ever has one doc
under its own key anyway). That is what makes an edit that removes a message
from a day's messages disappear from the index rather than survive under an
anchor the fresh set no longer produces: `addDoc`'s own "replace this key"
check only ever sees the keys the fresh render still has, so without this an
old anchor's postings would live forever, unreachable by any real link. The
diff surface (`docsByShard`, in `docVersionsOf`) is keyed by **note path, not
by doc key**, for the same reason — a channel-day note's several sub-documents
share one entry in the diff, since they were all fetched, and are all stale,
together.

## What a search result carries for a hit, and the deep link

A sub-document's hit carries the containing note's path and the anchor
together, as `<notePath>#<anchor>` in the same `key` field an ordinary note's
path already occupies — the shape `packages/communications`' own wikilinks
already use (`[[path#anchor]]`), so nothing downstream needs a new field to
open one. The snippet is cut from **that message alone**, read fresh off a
current copy of the note (`commsIndex.js`'s `messageSegmentFor`, never from
index data — the existing rule for every note's snippet) — never from the
whole file, and never from the capped text stored in the index. A hit whose
anchor no longer exists in a freshly-read note (the day was regenerated
between the index write and this read) is dropped exactly as a hit whose note
has gone entirely is: an honest miss on one hit, never a fabricated snippet.

## Encrypted notes teach the index nothing, and a file with no messages is still one document

A channel-day note that is encrypted (`encryption.js`'s marker) has no
`### … {#msg-…}` heading in its stored bytes at all — its body is frontmatter
plus an opaque blob — so it produces **zero message sub-documents**, the same
"the index learns nothing" property an ordinary encrypted note already has.
And exactly as for an ordinary note, the belt-and-braces check at snippet time
still applies: `answerFromIndex` in `visible.js` checks `isEncryptedNote` on
the freshly-read note before attempting to extract a message segment from it
at all, so even a hit that somehow ranked (by a path or title term) is dropped
before a segment is ever cut from ciphertext. A day encrypted *after* it was
indexed loses its sub-documents at the next pass, because the sync replaces a
note's documents through `removeDocsForNote` before writing the fresh set.

**`subDocumentsFor` never answers the empty list**, and that is a rule rather
than a detail. A channel-day path holding no message headings — an encrypted
day, a note somebody typed by hand at `0-inbox/imessage/2026-09-07.md`, a
render this scanner cannot follow — falls back to the single whole-note
document it contributed before this feature existed. Answering `[]` was
measured in review and costs two things:

- **The diff never converges.** `docsByShard` records a note's version by
  `doc.notePath` (below), so a note with no documents has no version
  recorded, is stale on every later listing, and is re-fetched and re-written
  on every pass — measured as one note read plus a shard, manifest and docmap
  write per pass, permanently, with `touched` naming that note every time and
  `pending` reporting 0 throughout. A pass that moved something is also what
  keeps the control plane's projection chain alive
  (`docs/decisions/search.md`, "A chain that cannot terminate is worse than
  no trigger at all"), so one such file bills a bucket listing per link.
- **The note goes unsearchable**, which for a hand-written note at such a
  path is a silent loss of a note that indexed fine the day before.

## A message deep link is a key the read tools accept

A hit's key is `<notePath>#<anchor>`, and that is the string an agent's next
call arrives with: `search_notes` prints it, and the ChatGPT dialect's whole
contract is `search` then `fetch(id)`. So `read_note` and `fetch` split a
**trailing, well-formed** message anchor off before resolving
(`splitMessageAnchor`), and read the containing note — the unit `canSee`
decides and the unit a share link covers. The console does the same thing at
its own edge in `noteFromQuery`. A `#` anywhere else is an ordinary character
in an ordinary key and is left alone, so a note whose name really ends in one
still resolves to itself. This closes the round trip rather than widening
anything: the path that is read is the path visibility was decided on, which
is the same path `rankedVisibleTo` filtered on.

## What is deliberately not built here

Filtering a query BY `comms.channel`/`date`/`threadId`/`participants` — they
are carried on the doc entry as the decision asks, and stored through both
serialization dialects, but nothing in `query.js`/`shardQuery.js` narrows a
query by them yet. Wiring a filter argument through the scorer is a
query-surface change with its own argument, not a free rider on the storage
format landing here.

