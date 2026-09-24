# Search — index sizing and sharding

### A note is the unit of the index, except when it is bundled mail

The R2 shard index's whole-note cap (`NOTE_INDEX_CHAR_CAP`, above) makes a
bundled channel-day note unsearchable past its first two or three messages —
argued in full and built in `docs/decisions/communications.md`, "Search must
index messages, and today's index cannot". The rule that belongs here rather
than there, because it is a rule about *this* index's own visibility
machinery and not about the communications format: **a channel-day note's
messages become several documents in the index — `<notePath>#<anchor>` — and
every one of them is a document about that one note as far as `canSee` is
concerned.**

The consequence a tidy-up would get wrong is the same one `visibleIndex` and
`collectShardCandidates` already exist to get right for the index as a whole,
one level down: `isVisible` is applied to `doc.notePath`, **never** to a
document's own key, at both places a doc's visibility is decided
(`shardQuery.js`'s collector, and `rankedVisibleTo`'s second, independent
check in `query.js`). A sub-document's key is not a path `canSee` was ever
asked about, and checking it directly is not merely a different way of asking
the same question — a `privacy.md` rule that names a note exactly (an
*exact-note* override, not a folder default) would never match
`notePath#anchor`, so a note somebody explicitly marked private would leak
every message inside it to exactly the query shape that should have found
none. That is why the test for this (`commsSearchIndex.test.mjs`) uses an
exact-path predicate rather than a folder prefix: a prefix check cannot tell
the two apart, since a `#anchor` suffix never changes whether a string starts
with a folder path, and a guard a folder-prefix test cannot fail is a guard
nobody has checked (`docs/decisions/testing.md`).

**Both guards are now driven one at a time, because two correct guards hide
each other.** The end-to-end check cannot tell a working guard from an
unnecessary one: with the collector filtering, `rankedVisibleTo` has nothing
left to remove. So `commsSearchIndex.test.mjs` runs the collector followed
straight by `scoreCollected` with no ranked filter at all, and then
`rankedVisibleTo` over a collection gathered with `isVisible = () => true` —
and asserts, in the middle, that the private day *is* in the unfiltered list,
so the fixture is known to be able to show a leak. Measured: pointing
`rankedVisibleTo` back at `entry.path` reddened 2 checks before that section
existed and 7 after, and the 2 it reddened were both "the answer went empty",
which is the guard failing in the direction nobody is harmed by.

**And a document count is not a note count, which is where the existence
oracle would have been.** A private day of forty messages that all match is
forty sub-documents; a team caller's `matchCount` is computed from the
*visible* list, so it stays 1 — asserted by comparing the whole
caller-visible answer, and the number of objects the answer read, against the
same query over a bucket where the private day does not exist at all. Equal
reads is the deterministic form of "no timing tell".

The format itself — the doc-entry fields, the placement rule, the
regeneration rule, the no-message fallback and the deep link the read tools
accept — is pinned in `apps/mcp/src/search/CONTRACT.md`, "Channel-day notes:
one sub-document per message", the way every other shape in this file is
pinned there rather than argued twice. **The sizing was not part of that
format and did not fit a mailbox**: `chooseShardCount` counted the notes a
listing found, and a heavy mailbox's sub-documents therefore all landed in the
shard its one note hashed to. That is the defect the next section is about.

### The index is sized by the volume it has to hold, and an oversized part sheds rather than taking the rest with it

`chooseShardCount` sized the index from the **note** count in the listing. One
listed object contributing one document per message broke that in a way
counting objects cannot see, and the failure was total rather than local:
measured on a 90-day mailbox at 200 messages a day beside 200 ordinary notes —
290 notes, 18,200 sub-documents, 27.2 MB of Markdown — the whole context lost
search.

| | before | after |
| --- | --- | --- |
| documents in the index | **0** (18,200 built) | 18,200 |
| shards | 1 | 56 |
| shard objects written | **0** (0.00 MB) | 56 (80.84 MB, biggest 1.76 MB) |
| passes | 40, still `pending: 290` | 1, converged |
| a search for a term in the mail | `indexed: false` | 1 hit |
| a search for a term in the **ordinary notes** | `indexed: false` | 10 hits |

Re-measure it with `node apps/mcp/test/bench/shardSizing.mjs`; the mechanism is
pinned at suite speed in `commsSearchIndex.test.mjs` (`runShardSizingChecks`)
with `shardByteCap` standing in for the corpus, and that injection scales the
sizing target and the placement ceiling with the write cap so a small shard
drives the whole rule rather than half of it.

