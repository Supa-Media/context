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
