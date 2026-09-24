# Search — backfill and the switch

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
context: two workspaces can be answered from two different places, and a switch
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
