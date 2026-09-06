# Search and the derived index

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Search answers from a derived index, and the index is budgeted, filtered, and disposable

The brute-force scan behind `search_notes` fetched every candidate note per
query, and Cloudflare allows 50 subrequests per Worker invocation — so a real
context, measured live at 154 notes, answered every unprefixed search with
"Too many subrequests". Search now answers from an inverted index with BM25F
ranking, in the customer's own bucket, synced by etag diff under one shared
subrequest budget — **behind the response, never in front of it**; the three
sections after this one are about that. The format, scoring constants, and
maintenance loop are pinned in `apps/mcp/src/search/CONTRACT.md`; what belongs
here is what a tidy-up would break:

- **It is a disposable derivative, and every consequence of that is
  deliberate.** Rebuildable from the notes, never audited, never the only copy
  of anything, and never gating
  correctness: an unusable index degrades to a bounded literal scan, and both
  paths spend from the same budget — the recovery route re-creating the very
  subrequest failure it exists to survive is the regression the wide-bucket
  test pins.
- **The index holds text drawn from private notes, and `canSee` is applied to
  everything that leaves the gateway** — paths, snippets (cut from a fresh
  read, never from index data), and counts. A reported total is computed from
  the *visible* list: "14 matches" over four visible results is an existence
  oracle, the same subtraction the console's census is owner-only to prevent.
  For the same reason no vocabulary-derived "did you mean" may ever be added,
  and `pending` is never printed as a number.
- **Every count is a floor when any walk was cut short**, in the census's own
  language, and a future-dated `uploaded` timestamp is clamped — unclamped,
  `e^(+age/90)` is an unbounded score multiplier one crafted `LastModified`
  away.
- **One search path.** `search_notes`, the ChatGPT-dialect `search` and the
  console share `searchIndexedNotes` the way the first two shared the scan
  before it; a second path is a second place for a visibility bug.
- **The index is sharded (v2) because the single object hit a real ceiling.**
  A brain in the mid-thousands of notes built a capped index that could never
  be parsed within the Worker's 128MB, so coverage plateaued forever —
  measured live. `.index/v2/` holds a manifest plus fnv1a32-sharded objects,
  each under its own parse cap; the query streams shards one at a time and
  computes every statistic over the caller's visible docs, and PageRank is
  deliberately neutral (a global link graph needs every shard in memory,
  which is the blowup v2 removes). CONTRACT.md § v2 pins the format.
  **Shard postings are interned — `[docIndex, tf]` against the shard's own
  docs array, never `[path, tf]`** — because path-keyed postings repeat every
  doc's path once per unique term, which crossed the shard byte cap at about
  half the 300-doc target and plateaued the live brain permanently: each pass
  rebuilt the same oversized shard and had its write (correctly) refused.
  Un-interning is the tidy-up that re-breaks this; readers still accept the
  old path-keyed dialect so a working index is not rebuilt for no gain.
- **The size cap has two sides and one number, and dropping either is a loop
  rather than a smaller cap.** `INDEX_PARSE_BYTE_CAP` refuses a stored index
  past it *and* refuses to write one past it. For a while only the read had a
  check, so the sync stored objects it already knew it would reject, rebuilt
  from empty on the next pass and never converged — measured, a *converged*
  index was written at 12.37MB and discarded unread. Refusing the write makes
  coverage plateau instead: the last object small enough to read survives,
  `pending` keeps saying what is missing, and the query in hand is answered
  from memory either way. The comparison is in **UTF-8 bytes**, because that is
  what the read compares; counted in UTF-16 code units a CJK index goes through
  at up to three times the cap. `exceedsUtf8Bytes` is a hand-written second
  copy of one line of `TextEncoder` — it exists so enforcing a memory ceiling
  does not allocate a second copy of the body to do it — and it is held the way
  two copies of a rule are always held here, by running both against a corpus.

### A search reads a ready index, and never builds one

Measured live on 2026-08-31 against a 7,961-note context: searches took **20 to
60 seconds**, and one returned nothing for a note that was certainly there. The
console's palette showed the same thing from the other side — twenty-odd
seconds of spinner, then "that search could not be run", because one of the
hundreds of round trips it was making hit the Convex action's ten-second fetch
deadline.

One cause under both: **every search ran the index maintenance first.** A full
listing of the customer's bucket, an etag diff, and as many note reads as the
budget allowed, all in front of the answer. The subrequest budget bounded what a
search could *spend*; nothing bounded what a person *waited for*, and on the
deployment's budget of 600 those differ by two orders of magnitude.

So the two are separated, and the separation is the rule rather than a tuning:

- **`searchIndexedNotes` reads the manifest, opens shards, cuts snippets, and
  returns.** No listing, no diff, no write, no note read that is not being
  quoted.
