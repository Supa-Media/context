# Storage and credentials — managed storage

## Managed storage: a bucket we run, in an account that holds nothing else

**Decided 2026-09.** The product no longer requires everybody to bring their
own bucket. Managed storage is the paid option: we create the bucket, we pay
for it, and the customer never opens a Cloudflare account. This changes the
_mechanism_ of the first non-negotiable and deliberately keeps its _promise_ —
see the rewrite in `CLAUDE.md`. Nothing below is a softening of it; several
things are stricter than the BYO path.

### Why it exists

"Make a Cloudflare account, then an R2 bucket, then an S3 key, then paste
both" is where every non-technical person stops. `functions/cloudflare.ts`
already removed part of that wall by provisioning **into the customer's own
account** from a credential they supply, and that path stays exactly as it is
— it is still the free one and still the honest shape. But it needs a
Cloudflare account to exist first, and for the audience this product is now
aimed at, that account is the wall.

### What must stay true, or the promise is gone

1. **One workspace, one bucket. Never a prefix.** This is the second
   non-negotiable, and managed storage changes what it is _for_: it used to be
   about connecting an existing workspace without migration, and it is now also
   the thing that makes handing a bucket over possible at all. A bucket
   holding one customer's notes can be given to them; a shared bucket with a
   prefix per customer can only ever be exported _from_. `managedBucketName()`
   derives the name from the workspace id — immutable, unique, and structurally
   incapable of colliding — rather than from a slug that can be reserved,
   renamed, or typed by somebody else.

   **The console does not print it.** R2 has no rename, so a name derived from
   anything a person can change is a name that goes stale or forces a copy
   migration to fix, and a name a person can _type_ is one somebody else can
   aim at. Both of those are worse than an ugly string — but the ugly string
   does not have to be the label. `storagePillLabel()` prints `R2 · managed`
   for a managed binding and keeps `ctx-<workspaceId>` in Settings → Storage →
   Bucket, where somebody diagnosing a real problem is already looking.
   `managed` is computed by the control plane (`getStorageBinding`) rather than
   pattern-matched on the prefix in a client, so the name stays the server's
   business. The tests that fail if this is reversed are the managed cases in
   `apps/mobile/__tests__/storagePill.test.ts`.
2. **A separate Cloudflare account, holding customer data and nothing of
   ours.** R2 has a flat bucket namespace with no grouping, so the account
   _is_ the boundary: a blast radius, a billing line, and an API token that
   cannot reach our own infrastructure. It costs nothing to create now and is
   a multi-day migration with one cutover per tenant later, because R2 has no
   "move bucket between accounts" operation — only a copy (Super Slurper) and
   a repoint.

   **That account exists (owner, 2026-09-10) and is empty by design.** Our own
   Workers — the gateway, the edge router, the email and transcribe Workers —
   stay in the Supa Media account, and they reach customer resources over the
   API with a credential rather than through a binding: the gateway signs S3
   requests with a per-bucket key, and Convex calls the Cloudflare API to
   create buckets and D1 databases. Nothing about this rule requires a Worker
   to sit beside the data, which is the thing that would otherwise pull our
   infrastructure in.

   **"Customer data", deliberately, and not "buckets".** The per-context D1
   search databases (`context-search-<workspaceId>`, `lib/d1.ts`) are the same
   thing in a different Cloudflare product: one resource per workspace, built
   from the customer's own files, disposable and rebuildable. They are
   expected to move into this account too, and the rule is what the account is
   _for_ rather than which product it holds — one resource per workspace, all
   of it derived from or holding one customer's content, none of it ours. What
   must never join it is anything of ours: a Worker, a queue, a bucket holding
   our own state.

3. **Plain files, unchanged layout.** A managed bucket holds exactly what a
   BYO bucket holds: Markdown, PARA folders, `privacy.md`, attachments beside
   their notes. Nothing about the on-bucket format may become conditional on
   who is paying.
4. **The exit is free, identical, and outlives the subscription.** Download
   everything, or hand it to a bucket of their own, on both plans and after a
   cancellation. The moment either is gated, "you can always leave" is
   marketing rather than architecture.
5. **Cancelling never deletes.** Read-only and exportable for a stated window,
   with the final removal an action the customer takes.

### Why R2 specifically