**The threshold before the fix was four messages a day.** At 90 days the single
shard held 560 sub-documents in 1.67 MB at 4 a day and passed the 2 MB cap at
5. (Review's own number for the same shape was 10 fine / 20 dead; the fixture
here is stricter and it is worth saying why, because it is the same reason the
sizing has to count bytes: a shard's serialized body is mostly its **postings**,
one per distinct term per document, so a corpus written in seven repeated words
measures four times smaller than one written in real prose. The bench draws
~200 tokens a message from a 20,000-word vocabulary.)

Three parts, and each answers something the one before it cannot:

- **The count follows the volume.** `indexVolumeOf(path, size)` reads the
  listing's own `size` — R2, S3 and Dropbox all report one, so this costs no
  store op — and answers what that note can take up in the index: at most one
  `NOTE_INDEX_CHAR_CAP` window for an ordinary note however large the file is,
  and `1.25 x` its bytes for a bundled one, whose documents are a set. The
  target is `NOTES_PER_SHARD * NOTE_INDEX_CHAR_CAP`, which is the note rule's
  own number written the other way round, so **over ordinary notes the volume
  term can never win and no existing index is re-sharded by this.** The 1.25 is
  measured, not chosen: the mailbox above serializes to 2.97 bytes of index per
  byte of note against ~2.4 per indexed character for ordinary notes.
- **The count may grow after the manifest is created**, which it never could
  before. Growth is in place and moves nothing: the sync already routes a doc
  to the shard the manifest *claims* for it before consulting the hash, so a
  workspace converged for a year that then connects a mailbox goes from one shard
  to fifty without re-fetching a note and without its search going dark. Down
  is still "delete the manifest", for the reason it always was — down is the
  direction that re-routes docs already placed.
- **Growth made the manifest and the docmap able to disagree, which they never
  could before**, and self-review found it rather than a test. The manifest is
  written first and the docmap only if an op is left for it, so a pass that
  grew the count can store a manifest naming N+k shards over a docmap naming N.
  `parseDocmap` refused that mismatch — correct while the count was fixed, and
  badly wrong once it moves: refusing empties the diff, so every note looks
  stale, every shard is rebuilt from empty, and an index that was answering
  goes dark for as many passes as the backfill needs. A **shorter** docmap is
  now padded with empty maps instead, which is exactly right rather than merely
  cheap — growth moves nothing, so its claims are all still true and the shards
  it does not name are the new ones, which hold nothing. A **longer** one is
  still refused; that is a shrunk manifest or a rolled-back deployment.
- **A bundled note is placed by load, not by hash.** Sizing spreads a corpus
  evenly *on average*; hashing places it with the variance of a hash, and a
  channel-day note is indivisible, so three heavy days landing in one shard is
  past the cap however well the index was sized. Counting volume and then
  throwing dice with it would have fixed the arithmetic and kept the failure.
  So a bundled note goes to the least loaded shard that can still take it, and
  where none can, the index grows by one so that there is one. Ordinary notes
  are hashed exactly as before.

**And a shard that still will not fit sheds rather than refusing its write,
because the alternative was one note's size costing every note beside it.**
Refusing an over-cap shard is right in isolation — storing an object this
module refuses to read is a rebuild loop — but the shard is shared, so the
reported failure was `pending`, which reads as "still catching up" rather than
"this will never fit", over a context whose ordinary notes had done nothing
wrong. The note contributing most to the body now gives up documents until the
body fits, largest note first. What that costs is stated rather than hidden:

- A shed note is **reduced, never dropped**. It keeps one document, blanked if
  that is all that is left, so `docsByShard` still records the version it was
  indexed at and the diff converges — removing it would make it stale on every
  later listing and re-fetched forever, which is the non-convergence
  `subDocumentsFor`'s own never-empty fallback exists to avoid, on the
  customer's budget.
- **So one note quietly answers less.** That is worse than nothing and much
  better than every note in the shard answering nothing, permanently, while
  `pending` invited more passes that could never land.
- **The loss is recorded rather than inferred.** The surviving docs carry
  `shed`, `stats[id].shed` carries the count per shard, the sync answers
  `shed: string[]` and `oversizedShards`, and the search trace carries the
  total. It is `pending`'s opposite and must never be folded into it: `pending`
  asks for another pass, this says another pass finds the same wall. Like every
  other whole-index count here it is **operator-facing only** — a total over a
  bucket including its private notes is exactly the subtraction the census is
  owner-only to prevent.

