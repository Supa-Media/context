# Search — copy pass and descriptor

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
  advanced the R2 index, because a cold workspace's first link may have no budget
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

### The descriptor is a sibling of the binding, and the gateway reads it there

The reader above shipped and served **not one search**. `/gateway/binding`
answers `{binding, searchIndex}` — siblings, and `http.ts` says so: "the storage
binding, and — only where an owner asked for one and it exists — the index
credential *beside* it". The gateway's `getStorageBinding` returned
`parsed.binding` alone, and `storeForSession` then looked for the descriptor at
`binding.searchIndex`, a key the control plane has never sent. So
`store.searchIndex` was `null` on every request in production and
`fastSearchAnswer` returned on its first line, for every caller, always.

**The sibling shape stays and the gateway was fixed**, not the other way round.
A D1 write credential is not a property of a bucket: nesting it inside the
binding means adding it to both provider validators and handing it to
`storeForBinding`, which has no business with it. One route resolving the
workspace once and answering both questions is the design `openStorageBinding`
argues for, and it is right.

**Why nothing caught it, which matters more than the fix.** The control plane's
route tests assert `body.searchIndex` as a sibling, thoroughly — including that
the whole response contains no such key when a context never opted in. The
gateway's tests assert what it does with a descriptor it is *given*. Between
them sat the only question neither asked: can the gateway read what the route
sends? Every gateway fixture — `controlPlaneStub.mjs`, `credentialShape.test.mjs`,
`searchProjection.test.mjs` — nested `searchIndex` **inside** the binding,
because they were written from the gateway's own assumption. A fixture that
restates one side's guess to the other is not a test of a contract, it is that
guess with a green tick beside it.

So the fix is three things, and the last is the one that closes the class:

- the gateway returns the envelope and reads the descriptor beside the binding;
- `controlPlaneStub.mjs` splits the descriptor out at the wire, so no fixture
  can put it back inside the binding and have the suite agree;
- `controlPlane.test.ts` takes the **real bytes of a real `/gateway/binding`
  response** and feeds them to the gateway's **real** `createControlPlane` and
  `storeForSession`. Nothing in that check is hand-built but the transport.
  Reverting either half of the fix fails it, and fails 11 checks in the
  gateway's own suite; before the fixtures were corrected, the same two mutants
  failed nothing anywhere.

**And `state: "ready"` is the one gate the reader trusts**, so what withholds it
was measured rather than read. A live context reported "100% indexed, 100 notes"
while holding more than 160, and 100 is exactly `VERSION_PROBE_CAP` — so a
census of 250 is now walked through `projectPass`. It clears the cap: forcing
`windowReachedEnd` true reddens **0**, and forcing `notesPending` to 0 reddens
3. `sweepComplete` is not the gate; `notesPending === 0` is, and it is
`census size − COUNT(*)` plus whatever the R2 index says it has not reached.
A sweep that ends early cannot lie, because the count would not match.

That relocates the question instead of answering it, and the relocation is the
finding: for a projection to honestly report "100 indexed, 0 pending", its
**census** must hold 100 — and the census is the R2 index's own docmap, not a
listing this pass makes. A context whose bucket holds 160 notes and whose
projection calls itself complete at 100 is a context whose *R2 index* knows
about 100 and believes it is caught up. That is upstream of every line in the
projection, needs the live manifest's `freshness` to diagnose, and is not
fixable from a fixture.

### …and the console asks the same projection, through the same answer

`fileOps.ts`'s `searchNotes` already ran the gateway's `searchIndexedNotes`
rather than a port of it, because "one search path" is a privacy rule and not a
tidiness one. The projection needed the same treatment and did not have it: the
gateway's reader lived inside `fastSearchAnswer` in `apps/mcp/src/index.js`,
private to that module, so the console could only have got a fast path by
copying it.

**What would have been copied is the part that must not be.** Everything below
the D1 query is a boundary: which rows a caller keeps, whether the count is
taken before or after that filter, and whether an empty result is an answer. A
second copy of those three decisions is a second place for each to be wrong,
and the one that matters would be silent — a console counting candidates rather
than visible notes tells a team member how many notes they may not read match
their word.

So `answerFromProjection` moved into `search/d1/serve.js` and both surfaces call
it. `isVisible` is injected exactly as it is into `searchIndexedNotes`: the
gateway's privacy engine is module-private and the control plane has its own,
proven identical by `__tests__/privacyEngine.test.ts`, and a third copy inside
the shared answer is the thing those two exist to avoid.