The design rests on being able to afford a bucket per workspace, so the
per-account bucket ceiling is the first thing to check in any store this ever
moves to. R2 allows **1,000,000 buckets per account**, which is not a
constraint at any size this product plausibly reaches.

**It is no longer the differentiator it would have been before November 2024.**
S3's default was 100 buckets per account for most of its life — a ceiling this
product would have hit while still small — but it is now **10,000 by default
and raisable to 1,000,000** through Service Quotas. The honest reasons to
prefer R2 are therefore price and operations rather than capacity: no egress
fee, which is what makes "download everything" and "move it to your own
bucket" cost us nothing to offer and is the exit promise's economics; and no
per-bucket monthly charge above a free allowance, where S3 bills for buckets
beyond the first 2,000. Capacity is merely not in the way.

The price is operational, and it is real: a five-figure bucket count means
lifecycle rules, CORS and metrics can never be managed by hand, the Cloudflare
dashboard stops being useful for browsing, and provisioning has to be code
from the first bucket. That is the accepted cost of being able to hand
somebody their storage.

### One customer-data account id, after the D1 migration

The target state has one customer-data account id for both R2 and D1. Today the
two values **must differ**: the four live search databases are still in the Supa
Media compute account, so `SEARCH_D1_ACCOUNT_ID` still names that account while
`MANAGED_R2_ACCOUNT_ID` names the empty Context.LC customer-data account.

Changing the search account id or token before migrating the stored database
ids would not move anything. It would strand every existing index behind a
credential for the wrong account. Search is disposable, so the migration is a
controlled reprovision and backfill rather than a data move: create replacement
databases in Context.LC, apply the schema, rebuild them from the canonical
files, switch the binding rows, and only then delete the old Supa Media
databases with the legacy credential.

After that cutover, keeping `SEARCH_D1_ACCOUNT_ID` in `appSecrets` and
`MANAGED_R2_ACCOUNT_ID` in the environment would write the same fact down in
two places. Consolidate them onto one customer-data account id then, not before.
The failure mode for doing it early is a production search outage; the failure
mode for never doing it is quiet configuration drift.

### Cloudflare credentials follow the account boundary

The Supa Media deploy credential and the Context.LC customer-data credential
are not interchangeable:

- `CLOUDFLARE_API_TOKEN` deploys Workers, queues and routes in the Supa Media
  compute account. It must carry no D1 or R2 permission.
- `SEARCH_D1_API_TOKEN` is the temporary legacy D1 credential for the Supa
  Media account while the four existing indexes remain there.
- The Context.LC customer-data operator credential needs D1 and R2 access plus
  account-token management so managed provisioning can mint a key scoped to
  one workspace bucket. It must carry no Workers, queues, Pages or routes.

The last two can become one named customer-data credential only when D1 has
moved and both consumers name the Context.LC account. Consolidating their names
or values before the resource migration disguises two different account
boundaries as one secret and fails only at runtime.

### One customer-data account per deployment, never shared

Resource names are unique because Convex ids are — **within one deployment**,
and this applies to a D1 database name exactly as it does to a bucket.
The R2 bucket namespace is per _account_, so pointing a preview or dev
deployment at the production managed account reintroduces exactly the
collision this design exists to prevent, and the reuse path in
`provisionCloudflareStorage` would then _adopt_ a production customer's bucket
rather than fail. `MANAGED_R2_ACCOUNT_ID` copied between deployments is the
obvious way to do it by accident. Provisioning must assert it is entitled to
the account it is about to write into before it creates anything; until it
does, the rule is operational and this paragraph is the whole of it.

### The credential, which is more dangerous than the BYO one

The managed account's API token can create buckets and mint further
credentials across _every_ customer bucket, which makes it categorically worse
than anything this codebase has held before: the BYO setup credential is one
customer's, used for seconds, and never stored. This one is ours, standing,
and long-lived.

**So the two values live in two different places, and that split is load-bearing
rather than tidy.** The account id is an identifier: it decides nothing alone,
and the guards below need it on the _public_ bind path — which rules `appSecrets`
out, because `__tests__/structure.test.ts` fails any public function whose call
graph reaches `decryptSecret`. It is therefore an environment variable, synced
like `APPLE_TEAM_ID` rather than committed. The token is a credential and goes
to `appSecrets` — encrypted at rest, set in the staff console, fingerprinted,
rotatable — exactly as `SEARCH_D1_API_TOKEN` does for the search provisioner,
and it is opened only by the provisioning `internalAction`. It is never written
to a binding row, never returned by any function, never logged, and never
reaches the gateway, which continues to receive only the per-bucket S3 key that
provisioning mints. A managed binding is indistinguishable downstream from one a
customer pasted, which is the point: the adapter has no idea who is paying.

