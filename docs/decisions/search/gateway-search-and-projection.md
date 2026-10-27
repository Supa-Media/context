# Search — gateway search and projection

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

### Fast search is on for every workspace, with no switch

Decided by the owner on 2026-10-08: "lets do fast search for all". It reverses
the section below for fast search, as search by meaning already had
([meaning-search.md](./meaning-search.md)), after the R2 index measured 7.2
seconds on average and 75 at worst in admin › Search. Search by meaning does not
replace it: words find exact names, handles, numbers and quoted phrases, count
every match and read the whole of a long note, and meaning only adds a few notes
the words missed.

- **Entitled** is now every known workspace kind. The plan is not consulted and
  Premium's `fastSearch` selection no longer does anything; billing schedules
  nothing for search.
- **On by default.** The 15-minute sweep walks `storageBindings` and adds a row
  for each workspace with storage and none yet
  (`lib/fastSearchFns/rollout.ts`), at most four being built or failed in the
  last day at once, because each copy spends the account's shared Cloudflare
  request budget and a broken credential must fail a handful rather than
  everyone. `FAST_SEARCH_ROLLOUT=disabled` on the deployment stops it.
- **There is no off switch (decided by the owner, 2026-10-20: "remove the fast
  search triggers etc, fast search on by default for everyone").** The console
  offers no control, and the rollout turns a finished `off` back on, an
  owner's earlier one included. Before that date the owner's off stuck; the
  `disable` mutation still exists for the release machinery and its tests,
  and an off made through it lasts until the next sweep. A storage disconnect keeps an owner's
  off and otherwise removes the row, so a reconnected workspace is picked up
  again. Deleting the workspace keeps nothing.

What survives from below: owner-only, off deletes, the row outlives the delete,
and the handle is never cleared but by a generation change. Tests:
`apps/convex/__tests__/fastSearchRollout.test.ts`.

### A database we own holds a copy of somebody's notes only where they asked

_Superseded for fast search on 2026-10-08 by the section above; kept for the
reasoning that still holds._

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

- **Entitled** — may this context turn it on? Derived, never stored, and true
  only when the workspace has an active Premium plan that selected Fast
  Search. A legacy row without the current generation is unservable even if it
  says `ready`.
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

  **The handle is the whole mechanism, so nothing may clear it but a generation
  change.** `releaseIndex` reaches a database only through `binding.databaseId`;
  without it, it forgets the row and reports success having deleted nothing —
  which is the orphan above, reached by a different route. Two states on the
  current generation hold a live database and both look discardable: a `failed`
  row, which records `databaseId` *before* applying the schema precisely so a
  schema failure knows what it created, and a `releasing` row, which exists for
  no other purpose. So a re-opt-in keeps those coordinates and reuses the
  database; only a row from the retired generation lets go, because those name a
  database in an account we no longer address. `enable` and
  `syncPremiumSelection` are the same decision reached from the owner's switch
  and from billing, and they had better agree — they did not, and the billing
  one cleared unconditionally, so any ordinary renewal webhook stranded the
  database a failed context had already created.

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

### A name already taken in our own account is this context's database

`databaseNameFor` is `context-search-<workspace id>`, deterministic on purpose:
a slug can be renamed and a database name cannot, so a slug-derived name goes
stale against the context it belongs to. Determinism means every attempt for
one workspace asks Cloudflare for the same name, and the provisioner used to
treat a name that was already there as a failure.

It is not one. The account holds customer data and nothing of ours
(non-negotiable #2), the workspace id is immutable and unguessable, and only
this deployment creates databases there — so a database of that name **is**
this workspace's, and the run adopts it. That is `managedProvisioning.ts`'s
argument about a taken bucket name, with a wider safety margin: a bucket is the
customer's only copy and a search database is a disposable derivative.

Refusing was not a slower retry, it was a permanent one. A taken name answers
outside the four statuses `classify` names, so it landed on `REFUSED`, which
the provisioner treats as terminal — correctly, because a malformed request
does not become well-formed by waiting. The row went `failed`, the settings
card's "Try again" ran the identical create, and `disable` on a row with no
`databaseId` deletes the row outright, so off-and-on-again came back to the
same create. There was no way out of that screen from inside the product. Four
ordinary things put a context in it: a create whose answer was lost, two
schedules racing, a release that deleted the row and not the database, and a
database migrated into this account ahead of the provision that asks for it.

Two conditions travel with the adoption:

- **The name must match exactly.** Cloudflare's `name` filter is a match, not
  an identity, and the name is a shared prefix plus an id. Trusting the filter
  would adopt another context's database and then project this context's notes
  into it — one tenant's search answered out of another tenant's storage,
  arrived at through a convenience.
- **An adopted database is emptied first** (`RESET_STATEMENTS`), and the
  backfill cursor in `index_state` is why. The cursor records how far the sweep
  has walked; adopt one and the fresh backfill resumes past every note before
  that point, which are then never projected while the counters report a
  finished index — a hole in the front of somebody's search that nothing
  reports. Emptying costs a rebuild and loses nothing, which is what "the index
  is a disposable derivative" is for.

Adoption is gated on what is **there**, never on which error code came back:
which status Cloudflare answers a taken name with is provider behaviour this
repo does not control, and a rule keyed on one would be a guess that fails
silently when it is wrong.

Beside it, the same failure's other half. `classify` dropped Cloudflare's own
code and message so a provider sentence could not reach a row — the right rule,
kept in a way that also kept it from us: every 4xx outside those four statuses
became the same six words on a settings card with nothing behind them anywhere,
and an operator could not tell a taken name from an account out of databases
from a statement D1 would not accept. The detail now travels on `D1Error` and
is logged beside the workspace id. The row and the screen are unchanged.

The tests that fail if this is reversed: `__tests__/fastSearch.test.ts`, "a
name already taken in our own account is this context's database" — five
checks, each with its own measured sabotage.

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

### A context with a search database is answered by it alone, never by the bucket

Decided by the owner, 2026-10-13: only opening or editing a note reads
storage. So a context with a search database — every hosted one, since fast
search reached everyone — answers `search_notes`, `search` and the console's
search from that database and nothing else, whether it is `ready`, still
filling, or failing to answer. A database still filling answers from what it
has copied; one that cannot answer returns no hits and says the index is
still catching up, never "no notes". Neither falls through to the shard index
under `.context/search/` or to the literal scan.

That replaces "off is a working state" for a context that has a database: a
refused or slow database now costs a search its answer for as long as it
lasts, rather than costing it seconds of bucket reads. The bucket's own index
and the scan remain only for a gateway with no search database (self-hosted,
or a deployment with no Cloudflare credential). Nothing keeps a shard index
for a context with a database any more; see the next section but one.

**What fails if reversed:** `searchProjection/serve.test.mjs` ("a search
during the backfill opens no note and no index file in the bucket", "the
bucket's index does not answer instead"), `searchProjection/endToEnd.test.mjs`
("never falls back to the bucket"), and in the control plane
`consoleSearch.test.ts` ("a refused projection leaves a working search that
says it is behind") and `searchBackfill.test.ts` ("a search reads the
projection while it fills").

### An assistant's turn holds its index passes until it ends

Found on production, 2026-10-16, when Dev2 saw Tex's searches take over ten
seconds. Every call of an assistant's turn (its model rounds, its searches,
its reads) runs in one Worker invocation, which has six connections, and each
search started an index pass behind it of up to `SEARCH_SUBREQUEST_BUDGET`
calls in every workspace it reached. One turn issued about 2,000 subrequests
whose median wait was a second, while D1, Vectorize and the embedding each
answered in well under one.

So `/agent` (and Try it, and the dream) runs its turn inside
`withSearchPassesHeld` (`search/heldPasses.js`): a pass a search starts is
kept, one per workspace, and started behind the response once the turn has
answered. A search across workspaces holds its own the same way until every
workspace has answered, and asks them all at once rather than its own
workspace first. Nothing is skipped; the passes run later in the same
invocation. A host that cannot defer still runs them inline and capped.

**What fails if reversed:** `test/searchHeldPasses.test.mjs` ("a Tex turn's
searches start no index pass until the model has answered", "a held pass
starts on release, once per workspace").


## The index records the version its listing reports

A pass that reads a note records the version the *listing* gave it, never the
read's own etag. The two agreed while the listing was the bucket's; the
listing is the Convex tree now, and a row's etag need not be the stored
object's. Recording the read's etag made every such note look stale to the
next listing, so every pass read it again, three calls a note in a by-id
workspace, and the search database re-copied it: on production, 2026-10-16, a
search's pass spent its whole budget on the same notes, all day. The cost of
the rule is one extra read of a note that changed between a listing and its
read, after which the two agree. `test/searchKeyed/census.test.mjs` ("settles")
fails if it is reversed.

## Nothing runs behind a search on a context with a search database

Decided by the owner, 2026-10-17, after a Tex turn spent about 2,000 calls
("ideally, it's just one call, max two to three"). A search over a context
with a search database, ready or still filling, starts no index pass, reads no
manifest and copies nothing into the database behind its answer. Its cost is
the database query (and the meaning query beside it) and nothing else.

The database is kept current elsewhere, once per change rather than once per
search: a write follows itself into a `ready` database
(`search/writeProjection.js`, `search/d1/follow.js`), the control plane's
scheduled copy fills one still filling (`fileOps/projection.ts`), and the
daily check removes rows for notes that are gone and copies in the tree's notes
the database lacks (`prunePass.ts`, below). The
bucket's shard index under `.context/search/` is not maintained for such a
context at all: a write does not re-index into it, the console's search
schedules no pass over it, and a `maintainIndex` pass ends before opening the
bucket. The shard index and the passes behind a search remain for a gateway
with no search database.

The cost is stated: a note written into the bucket by anything but the app
is found only once the control plane's pass reaches it, which the owner
accepted on 2026-10-15 (nothing outside the app writing into the bucket is
picked up).

**What fails if reversed:** `searchProjection/endToEnd.test.mjs` ("a search
on a filling database copies nothing into it", "and a search reports no copy
progress of its own"), `searchProjection/serve.test.mjs` ("or behind that
same response"), and in the control plane `searchDatabaseOnly.test.ts`.

## A search reads no note to answer

Decided by the owner, 2026-10-17, the same evening. On a context with a search
database, the snippet beside a note found only by meaning comes out of the
database's own chunks, in one statement for every such note
(`search/d1/passages.js`), rather than a read of each note out of the bucket:
up to six reads per workspace per search, each a tree lookup, a HEAD and a GET
on a keyed workspace. Both tables of a personal context are asked in one
batched request (`queryAll` in `search/d1/client.js`), and a rows-mode
workspace's rules are rendered without asking the bucket for a `privacy.md`
that no longer exists (`store/privacyAuthority.js`). A search on such a
context is then the session, the binding, and per workspace one database
request for the words, one meaning query and one database request for the
snippets.

A note the database holds no row for is dropped when the database is ready
(deleted since it was embedded, as before) and read from the bucket when it is
still filling, since it may simply not be copied yet. A statement that fails
reads the notes, as a context with no database does. A note a queued move is
carrying somewhere the caller may not see is never asked for.

**What fails if reversed:** `meaningSnippetsFromDatabase.test.mjs`.

## The bucket keeps no search index beside a search database

Decided by the owner, 2026-10-17 ("Yes, all of it"). Once nothing read or
maintained the shard index for a context with a search database, two things
still touched it. The control plane's copy fell back to a shard index pass
for its census whenever the bucket's listing failed (`passCensus`), and the
files themselves sat in the customer's bucket. Now:

- the copy's census is the bucket's listing alone (`fileOps/projection.ts`);
  a link whose listing fails copies nothing, and the next link lists again;
- the daily check of a `ready` database (`filesFns/prunePass.ts`) deletes the
  shard index's files, `v2/` and `search-v1.json` at `.context/search/` and
  the legacy `.index/`, up to 500 per link with the chain carrying on
  (`fileOps/retireShardIndex.ts`). The list of keys is an allow-list, and
  anything under a `meaning/` segment is refused: search by meaning's
  catch-up state lives beside it, and losing that re-embeds a whole context.

Nothing is lost by deleting a derivative. A context whose database is turned
off searches the bucket again, and its first searches rebuild the index from
the notes. `SHARD_INDEX_RETIRE=off` in the deployment's environment stops the
deletes without a deploy.

**What fails if reversed:** `retireShardIndex.test.ts`, and in
`searchDatabaseOnly.test.ts` "a copy whose listing fails runs no
bucket-index pass in its place".

## The daily check re-files a ready database against the tree

Found 2026-10-27, while looking into why searching felt clunky. After the
built-in folders lost their numbers (2026-10-21), @supa's search database held
3,362 of its 3,457 rows under the old names (`1-projects/`, `0-inbox/`…) and
94 at real ones, so search missed nearly every note written before that day.
27 of 34 databases held numbered rows. Two gaps let it stay that way:

- the renames were finished by the row-move watchdog, and only the request
  that starts a move follows it into the database, so nothing said the notes
  moved;
- the daily check only removed rows, and it asked the bucket whether a note
  was gone by reading it. A numbered spelling of a built-in folder still opens
  the folder doing its job (`canonicalJobPath`), so every old row read as
  present.

Now the daily check (`filesFns/prunePass.ts`) runs the copy's own pass
(`projectSearchIndex`) against a `ready` database: rows at names the tree
lacks go, asked of the tree's `taken` 100 names at a time rather than read by
name, and notes the tree has that the database lacks or holds at an older
version are copied in. The chain runs while the sweep has further to go, up
to `PRUNE_CHAIN` (60) links a day, so whatever a write failed to follow is
caught within a day, whatever the cause.

**What fails if reversed:** `searchPrune.test.ts` ("a row at a folder's old
name goes, though a read by the old name still opens the note", "the daily
check copies notes the database lacks, at the names the tree has", "a whole
renamed workspace is re-filed in one day's links").