**A read never writes the row**, and that asymmetry with a projection pass is
why `runFileOperation` has two blocks rather than one. A pass that cannot reach
its database must say so — a workspace sitting at "Preparing" with nothing to
explain why is the bug that path exists to close. A search must do the opposite:
somebody typed a word, and a deployment whose Cloudflare credential is missing
must not have their search flip a provisioning row to `failed` as a side effect.
It falls through to the R2 index, which is what every context without fast
search does anyway.

**Three of the six guards on this path were proved by nothing** when they were
first written, and the fixtures had to change before the mutants moved:

- **Removing `canSee` from the shared answer reddened 0.** A team caller queries
  the team table alone, so a note projected `private` is not in the candidate
  set and no filter is needed to keep it out. The window the filter actually
  closes is the other one — a note projected at `team` and then made private,
  whose team-tier rows survive until the next pass moves them — and no fixture
  had one.
- **Counting candidates instead of visible notes reddened 0**, for the same
  reason: no query matched both a note a team caller could read and one they
  could not, so the two numbers were never different.
- **Asking for a `backfilling` row instead of a `ready` one reddened 0.** Every
  check either handed a client in directly or ran a pass, so the state the
  barrier asks for was never observed. It is observed now at the action level,
  where the only thing that can prove it lives: `runFileOperation` must open a
  projection for a search over a `ready` row and must not over a filling one.

The tests that fail if any of this is reversed: `__tests__/consoleSearch.test.ts`
(whose projection cases delete the R2 index first, because with both indexes
present no assertion about paths or counts can say which one answered) and the
read case in `__tests__/searchBackfill.test.ts`.

### One round trip, and why it cannot be zero

The fast path cost three round trips when it shipped: the manifest, then the
private tier, then the team tier. It costs one.

**The tiers go out together.** They are independent statements against separate
tables and awaiting them one at a time bought nothing. The budget is settled for
every table *before* any query starts, for the reason `walkReserve` exists — a
reserve taken out of what the previous stage happened to leave is not a reserve
— and a table the pass cannot afford means `null` for the whole answer rather
than the rows already gathered. A personal caller's corpus is legitimately both
tables; answering out of one of them ranks every hit against a corpus half the
notes are missing from, which is a plausible, quietly wrong order instead of a
slow correct one.

**The manifest moved behind the response.** The reconcile clock still needs it —
without a manifest `indexNeedsAPass` reads "no index at all" and re-lists the
whole bucket behind every fast search — but nothing the caller waits for does.
So `maintainIndexAfter` now accepts a *function* for `found` and resolves it
inside the deferred work. The cost is stated rather than hidden: with nothing
resolved yet it cannot know whether there is anything to do, so it always
reports `deferred`, and "nothing to do" becomes a `waitUntil` that reads a
manifest and stops. One read behind the response in place of one in front of it.

What the answer then says about freshness is `indexIncomplete: false`, and it is
entitled to: the projection is only read at `state: "ready"`, and the control
plane sets that exactly when `notesPending === 0` — a number that already
includes whatever the R2 index had not reached. A `ready` projection *is* a
statement that the index was caught up when the last pass measured it, so
reading the manifest to re-derive it was work nobody needed.

**And it cannot be zero, because there is no D1 binding to have.** A Worker's
D1 bindings are declared in `wrangler.toml` and resolved at deploy time; there
is no runtime call that opens a database by id. Fast search creates one database
per opted-in workspace at runtime, so binding them would mean a redeploy per
customer who flips the switch, and then a ceiling — bindings are capped per
Worker in the low thousands, which is a number of *customers*. The HTTPS request
is therefore the floor for this architecture rather than an interim step, and
"a REST backend and a binding backend" is closed as **won't build**, not
deferred.

The one design that would remove the round trip is a single database for every
tenant with a `workspaceId` column, and that is refused above for a reason no
amount of latency outweighs: FTS5 computes corpus statistics over a whole table,
so one shared table ranks every customer's search against every other
customer's vocabulary.

What remains on the critical path of a hit is `privacy.md`, which every request
reads to build the privacy engine, and the D1 queries themselves — asserted in
`test/searchProjection.test.mjs`, which counts index reads before and after the
response separately, because a count over the whole fixture cannot tell the two
apart.