- **Maintenance runs behind the response.** `ctx.waitUntil` in the gateway; a
  scheduled `maintainIndex` operation in the control plane, which chains itself
  while it is making progress so a cold brain converges without anybody
  searching eight times to finish their own backfill. A host with no `waitUntil`
  runs the pass **inline and awaited**, capped — deferral is an accelerator, and
  a promise left running on a host with nothing keeping the invocation alive is
  an index nothing ever builds.
- **The manifest records its own freshness** (`listedAt`, `pending`,
  `truncated`), because every honest thing an answer says about its own
  completeness used to be a by-product of the listing it did on the way in.
  `listedAt: null` counts as behind: an unknown reported as complete is the one
  direction that tells somebody their note is not written down.

**The one exception is a miss, and it is the narrowest one available: a miss may
pay for a listing, a hit never does.** An answer is only as fresh as the last
pass, and this bucket is also written by Obsidian and rclone — fine for an
answer with hits in it, not fine for an empty one, which is the answer an agent
acts on by concluding the thing was never written down. So an empty answer over
an index whose freshness says it is *converged* runs one pass and asks again.
Not over an index that already knows it is behind: that answer is honestly
qualified everywhere, one more capped pass out of a dozen would not change it,
and the cost would land on the buckets least able to afford it. The re-ask is
skipped when the pass moved no document, and preferred only when it has hits —
a refresh must never turn an answer into a miss.

### …and it opens the shards that can answer it, not all of them

v2 partitions by document, so a term can be in any shard and the walk read every
one: 27 objects and 5.2MB on a 7,961-note fixture to return a single hit. Each
shard carries a **Bloom filter over its own vocabulary** in the manifest, and a
shard whose filter holds none of the query's terms is not opened.

The asymmetry is the whole design. A Bloom filter has false positives and no
false negatives, so every way this can be wrong costs one shard read, and no way
it can be wrong costs a hit. Four things hold that, and each fails a test:

- **Absence always means "read the shard".** No filter, an unreadable filter, a
  shard no pass has been over — reading any of those as "no terms" is every
  search on every index that predates this answering nothing.
- **The filter is rebuilt in the same step that records the shard's documents**,
  from the shard that was just written. A filter describing an older shard than
  the object a query opens is the one way to make it wrong in the fatal
  direction.
- **A term no shard claims has provably no exact match**, so the shards read for
  it are read for expansion vocabulary alone — and that is a *sample*, in the
  same spirit as `SHARD_FUZZY_RETAIN`: an expansion the sample missed costs a
  suggestion, never a hit.
- **The corpus statistics are computed over the shards that were opened.** `N`,
  `avglen` and every `df` move together, so this changes scores rather than
  results; what has not changed is whose corpus, which is still the caller's
  visible docs.

The bug this shipped with is worth keeping, because it is the file's own rule
about guards: the second hash was `fnv1a32(x) | 1`, a **signed** bitwise
operation, so any hash with its top bit set went negative, `%` kept the sign,
and the bit positions ran off the front of the array — a silent no-op on write
and a zero bit on read, which is a false negative. A filter over four terms
answered "no" to three of them, and the whole suite was green because nothing
had yet asked a filter about a term it had been given.

Measured on the 7,961-note fixture at 60ms per store operation:

| | before | after |
| --- | --- | --- |
| warm, a one-note term | 49 ops · 5.21MB · 1,357ms | 3 ops · 0.19MB · 188ms |
| warm, a term every note carries | 58 ops · 5.22MB · 1,471ms | 38 ops · 4.92MB · 752ms |
| cold, the answer | 590 ops · 3,926ms | 1 op · 61ms |

`apps/mcp/src/search/CONTRACT.md` pins the format and the constants;
`test/searchFilter.test.mjs` carries the sabotage record.

### The manifest is the query surface, and the diff moved out from under it

The manifest carried a `[path, version]` pair per note — ~900KB at eight
thousand notes — and every search downloaded all of it to learn a shard count.
That surface is `.index/v2/docmap.json` now, read by maintenance and by nothing
else, and what took its place is the two things a query genuinely cannot ask a
listing for: the routing filters and the freshness record.

Three consequences that a tidy-up would get wrong:

- **The docmap is written after the manifest**, never before. A docmap *ahead*
  of the manifest tells the next pass a note is already indexed while the
  manifest's stats and filter still describe the shard before it: the note is
  never re-indexed, the filter never learns its terms, and the query that would
  have found it skips its shard, permanently. A docmap *behind* costs a
  re-fetch. Slow and self-correcting is the direction every unknown here falls.