A guard that needed _both_ values would fail open the moment one of them was
missing — during a token rotation, or on a deployment that had set only one —
and it would do so silently, on precisely the deployment with an account worth
protecting. Hence one value, read on its own, with "absent" and "malformed"
kept as different answers: absent is a self-hoster and refuses nothing;
malformed throws.

### A bucket is ready only after its credential answers

Creating an R2 bucket and minting its scoped key do not make it immediately
usable: Cloudflare documents R2 IAM changes as eventually consistent for up to
one minute. The first production journey proved the consequence by probing the
new key 266 milliseconds after minting it, painting the connection red, and
then succeeding when the owner tried again ninety seconds later.

**This is a fact about R2, not about one flow, and every path that mints an R2
credential and then uses it waits on the same window** — the customer's own
"create a bucket for me", managed provisioning, and the readiness gate in front
of the managed copy. The window lives once, as `R2_CREDENTIAL_SETTLE_MS` in
`functions/lib/cloudflare.ts`, next to the calls that do the minting; three
copies of it would be three chances to fix the race in only two places, which
is exactly how the migration path and the customer's own path each kept it
after the first fix.

It does **not** extend to a credential somebody pasted. That one is as old as
they are, there is no propagation to wait for, and the common failure is a typo
— so a refusal is an answer and `bindStorage` reports it immediately rather than
making somebody watch a spinner for two minutes to be told they mistyped a key.

Provisioning therefore remains `running` after the binding row is
written, retries a failed probe every five seconds for up to two minutes, and
turns `ready` only after the exact credential the gateway will use has listed
and written to the bucket successfully. Failures inside that window stay
neutral and are never persisted as a broken binding; only the final failed
probe turns the attempt red. Both first-run and Settings name the two-minute
window and keep the setup hand-off on screen until success or a real failure.

A managed binding cannot use the ordinary Disconnect or Rotate key controls:
the customer does not hold that key, so deleting its binding strands a paid
bucket with no route back. The mutation refuses it as well as the UI omitting
it. The recovery for older inconsistent rows is the idempotent managed retry,
which adopts the deterministic bucket rather than creating another one.

The tests that fail if this is reversed are the managed provisioning cases in
`apps/convex/__tests__/managedProvisioning.test.ts`, the settling case in
`apps/convex/__tests__/cloudflare.test.ts` for the customer's own bucket, the
managed disconnect case in `apps/convex/__tests__/storage.test.ts`, and the
two-minute waiting states in the Premium and onboarding render suites.

The same shape, one layer over, for the search database: `provisionIndex`
creates a D1 database and applies its schema in the next breath, and a database
that is not routable yet is a wait rather than a failure. It retries on its own
two-minute window and keeps `failed` for what will answer the same way forever —
a refused operator token, which is standing configuration rather than a freshly
minted key, and a refused statement. Recording `failed` on the first error was a
dead end rather than a setback: `sweepStalledBackfills` only picks up rows that
reached `backfilling`, so nothing recovered it and the only cure was the owner
toggling the switch. The tests are the settling cases in
`apps/convex/__tests__/fastSearch.test.ts`.

### Moving an existing context into the managed bucket

An existing S3/R2 or Dropbox binding remains the live binding while a paid
move runs. The control plane parks the new managed bucket credential in
`managedStorageMigrations`, encrypted with the same workspace-bound envelope
as ordinary storage credentials, and copies objects in bounded resumable
pages. A first copy is followed by source and destination reconciliation; any
changed, added, or removed object repeats the verification cycle. Only a full
quiet cycle permits cutover.

Progress has a measured denominator rather than an estimate. A read-only
census walks the live source first, then each copy and verification page records
how many objects it processed. Settings names the current phase and shows its
processed-versus-total count and percentage; it shows no percentage during the
census because the denominator is not known yet. The source may change while
the job runs, so each completed source walk replaces the earlier total with the
new count. Existing migrations created before this field was added resume from
their saved cursor and fall back to a cumulative checked count rather than
restarting a potentially multi-day copy just to manufacture a percentage.