**The capacity this leaves, measured, and it is a real ceiling rather than a
theoretical one.** `MAX_SHARD_COUNT x SHARD_PARSE_BYTE_CAP` is 128 MB of index,
which at the ~4.4 KB of index a message costs is around 26,000 messages; and
because a note is atomic, the *packing* bites first — a shard takes
`floor(SHARD_VOLUME_CAP / noteVolume)` days, so a day just over half a shard
wastes the other half. At 90 days the measured cliff is between **230 messages
a day** (20,900 messages, 31.2 MB of mail, 64 shards, biggest 1.99 MB against
the 2 MB cap, nothing shed) and **240** (26 of the 90 days shed to one document
each). Past it nothing else breaks: at 365 days x 200 — 110 MB of mail, three
times what the index can hold — all 64 shards are still written, the ordinary
notes still answer, and 237 of the 365 days are reduced.

Two things about that ceiling are worth writing down rather than discovering
later. **`MAX_SHARD_COUNT` is not free to raise**: a routing filter is up to
`FILTER_MAX_BYTES` per shard, and 64 of them already spend ~1.6 MB of the
manifest's own 4 MB cap, so the manifest runs out at roughly 120. And **which
days survive is arbitrary** — a function of their byte sizes, not their dates —
so a mailbox past capacity loses recall on days nobody chose. Neither is fixed
here. The fix for both is the same one and it is a change with its own
argument: **let one bundled note's sub-documents span shards**, which is the
atomicity assumption everything above is built on, and which the docmap's
one-shard-per-note diff would have to learn first.

The numbers as they gate connecting a mailbox are in
`docs/decisions/communications.md`.

### A shed index must say so to the caller it happened to, not only to the operator

The section above shipped the sizing fix and, in its own words, left one thing
"known and recorded" rather than closed: **the capacity past which a mailbox
loses per-message recall was not visible to the person it happens to.**
`syncShardedIndex`'s `shed` and `oversizedShards` were read by no caller in
`apps/mcp/src/`, the control plane's `indexMaintained` reply did not carry
them, `orient` said nothing, and the only surface was `index.shed` in one
trace line per search — operator-only, and correctly so, since it is a total
over the whole bucket, private notes included. Worst: `indexIncomplete`, whose
whole job is "tell somebody the index is still catching up", stayed `false`
while a shed day answered zero hits for a term that was in the mail. A search
confidently answering "nothing" about mail that exists is the same failure
family as a level meter that always reads zero: an instrument that says the
same thing whether or not the thing it measures is true.

**`indexIncomplete` keeps its existing meaning, and a second, separate signal
carries this one — folding them was considered and rejected.** The prior
section already drew this line for the *operator* fields — "`shed` /
`oversizedShards` … are the opposite of `pending`: `pending` says run another
pass, these say the corpus does not fit the index it has" — and printing the
shed banner as the same words `indexIncomplete` prints would make that same
mistake in front of a person instead of an operator. `indexIncomplete` means
"an honest pass would find more, so ask again"; a shed note does not resolve
that way — the same day is reduced on every future pass until the note itself
shrinks or the index gets more shards, neither of which searching again can
do. Telling somebody to search again for a fix that is not coming is a
**specific** false promise, worse than the generic silence it replaces. So:

- **`reducedRecallNotes: string[]`** is the caller's own visible share of
  every note the index currently holds only part of — one path per note, in
  the note's own path (a channel-day note's path already names the channel
  and the day, e.g. `0-inbox/email/name-at-example-com/2026-09-07.md`), never
  a count. **`reducedRecall`** is whether that list is non-empty.
- It is read off the manifest's own durable memory of shedding
  (`shedNotePathsOf`, backed by a new `stats[id].shedPaths` beside the
  existing `stats[id].shed` count — the identities behind the number,
  written and parsed exactly as sparsely and as strictly as `shed` itself),
  **never off which shards this one query's routing happened to open.** That
  is load-bearing rather than a style choice: the review's exact failure is a
  shard whose Bloom filter correctly finds nothing for a term that WAS in a
  message the shard had to give up, because the filter is rebuilt from the
  shard as shed and no longer claims a term that is really gone — so a flag
  gated on "did this query's routing open the shed shard" would stay silent
  in precisely the case it exists for. Reading it off the manifest costs
  nothing extra: it is the one GET a query already pays for.
- It is filtered through the caller's own `isVisible` before it is computed,
  the same line every hit, snippet and count already crosses — `manifest`
  itself carries every shed note including private ones, exactly the way
  `manifest.filters` already does, and nothing raw leaves this function.
  Proved both ways: a team caller reads their own shed note's path and never
  a private one shed in the same pass (`consoleSearch.test.ts`,
  `orientation.test.mjs`).