- **`MANIFEST_WRITE_RESERVE` is two ops**, because the commit is two objects. At
  one, every pass spent its last op on the manifest and had none left for the
  diff, so the next pass re-diffed against an empty map — measured on 1,500
  notes at a budget of 600, 591 documents indexed on pass one and 591 on pass
  eight, `pending` stuck at 909 forever. The shards were written; nothing
  remembered that they had been.
- **A rollback rebuilds.** A gateway that only reads version 2 finds no
  `docsByShard` and refuses the manifest like any other invalid shape. That is
  what a disposable derivative is for, and it is cheaper than the alternative:
  writing the diff into both objects is one list authored twice, and the
  direction it fails is two copies disagreeing about what a shard holds.

### The console searches through the gateway's search, not a copy of it

The console's palette filtered the folders somebody had happened to expand, and
said so: "only folders you have opened are searched". That is a file picker. The
question search exists for — "where did I write about this person" — is asked
precisely about the folders nobody has opened, so the honest message did not
make the answer less wrong.

It answers from the index, and the load-bearing part is *whose* code runs.
`searchIndexedNotes` lives in `src/search/visible.js` so that `search_notes`,
the ChatGPT-dialect `search` and the console are three callers of one function
rather than three implementations. "One search path" was already the rule for
the first two, because a second path is a second place for a visibility bug; a
console with its own scorer would have been that second place, with a person's
whole bucket behind it.

**Privacy is injected rather than imported, and that is not a loophole.**
`isVisible` and `isIndexable` are parameters because the two callers hold the
privacy engine in two runtimes — the gateway's copy is module-private in
`index.js`, the control plane's is `functions/lib/privacy.ts` — and
`__tests__/privacyEngine.test.ts` already runs both over a matrix of manifests,
keys and scopes asserting identical output, rejections included. So the
parameter composes two proven-equal implementations; it does not invent a
third. What it must never become is a caller passing a predicate for a
different scope than the one it serves: sabotage `isVisible` to `() => true` on
either side and the suites fail, which is the guard.

**A console search maintained the index and no longer does, and the reasoning
that put it there is the reasoning to not restore.** It passed a budget of 300
and no backfill cap, deliberately — "a Convex action has no subrequest ceiling,
and a cold bucket there should be finished rather than nibbled at" — on the
premise that nobody was watching. Somebody was: the palette is the surface it
serves, and what that premise bought was twenty-odd seconds of spinner and then
"that search could not be run", because the action's ten-second fetch deadline
fires somewhere inside three hundred sequential round trips.

So `searchContext` **schedules** `maintainIndex` after it answers, and only when
the answer says the index is missing or behind — scheduling propagates no taint,
and a converged bucket must not pay a full listing per search to discover there
was nothing to do. The chain lives inside `runFileOperation` rather than in a
job of its own, because a second internal action opening a bucket credential is
a second entry in `CREDENTIAL_BARRIERS`, and that set holding one member with a
long warning attached is the point of it.

There is still no literal-scan fallback: `indexed: false` comes back as
`indexMissing`, and the console says the context is still being indexed while
its own filename filter keeps working. **Collapsing that into "no matches" is
the bug this whole feature exists to remove** — a console that reports absence
for a bucket nothing has read yet is worse than the message it replaced, and the
palette carries the same rule for a search that is still running or that failed.

### A database we own holds a copy of somebody's notes only where they asked

The R2 index is a derived copy of a context's notes **inside that context's own
bucket** — beside the notes it derives from, under the customer's own
credential, deleted when they delete the bucket. `search/CONTRACT.md` says the
quiet part: "the index contains text drawn from private notes. That is
acceptable where it lives — inside the customer's own bucket."

A D1 projection is the same text somewhere else: a database Supa Media owns,
that the customer cannot see, revoke, or delete. Everything about it is
defensible — canonical Markdown never moves, the projection is disposable, the
performance is the difference between search working and not — and none of that
makes it a decision we get to make for them.

So it is **two independent conditions, and both must hold**:

- **Entitled** — may this context turn it on? Derived, never stored, true for
  everyone today. This is the single function a paid tier later narrows, and it
  exists now so that narrowing is one edit rather than a search for every place
  the question is asked.
- **Opted in** — has an *owner* turned it on? Stored, and **off by default**.

Folding them into one flag is the obvious simplification and it loses the
distinction that matters: "you are not paying for this" and "you have not asked
for this" need different copy, and one of them must never be answered by a
billing state. A customer who stops paying has not consented to anything being
deleted; a customer who opts out has.

Four consequences, each load-bearing rather than tidy:

- **Owner-only.** An editor may write every note in a context. Deciding where a
  copy of all of them is kept is a different authority, which is the whole
  reason membership carries an explicit role.