The copy waits for the same settling window the fresh-bucket path waits for,
and for the same reason. The section above documents R2 IAM changes as
eventually consistent for up to a minute; the migration path started its walk
in the tick the key was minted and treated the first error of any kind as
final, so an upgrade of a context that already had storage reported that the
copy had stopped and then completed on a retry that changed nothing. Beginning
a migration therefore queues a readiness gate rather than the copy: it runs the
same `probeStore` a pasted credential gets, every five seconds for up to two
minutes, and hands over to the walk only once the new bucket has both listed
and accepted a write. A bucket that never answers inside that window fails as
`TARGET_NOT_READY`.

Failures *during* the copy are retried on the same window rather than ending
the migration, because a page that failed is not a migration that failed — the
target is minutes old, the source is somebody else's storage, and both are
reached over a network. The window measures one unbroken run of failures, not
the migration: a page that lands schedules its successor with no deadline, so a
long copy is never on a clock that started at its first object. Only failures
that would answer identically forever skip the retry — the migration's own
preconditions (`SOURCE_UNAVAILABLE`) and an object too large to move
(`OBJECT_TOO_LARGE`). A read-back that does not match a write made moments ago
is retried, because on a bucket this new that is far likelier to be propagation
than a backend that corrupts what it is given.

A stopped migration is recorded in both places a stopped migration has to be
recorded: the row the copy resumes from, and the plan the console reads.
Writing only the row is how a migration becomes invisible — the owner watches a
copy that has already stopped, with no retry offered and nothing to wait for.

Cutover is conditional on the exact source binding id recorded at the start.
If the owner reconnects storage while the copy is running, the migration fails
closed and the newly connected binding stays live. The source bucket is never
deleted. A failed copy keeps its cursor and managed credential for a safe retry;
that envelope participates in the normal key-rotation pass and workspace
deletion cascade. Successful cutover moves the credential onto the ordinary
binding and deletes the migration row.

The tests that fail if the waiting is reversed are the
`waiting for a managed bucket that has only just been made` cases in
`apps/convex/__tests__/managedProvisioning.test.ts` — including the two that
prove an upgrade and a retry queue the gate rather than the copy, which is the
wiring the gate's own cases cannot see.

### A pass is walked in waves, and an unchanged object is read twice, not three times

The reconciliation is correct but was costed as though every object were free.
Each listed key was reconciled one at a time, awaiting each before starting the
next, and each cost three full-body reads: the source, the destination to
compare against, and the destination again to verify. The third was
unconditional, so a pass over a context where nothing had changed re-downloaded
every object for an answer the second read had already given.

That put a verification pass over a twenty-thousand-object context on the order
of an hour, which is what made the source changing underneath the job the
problem it became. A change found in either verification pass sends the
migration back to `verify_source`, so one edit costs a full round trip of both
passes; at an hour a pass, an ordinary afternoon of editing outruns the walk and
cutover never arrives. The console compounded it by reporting progress *within
the current step*, so a restart read as the percentage going backwards.

Two changes, neither touching what reconciliation means:

- **The verifying read happens only after a write.** When the comparison read
  already proved the bytes equal, nothing was written and that read *is* the
  proof; asking again only asks the same question. Where a write did happen the
  read-back is unchanged, because that is the case it was built for.
- **A page is reconciled in bounded waves rather than one object at a time.**
  Every key on a page is independent of every other, so awaiting them serially
  bought nothing and cost a round trip each. Waves are bounded by count *and* by
  bytes: reconciling one object holds its source and destination bodies at once
  and the byte cap admits 25MB objects, so a width-bounded wave alone is a wave
  that can be holding hundreds of megabytes. Pages grew with the width, since
  what a small page was really buying was per-action scheduling overhead.

The wave width is not the gateway's. `inWaves` in `search/maintain.js` uses 6
because a Worker may hold 6 simultaneous connections; this runs in a Convex
action, where the binding constraint is memory instead, and the width and the
byte budget are set against that.

Together these take a steady-state pass from three serial reads per object to
two concurrent ones — roughly a twenty-fold reduction in wall-clock, and with it
the livelock: an edit still costs two passes, but two passes are now minutes.
That is a mitigation and not a proof of convergence. A context edited
continuously can still in principle outrun the walk, and the fix for *that* is
to reconcile the keys known to have changed rather than re-walking everything —
deliberately not built here, because the cost of it is a per-key change list
that the walk does not currently keep.