- **It answers a scoped claim, not "this mail is gone".** A shed note is
  reduced to one surviving document, not deleted — `read_note` still returns
  it whole — so the wording a person reads
  (`toolSearchNotes` in `apps/mcp/src/index.js`) says exactly that: *"these
  notes hold more messages than the search index can keep in full, so a term
  that appeared only in a message it had to drop will not surface here even
  though the note itself still exists and read_note always returns it
  whole."* Naming the note is what makes it actionable — a bare count would
  tell somebody to distrust an answer without saying which part of it.
- **Named to a limit, then counted — because a shed mailbox sheds by the
  day.** The list is one path per note, so "a few paths" is the small case and
  hundreds is the one that actually happens. Unbounded it was measured at
  ~23,000 characters: a one-hit `search_notes` answer whose warning was longer
  than every hit in it, and an `orient` eight times its usual size with the
  owner's own save procedure pushed below 400 lines of mail paths. A notice
  nobody can read past is the same defect as the silence it replaces, pointing
  the other way, and `orient` already collapses automatic captures for exactly
  this reason ("so they cannot crowd out a note the user actually touched").
  So the *rendered* list stops at `RENDERED_RECALL_NOTE_LIMIT` and reports the
  remainder as `(+N more)` — counted after `isVisible`, so the number is a
  count of the caller's own notes and never a hint at somebody else's, and
  never silently truncated. `reducedRecallNotes` itself is not capped: a
  programmatic caller (the console) still receives the whole list.
- **It reaches every surface that answers a question about search, not only
  the one that returns hits.** `search_notes` carries it beside
  `indexIncomplete`; `orient` — which read nothing about the index before
  this — now reads the manifest once (a cost it did not pay before) and
  prints a `## Search coverage` section naming the caller's own affected
  notes, so an agent that never calls `search_notes` still learns this before
  it needs to; the control plane's `searchResultsValidator` carries
  `reducedRecall` / `reducedRecallNotes` the same way it already carries
  `indexIncomplete`, for the console. `indexMaintainedValidator` — read by
  nobody with a per-note view — gets `shed` and `oversizedShards` as plain
  scalars instead, the operator's own numbers in the same no-path-no-term
  shape `pending` already has, so a fix at this boundary does not mean adding
  a second existence-oracle surface at the one reply that is scope-blind by
  construction.
- **The D1 fast-search projection reports `reducedRecall: false`
  unconditionally, and correctly**: a chunk row per message has no shard byte
  cap for a mailbox to cross, so shedding is a fact about the R2 shard index
  alone, argued in `search/visible.js`'s module doc and proved by a test that
  marks a manifest shed and then asks the fast path anyway.

**What this does not do, on purpose.** `MAX_SHARD_COUNT` is unchanged and the
sizing formula is unchanged — this is about telling the truth about a
capacity limit, not about raising it or hiding it behind a bigger number. The
"let a bundled note's sub-documents span shards" fix named at the end of the
previous section is still not built; when it is, this signal is what stops
being true rather than what has to change to say so.

Tests: `apps/mcp/test/commsSearchIndex.test.mjs` (`runShardSizingChecks`)
drives the crux case directly — a shed note's own term returns zero hits with
`indexIncomplete: false` and `reducedRecall: true` naming it, on the same
answer — plus the `isVisible` filter proved with a real scoped predicate
(every other check in that file passes `() => true`, which cannot catch a
dropped filter) and a rebuild-from-files round trip. `apps/mcp/test/
searchIntegration.test.mjs` proves the *rendered* tool text, not only the
object underneath it. `apps/mcp/test/orientation.test.mjs` proves `orient`'s
own privacy split. `apps/convex/__tests__/consoleSearch.test.ts` proves the
plumbing through `searchNotes` and `maintainSearchIndex`, including a real
shed produced through a test-only `shardByteCap` injection (the same pattern
`syncShardedIndex` itself already documents) rather than a stubbed number.
Nine sabotages, each caught: dropping the `isVisible` filter in the shared
query path (1 failure) and in `orient`'s own copy of it (1); folding
`reducedRecall` into `indexIncomplete` (1); dropping `shedPaths` from the
in-memory shard stats (3), from `parseManifest` (7) and from
`serializeManifest` (7); hardcoding the control plane's `shed`/
`oversizedShards` to zero (1); removing the rendered banner from
`toolSearchNotes` (1); and claiming `reducedRecall` from the D1 fast path (1).