- **No row means never asked** — not a row saying `false`. "How many customers
  have we made a copy of" is then a count rather than a filter.
- **Provisioning happens at the toggle, never at signup.** A context that never
  opts in has no database: nothing to secure, nothing to bill, nothing to delete
  when the account closes. It also means Cloudflare's per-account database
  ceiling is a limit on opted-in contexts rather than on customers.
- **Off deletes it, and the row outlives the delete.** A switch that stops
  *reading* the copy and leaves it in place is the switch not working. `disable`
  marks the row `releasing` and schedules the delete rather than removing it,
  because a row deleted before its database is a database nothing can ever find
  — an orphaned copy of somebody's notes with nothing pointing at it, which is
  the exact outcome the opt-out exists to prevent, reached by tidying up. Search
  falls back to the R2 index the instant `optedIn` goes false, so the delete
  finishing is bookkeeping and not the switch.

**Off is a working state, not a degraded one.** Either condition false means the
R2 shard index serves the search exactly as it does today. That is what makes
off-by-default shippable: the fast path is an upgrade, and its absence is the
product as it already is.

The test that fails if this is reversed:
`__tests__/fastSearch.test.ts`. One sabotage in it measured zero on its first
run and is worth remembering — `fastSearchEntitled` is true for every workspace
kind that exists, so deleting the entitlement half of the composition was
invisible to the whole suite. It fails closed on an unrecognized kind, which is
both a real property and the only handle a test has on that half until a paid
tier arrives.

### The gateway writes the projection, so the credential rides on the binding

The switch above provisioned a database per opted-in context and **nothing put
anything in it** — three databases in production, schema applied, zero rows,
verified live. The projection had no owner, because of where note text can be
read: the control plane holds the encrypted storage credential and hands it
out, and never fetches a bucket object. Giving it the ability to run a backfill
would make it a second component reading customers' notes, for a job the
gateway is already positioned to do behind its own response.

So the gateway projects, and it needs two things from here: a database to write
into, and a token that may write into it. They arrive as an optional
`searchIndex` sibling on the `/gateway/binding` response — `{ databaseId,
accountId, apiToken, state }` — present only where a context has an opted-in,
provisioned index, and **absent is the normal case rather than an error**. The
key is missing rather than null, so a gateway on an older build reads the bytes
it always did.

- **A sibling, not a route.** `structure.test.ts`'s `CREDENTIAL_HTTP_ROUTES` has
  two entries and says a third needs its argument made again in that comment.
  Here it does not have to be made: the same two proofs are spent, and the
  workspace is resolved once — from the grant — for both halves of one answer.
  A second route would resolve it a second time, which is a second place for the
  selection to be wrong.
- **The two-factor property is inherited, and the sabotage measures the
  difference.** Keying the index lookup on the caller's own
  `expectedWorkspaceId` where it sits changes no behaviour, because the
  membership check has already returned `null` for every id the token does not
  cover; exactly one test reddens, the structural rule that the argument may
  never select. Hoist the same lookup above that check and it is the real thing
  — a compromised gateway reading any opted-in context's database id and the
  write token, one id at a time — and five tests redden. Which is why the
  cross-tenant test asserts on the **bytes of the whole response**: under that
  mutant the binding half is still a correct `null`, and everything that leaks
  leaks beside it.
- **One gate decides both.** `searchProjectionState` composes entitlement, the
  owner's opt-in, a recorded `databaseId` and a status meaning the schema is on
  it. The binding response and the progress route are its two callers; a second
  copy is a second place for them to disagree about what "on" means.

**The unresolved part, stated rather than buried.** `SEARCH_D1_API_TOKEN`
carries `D1:Edit` on the whole Cloudflare account, because that is what creating
and deleting databases needs and there is one token. Handed to the gateway it is
wider than the job — every opted-in context's database, not only the one the
response names. What bounds it today is that the gateway already holds, one
request at a time, the bucket credentials for the canonical notes those copies
derive from; what would remove it is a per-database token, which Cloudflare can
mint and which this control plane would then have to create, store, rotate and
revoke per context. That is a design decision with a real cost, not an
implementation detail to invent quietly. `SEARCH_D1_READ_TOKEN` — the `D1:Read`
half `lib/d1.ts` already names — is the other half of the same conversation.

### Progress is reported to the control plane, which owns the row

`POST /gateway/search-index/progress` takes `{ workspaceId, notesIndexed,
notesPending, state? }` behind the gateway secret alone. **Proof #2 is absent
and that is a decision**, the same one `/gateway/ingest/*` makes: a backfill
runs behind a response and outlives the request that started it, so there is no
user access token because there is nobody present.