What is **not** a fix, and was considered: asking the owner to stop editing
while the copy runs. The source binding stays live and serving throughout by
design — that is the guarantee that makes a paid move safe to start — and a
context is written to by every agent connected to it, not only by the person
reading the settings panel. A migration that requires the product to be idle is
a migration that fails on exactly the contexts large enough to need one.

The tests that fail if this is reversed are in
`apps/convex/__tests__/managedMigration.test.ts`: the destination is read once
for an object already identical and twice for one that had to be written; waves
close at whichever bound comes first; an object larger than the whole budget
gets a wave of its own rather than being starved; and a failed page raises the
error of the earliest *listed* object and lets its wave settle first, so which
error a caller sees does not depend on network timing.

The settings panel reports files checked, says which storage remains
authoritative, and offers an owner-only retry. This is still not the free exit
path: exporting everything or handing the managed bucket to customer-owned
storage remains a separate launch requirement.

`bindStorage` also refuses an endpoint addressing the managed account, and the
BYO provisioning path refuses its account id. A customer cannot reach that
account without our token, so neither guard blocks an attack — they exist so
that "the customer-data account holds nothing of ours" is enforced
in code rather than asserted in this file, and so that an operator or a support
engineer pointing the wrong flow at it gets a refusal instead of a bucket.

### Replacing a bucket from a local vault

The Obsidian importer's destructive option means the literal bucket, not only
the note paths the console normally shows. It deletes `privacy.md`, attachments,
audit objects, recovery objects and derived R2 indexes as well as Markdown.
That is why it is owner-only, requires `I understand` at both UI and mutation,
and is implemented through the sole credential barrier as a durable job rather
than as a browser loop holding storage credentials.

One pass counts the bucket and later passes remove at most 100 objects. Delete
passes always list from the beginning: a continuation token describes the old
keyspace and may skip objects after the preceding page disappears. Progress is
counts only; no object list or file content enters Convex. Provider-side
versioning is outside Context's control, so the UI says that an older provider
version may remain even though every current object is removed.

Only after the bucket is empty does the job accept local upload batches. Its
last batch restores a valid all-private `privacy.md` before recording
completion. A failure at any point leaves a resumable phase and count; it never
turns into permission to replay the typed confirmation against another vault or
workspace.

**They compare the endpoint as the URL parser sees it, never as it was typed.**
A substring test over the raw string is not the same check as the one every
consumer performs: `new URL()` percent-decodes and IDNA-maps the host, so
`0123456789%61bcdef…` and a fullwidth-digit spelling both reach the managed
account while reading as something else. Both were accepted by the first
version of this guard and both are now regression tests. What the guards
cannot see is a **custom domain**, which is a DNS fact rather than a string
one — a known limit, not an oversight.

### What a "simplification" of this would cost

Putting managed buckets in the same Cloudflare account as our own
infrastructure saves one account and costs the blast radius: a token scoped to
"R2 in this account" would then reach production buckets too. Reusing one
bucket with a prefix per workspace saves a five-figure bucket count and costs
the entire hand-off story, turning the product into every other SaaS that lets
you export a zip. Deriving the bucket name from a slug instead of a workspace
id saves nothing and buys a rename bug. Each of these is the cheap version of
a promise that is the reason the product exists.

**The tests that fail if this is reversed.** `__tests__/managedStorage.test.ts`
asserts that two workspaces can never derive the same bucket name — including
that a case-differing id _refuses_ rather than folding onto an existing bucket
— that a malformed account id throws instead of silently disabling the guards,
and that the normalised endpoint forms are refused while a path or query
merely containing the id is not.

Those are unit tests, and unit tests alone would let both call sites be
deleted with the suite still green — the exact failure `testing.md` names. So
the wiring is pinned separately, against the real actions:
`__tests__/storage.test.ts` drives `bindStorage` and asserts the refusal _and_
that no row was written, and `__tests__/cloudflare.test.ts` drives
`provisionCloudflareR2` and asserts Cloudflare was never called. Deleting
either guard call fails one of those two, which was checked by deleting them.

**Still unproven, and named here rather than implied:** nothing yet tests the
export or hand-off path, because it is not built. Non-negotiable #1's promise
that the exit is free, identical on both plans and works after cancellation is
a commitment this decision makes and a later change has to keep.