The residual is bounded and worth writing down. A holder of the gateway secret
can write two integers onto a row it names, and move one that is already
backfilling to `ready`. It can read nothing, obtain no credential, and learn
nothing about which contexts exist or have opted in — **every input is answered
with the same bytes**, for the reason `/gateway/usage` gives about naming a
context in a request that cannot read one.

What makes that acceptable is that the gateway reports and does not decide. It
knows how many notes it wrote; it does not know whether the owner turned the
feature off while it was writing them. So:

- **A report for a context that is not opted in is refused**, through the same
  `searchProjectionState` that decided the credential could be handed over.
- **A `releasing` row is never resurrected.** Its counters stay empty and its
  status stays `releasing`. Writing counters onto it would be harmless; moving
  it to `ready` would put a database mid-delete back into service, so both are
  refused together rather than the interesting one alone.
- **`ready` is a transition from `backfilling`, never an assignment**, and a
  later report without it does not demote a finished index back to preparing.

### The backfill percentage is derived, and inherits the census's owner-only gate

`notesIndexed` and `notesPending` are owner-only because the index counts private
notes and a member reads only the `team` tier: a total including what they cannot
read tells them how much is withheld, and polled, tells them when a private note
was written. **A percentage is that total, divided.** It carries the same
information at a coarser resolution and moves for the same reasons; what is
different is that it looks like a progress bar rather than like a count, which is
exactly how a second field gets added without the gate the first one has. So
`percentIndexed` is gated identically, and the test asserts the owner half in the
same breath — a gate asserted alone passes just as well when the field is broken
for everyone.

Derived on every read, never stored, because the denominator moves in both
directions during a backfill and a stored ratio outlives the corpus it describes.

The field's name and its edge cases are a **rendering contract**, not an internal
choice: the console range-checks what arrives and otherwise draws it, treating an
absent field as "this viewer does not get this" and any number as a state. So
each edge below is a sentence somebody reads, and a client that re-derived any of
them would be a second implementation to disagree with.

- **Either counter absent → no figure.** The row can hold a numerator and no
  total: `provisionIndex` writes `notesIndexed: 0` with no `notesPending` at all,
  and `recordProvisionResult` can move one without the other. Reading an absent
  pending as zero turns `41 indexed, none pending` into a **finished backfill of
  41 notes**. An unknown reported as a number is the one direction that tells
  somebody their notes are written down when they are not — the rule
  `listedAt: null` already follows above.
- **A total of zero → no figure**, not `0` and not `100`. "0 of 0" is not a
  percentage of anything: `0` draws an accusing empty bar, `100` claims a
  backfill that never had work to do, and the console says "no notes to index" in
  words when the field is absent. Absent even once the index is `ready`.
- **100 belongs to `ready`.** Whether a backfill is finished is the `state` this
  control plane owns, never an inference from `notesPending === 0` — a pass can
  reach zero pending with a listing still to redo, and every count here is a
  floor whenever a walk was cut short, in the census's own language. A row that
  is not serving is capped at **99** however the arithmetic comes out, so a
  completed bar cannot appear beside a card that says the index is still being
  built.
- **Floor, not round**, so 9,999 of 10,000 reads 99 rather than "done". A total
  that shrinks mid-backfill needs no special case: numerator and denominator come
  from the same report, so deleted notes leave both smaller and the ratio simply
  moves up. That, plus a clamp on each counter, is why the answer is always a
  finite integer in 0–100 when present.

The tests that fail if any of this is reversed: `__tests__/controlPlane.test.ts`
(the two new `/gateway/binding` and progress sections, each carrying its own
sabotage record) and `__tests__/fastSearch.test.ts`.

### The switch lives in a context's settings, and the server owns who may throw it

`enable` and `disable` shipped before anything called them, which made the
opt-in a decision nobody could take: `npx convex run` is unauthenticated, so
the owner-only mutation had no caller at all and the feature was configured and
unreachable. The switch is now the `Search` section of
`/console/@:slug/settings`, beside storage and ingestion, which is one screen in
Expo Router's shared tree and therefore the same control on a phone and in a
browser rather than two that can drift.

Per context and not per account, for the reason the whole settings pane is per
context: two brains can be answered from two different places, and a switch
above the context picker would claim there is one setting for all of them.

Three rules the console follows and does not re-derive:

- **`canChange` is the server's answer.** `fastSearch.status` is readable by any
  member — how a context's search is served is not privileged — and it says
  whether *this* caller may change it. "How search is served" is `state` and
  `canChange` and stops there: the backfill counters are a census of the notes,
  the index counts private ones, and a member who cannot read a note must not
  read a total that includes it or watch that total move. They are owner-only,
  in the query rather than in the console. The console attaches the mutations only
  where it said yes, so a member sees the state and no switch rather than a
  button whose only outcome is `INSUFFICIENT_ROLE`.
- **An unanswered status is not `off`.** `status: null` is "not asked, or not
  answered yet" and draws no switch, the same three-valued treatment
  `ConsoleData.storage` needs for its binding; collapsing it to `off` would tell
  an owner their index is gone on every reload.
- **A state this build does not know closes the card down.** A newer control
  plane naming a fifth state falls to `unavailable` — an explanation and no
  control — never to `off`, which would offer to provision against a vocabulary
  we do not share, and never to `on`, which would claim a copy of somebody's
  notes exists.

Turning it **on** is one press and turning it **off** is two, which is the
reverse of the usual instinct and follows from what each costs: on is undone by
off, while off deletes an index that took a backfill to build. The armed state
says what the second press destroys and what survives it, at the moment of the
press.

The tests that fail if this is reversed:
`apps/mobile/__tests__/fastSearchSettings.test.ts` for the rules above and
`apps/mobile/__tests__/fastSearchCard.test.ts` for the presses. Sabotaged one at
a time: dropping `canChange` from the guard, falling back to `off` on an unknown
state, and making Off a single press were each caught.

### Corpus statistics are per tenant, which is why it is a database each

One D1 database per context, never a shared table with a tenant column, and the
reason is sharper than tidiness. FTS5's `bm25()` reads **corpus statistics** —
how many documents hold a term, how long the average one is — over the whole
table. In a shared table a term's rarity in one customer's notes would shift
another customer's result *ordering*, and no `WHERE` clause closes that: it is
the same inference channel `search/CONTRACT.md` argues about at length for the
R2 index, where `visibleIndex` narrows the corpus so that `N`, `df` and `avglen`
are computed over the caller's own view.

The same argument splits the tables *within* one database by visibility.
Querying `notes_team_fts` alone computes the statistics over exactly the
documents a team-tier caller may read; a single table with a `visibility` column
would let private notes reorder a team caller's results.

That split is for *statistics*, not for access. The visibility stored in the
projection is `privacy.md` as it was at index time and can go stale, so the live
`canSee` still filters every result before it leaves — exactly as it does for
the R2 index. The split buys correct ranking; the filter buys correctness.

### The gateway copies the notes, and a search is what starts it

The projection was provisioned and never filled: three databases held the whole
schema and `SELECT COUNT(*) FROM notes` returned 0, because
`apps/mcp/src/search/d1/project.js` had no importer anywhere. The card said
"your notes are being copied into it" and no code made that true.

**The copy lives in the gateway, and it had to.** The gateway is the only
component that ever reads note content: the control plane holds the encrypted
storage credential and hands it out per request, and `POST /gateway/binding`
returns it only against *two* proofs — the gateway secret **and** the end
user's own access token, with the workspace derived from the grant that token
resolves to rather than from anything the caller names. That is what makes bulk
extraction impossible by construction, and it is the property a "control plane
tells the gateway to go fill workspace X" route would spend: the gateway would
need a credential for a workspace nobody is connecting to, which is precisely
the call shape `controlPlane.js` refuses to have. So there is no push route,
and the reason is not that it would be awkward.

What copies, then, is the maintenance pass that already exists. The R2 shard
index is synced behind the response by `searchVisibleNotes`; the projection is
**the same event with a second destination**, taking the census, the notes that
moved and the notes that are gone from the diff that pass already computed. No
second listing, no second diff, no second answer to "what changed" — the same
objection this file makes to a second search path and a second maintenance
path. Four consequences are load-bearing:

- **The tier a note is projected at comes from the gateway's own privacy
  engine**, injected as a parameter exactly as `isVisible` is injected into
  `searchIndexedNotes`, so there is one `effectiveVisibility` and not two. A
  visibility the projection does not recognise is skipped rather than guessed:
  the safe guess and the useful guess differ, and the useful one publishes a
  private note's vocabulary into the corpus every member is scored against.
- **It runs on the search's own subrequest budget and behind the response.**
  Running out of budget is the ordinary end of a pass, not a failure — the
  cursor in D1's own `index_state` records where it stopped. A provider refusal
  is caught, the search still answers from the R2 index, and the code is
  reported to `POST /gateway/search-index/progress`. Silence there is the
  original bug: a projection that cannot reach its database leaves search
  working, so nothing else in the system would ever notice, and the workspace
  sits at "Preparing" forever.
- **A pass chains itself while it is making progress**, inside the one
  invocation `waitUntil` is keeping alive. One slice per search is arithmetic
  nobody would sign off on: a context that has just opted in would copy twenty
  notes and then wait for somebody to search again. Every link spends at least
  one operation and the chain stops the moment a pass moves nothing, so it
  cannot become the loop `DEFERRED_SYNC_FLOOR` warns about.
- **While the control plane says the projection is still filling, a pass runs
  on every search** — buying its census from `.index/v2/docmap.json` rather
  than from a listing. Tying it to the R2 sync alone starves it: an index that
  converges in one pass then needs none for `INDEX_RECONCILE_INTERVAL_MS`, so
  the backfill would advance once a minute at best and a failed pass would
  never be retried. Once the row says `ready`, the projection rides the R2 sync
  alone and a converged context pays nothing.

**What this does not do is start without a request.** A workspace whose owner
flips the switch and then closes the app has nothing copied until something
reaches the gateway for that context — which is a property of the two-proof
binding, not an oversight, and it is why the gateway cannot be the whole
answer. The other half is the section below.

### …and the control plane runs the same pass for a person who is not there

The gateway's half was the whole of it, and every trigger in it was a search.
So an owner who turned fast search on and closed the app copied nothing, ever:
three production contexts sat at "0 notes indexed / Preparing" with the schema
applied and `SELECT COUNT(*) FROM notes` returning zero, and there was no way
to reach them through the switch, because `enable` returns early for a row that
is already opted in and not failed. Pressing it again did nothing at all.

`projectSearchIndex` (`functions/lib/fileOps.ts`) is the gateway's own
`projectPass`, imported, over the store `runFileOperation` already opens —
the same arrangement `searchNotes` and `maintainSearchIndex` have with
`searchIndexedNotes` and `syncShardedIndex`. What is different is only what
the control plane's position forces:

- **The R2 index pass runs in front of the copy.** The projection's census is
  that index's own docmap, so a bucket nothing has ever searched has nothing to
  walk — which is exactly the state a context stuck at "Preparing" is in. The
  gateway can skip this because a search has usually just done it; here it is
  the difference between converging and never starting.
- **Every provider failure is returned, never thrown.** The caller is a
  scheduled job whose entire purpose is to record the outcome. A throw leaves
  the row saying `backfilling` with nothing to explain it, which is the bug
  rather than a way to report it. It lands as `failed` with our code and our
  sentence, which is a state the console already draws with "Try again" on it.
- **Progress is written by calling the internal mutations.** The gateway posts
  to `/gateway/search-index/progress` because it is across a network boundary;
  inside the control plane there is no hop to make, and reaching for the HTTP
  route would be authenticating to ourselves. The mutations are the same two,
  so the policy about what may be applied to a row is answered in one place
  whichever half reports.

**It runs inside `runFileOperation` rather than beside it**, for the reason
`CREDENTIAL_BARRIERS` has one member and a long warning attached: a second
internal action that opens a bucket credential is a second barrier. And inside
it, **the row is asked before the credential is opened** — a link can have been
queued minutes ago and an owner can have opted out since, and a pass that
decrypted a customer's storage secret on the way to discovering it had nothing
to do would be paying the highest-cost operation in the system for nothing.

**A chain that cannot terminate is worse than no trigger at all**, because each
link is a full bucket listing billed to the customer. Four things end it, and
each has a test:

- a pass that **moved nothing** — where "moved" includes a pass that only
  advanced the R2 index, because a cold brain's first link may have no budget
  left to copy with and stopping there would reintroduce the whole bug one
  layer up;
- a row that is **no longer `backfilling`**, `ready` included.
  `projectionTargetForWorkspace` answers `backfilling` and `ready` alike — its
  other caller hands the gateway a credential in both — so the narrowing lives
  at the pass, and what it prevents is a converged context paying a listing per
  link forever;
- a projection that **reached `ready`**;
- a **bound of 24 links**, which is the backstop for the case the other three
  miss rather than the thing that ends it.

**Two populations, two schedulers, and the second one is the point.**
`provisionIndex` schedules a chain after it records `backfilling`, which covers
every context enabled from now on. It does not cover a context that reached
`backfilling` before any of this existed, or one whose chain was lost to a
deploy or an eviction — so an hourly cron restarts every `backfilling` row
nothing has written to in fifteen minutes. `updatedAt` is the heartbeat: a
working chain writes counters on every link that moves anything, so it is never
overtaken, and a dead one looks stale. Reading the row rather than the
scheduler's own table is deliberate, because the case this exists for is a row
with nothing scheduled *and no record that anything ever was*.

It is the one cron here that starts work rather than deleting it, and it still
holds no decision: whether a context may have a projection is
`searchProjectionState`, re-asked by the pass itself, and whether there is
anything to copy is answered by the pass. The sweep decides only when to look.
It deliberately does not retry a `failed` row — a failure is a sentence
somebody is being shown, and "Try again" is theirs to press.

**The residual, stated rather than buried.** Two passes projecting the *same*
note at the same time — the gateway behind somebody's search while the
scheduled chain runs — can leave that note duplicate rows in its FTS table.
`upsertStatements` opens with three deletes and then inserts, D1's `/query`
runs one statement per request, and there is no transaction around the group.
What it costs is bounded and is not a disclosure: nothing crosses the
private/team split, `notes` is keyed by path so the census an owner reads
cannot double, and `d1/query.js` merges chunk hits per path ("a note is its
best chunk") so a search still returns the note once. What is lost is a slot of
the query's `LIMIT` and a little ranking, until that note is next projected.
Closing it properly means an atomic multi-statement batch, which is a change to
the gateway's D1 client and to the reasoning `lib/d1.ts` sets out for refusing
multi-statement requests — a decision with a real cost, not something to invent
quietly. The stall window on the sweep is what keeps this deployment from
causing the overlap on purpose.

The tests that fail if any of this is reversed: `__tests__/searchBackfill.test.ts`,
whose header carries the sabotage record — including the two mutants that
measured zero until the assertion that could see them was written.

### …and a search reads it, which for a year it did not

Every heading above describes the *write* half, and until 2026-09-06 that was
all there was. The gateway provisioned a D1 database per opted-in context,
copied every note into it, split the FTS tables by tier, reported progress, and
rendered a settings card saying so — and then answered every single search from
the R2 shard index, because nothing in `apps/mcp/src` imported
`search/d1/query.js`. It was written, tested against real SQLite, and called by
its own test file alone. **Fast search was a write path with no reader**, and
the thing an owner consented to — a copy of their private notes in a database
we run — bought them nothing at all.

`search/d1/serve.js` and `fastSearchAnswer` are the reader. Four decisions in
it, and each is load-bearing:

**The projection is asked first, and only when the control plane calls it
`ready`.** A projection that is still filling would answer a query about a note
it has not copied with silence, and silence here means "ask the R2 index" — so
a backfilling context would pay for a D1 query before every ordinary search and
get nothing back. `ready` is the control plane's own word for "the copy is
complete", and it is the same word the card renders.

**A miss falls through; only a hit short-circuits.** This is
`searchIndexedNotes`' rule — "a miss may pay for a listing, a hit never does" —
applied one layer up. The projection is a disposable derivative: it can be
behind, it can have been rebuilt, it can have lost a row. An empty answer from
it must never be reported as an empty context. The consequence is the property
that let this be switched on for every opted-in context at once rather than
behind a second switch: **the fast path can be faster, and cannot be less
complete, than the search that was already happening.**

**The tier split ranks; `canSee` decides.** `tablesForTier` picks which FTS
tables a caller's query is scored against, so `bm25()`'s corpus statistics are
computed over documents that caller may read — the inference channel
`search/CONTRACT.md` argues about, which no `WHERE` clause closes. That is the
*ranking* half and it is not access control: the tier stored on a row is
`privacy.md` as it was at index time, so a note made private a minute ago still
has team-tier rows. Every path returned is filtered through the caller's live
`canSee` before it leaves. The count is taken after that filter, not before,
or the number of results a caller sees would depend on how many notes they
cannot see.

**What it buys, measured in round trips.** The R2 path reads a manifest, the
shards a term could be in, and then every note it quotes, because its snippets
are cut from live text. This reads one manifest and one row set per tier — two
requests for a personal connection, one for a team one — and quotes the chunk
it already stored. It also has recall the shard index cannot: `NOTE_INDEX_CHAR_CAP`
exists because a shard is parsed whole into a 128MB heap, so the R2 index knows
only a note's opening 2,048 characters, and the projection has a row per chunk
and no such ceiling. A term deep inside a long saved session is findable here
and is not findable there.

**The residual, named rather than discovered.** A note deleted from the bucket
by something that is not this gateway — Obsidian, rclone — can still be
returned by the fast path for up to one reconcile interval. The R2 path is
accidentally self-correcting about this: it holds the deleted note in its index
too, but it fetches every note it quotes and drops a hit whose `GET` comes back
empty. This one fetches nothing. It is bounded, it heals behind the next search
whose maintenance pass runs, it is the customer's own note, and it cannot
become a stale *permission* because `canSee` reads the live manifest rather
than the stored tier. Closing it properly means invalidating the projection on
the gateway's own deletes and moves — a change to every write path rather than
to the read one, and a decision with a cost rather than a tidy-up.

The tests that fail if any of this is reversed: `test/searchProjection.test.mjs`,
whose "THE READ" section carries the sabotage record — including the three
mutants that measured **zero** until the fixture was changed to make them
visible, and the astral-character prefix bug that a lexicographic
`[prefix, prefix + "￿")` range had been hiding since the module was
written.
