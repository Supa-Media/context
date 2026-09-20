# Storage, credentials, and the control plane

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### The gateway is a Cloudflare Worker, not Convex

Convex would remove a service boundary and a shared secret, which is a real
argument and was seriously considered. It loses on two counts: self-hosting
("clone this, deploy one dependency-free file, your bucket still works") is a
published commitment, not a preference, and Convex actions bill compute on the
hottest path in the system for a product whose pitch is free.

### Credential retrieval takes two independent proofs

The gateway secret proves the caller is the gateway. The end user's access
token, forwarded verbatim, proves a real person authorized that workspace right
now. Convex resolves the workspace **from the token's grant** — the gateway
cannot name the workspace it wants, only be told, and any id it sends is a veto
rather than a lookup key.

An earlier draft made the gateway secret sufficient on its own. That would have
been the highest-value credential in the system: one leak and every customer's
bucket keys are retrievable in bulk. **A change that lets the gateway name its
own workspace would look like a cleanup and would be a catastrophe.** There is
a test asserting `expectedWorkspaceId` is never used as a lookup key.

### Never cache a decrypted credential across requests

Workers reuse isolates across tenants. A cache keyed even slightly wrong is a
cross-tenant leak. This costs roughly 20–60ms per call and that is the right
trade. Per-request caching is fine; anything that outlives a request is not.

### Scheduling is not calling

In the credential-reachability graph, `ctx.runQuery/runMutation/runAction`
propagates taint — it awaits a value and hands it to the caller.
`ctx.scheduler.runAfter` does not: it enqueues a job in a separate transaction
whose return value the scheduler discards, so there is no channel back.

Without that distinction no public function could trigger a bucket probe, and
"verify the credential the user just pasted" would have to be a polling cron
chosen to satisfy a static check rather than because it is right. Scheduled
targets must still be statically resolvable `internal.` references.

### Credential barriers are enumerated, never inferred

Reading a bucket needs a credential, so a console read path cannot exist under
a blanket "no public function may reach a decrypt". Taint stops at an
explicitly listed barrier — see `CREDENTIAL_BARRIERS` in
`__tests__/structure.test.ts`. Barriers must be internal actions whose return
validators are checked for credential fields.

This is a genuine relaxation with a real residual risk: a future operation that
returns a credential from inside a barrier would not be caught statically. The
enumeration is the mitigation — adding a second barrier fails CI loudly, which
forces the conversation.

### The setup credential is not a stored credential

Provisioning a bucket in a customer's Cloudflare account needs a credential that
can create buckets and mint further credentials — categorically worse than the
bucket key it produces. It is sealed for the length of one attempt and no
longer: `cloudflareProvisioning` holds the envelope, the scheduled action opens
it, and the row is deleted on success and stripped of the envelope on failure.
**There is no steady state in which the control plane holds an account-level
cloud credential**, which is why that table has no `succeeded` status and why a
failed row keeps its reason and loses its credential.

What persists is byte-for-byte what a manual connect would have left, written
through `applyBinding` rather than a second copy of it. A "simplification" that
inserted the binding directly would fork the field resets, the audit event and
the scheduled verification, and the direction that fork fails is a bucket
nothing ever probed.

Two invariants a tidy-up would quietly break: the permission group is resolved
**by name at runtime and the flow stops if it is absent** — there is no branch
that mints a broader key to get past it, and a hardcoded id is a guess about
what a token may do; and an opaque envelope is still the credential, so no
public function may return one (`encryptedsetupcredential` is in
`structure.test.ts`'s forbidden return-validator fields for the same reason
`encryptedsecretaccesskey` is).

Cloudflare error **10042** is a billing prerequisite, not a storage error. R2
requires a payment method even inside the free tier, and the same error
reappears months later when a card fails — Cloudflare blocks bucket access and
leaves the data intact. Reporting it as "storage error" makes us answer for
somebody else's billing rule and reads as us losing their notes.

**A failure must say what is in the customer's account now.** Three calls run
in order — resolve the permission group, create the bucket, mint the key — and
a classifier that does not know which one failed will happily say "nothing was
changed" after creating a bucket. It then tells the person to try again, and
the retry is refused by the bucket we made and never mentioned. That is the
documented likely failure, not a corner: only R2's API-token template key is
published, so a pasted credential can create a bucket and be refused at the
mint. Every recorded failure therefore carries the stage it reached, and a 5xx
or a dead socket at the create step says the outcome is _unknown_ rather than
guessing in either direction.

**Reuse is proved from Cloudflare's record, never from our memory.** A taken
name is a question. The answer is the bucket's own `creation_date`: reuse it
only if it was created at or after the moment the attempt was first written,
because a bucket the customer already had cannot have been created after they
started an attempt they had not started yet. Every unknown — no date, an
unparseable one, a lookup that failed — answers no, so the direction this fails
is "leave the customer's bucket alone". A stored "we made this" flag would be
our word for it, and deleting the orphan instead would be customer data loss
the first time R2 returns success for a bucket that already existed.

**And the attempt expires.** The invariant above says there is no steady state
holding an account-level credential; without a deadline, a run lost to a deploy
holds one forever _and_ blocks the person from retrying, because a pending row
refuses a second attempt. The row expires, an hourly sweep destroys the
envelope, and a pending row past its deadline stops blocking.

### Staff is an environment allowlist, never a column

The admin console reads figures across every tenant and holds the platform's
own integration credentials, which is a strictly larger capability than any
workspace role — so it is granted by a strictly different mechanism.
`users.isAdmin` is the obvious implementation and it is a privilege-escalation
path: the console can write to the database, so any bug in it, or anything that
reaches an admin's session, mints another admin, and a database compromise
mints one silently. A boolean in the table the console edits is a lock whose key
is kept inside the box.

`ADMIN_EMAILS` cannot be written by anything this codebase executes. Three
properties go with it and each is the failure it prevents: **unset authorizes
nobody** (the other direction publishes every tenant's figures to whoever signs
up first), **the address must be verified** (otherwise typing a staff address
into a signup form is enough), and **matching is exact with no domain rule** —
the same reasoning `ingestionSettings` gives about policies that admit more than
their author meant. There is no development bypass, because a bypass that exists
is a bypass that ships.

The cost is that granting admin is not self-service. For a founding team that is
the right trade and not a limitation to engineer away.

### Platform credentials seal to a scope, customers' seal to a workspace

`appSecrets` holds credentials belonging to Context.LC — the token that
provisions search databases, a payment key, a mail key. No tenant is on the
other end of one, so `CredentialContext` became a union rather than growing an
optional field: `{workspaceId}` or `{platform}`, never both and never neither.

**The AAD carries the kind as a literal segment** (`v2:<keyId>:workspace:<id>`
against `v2:<keyId>:platform:<scope>`). Without it, a workspace whose id
happened to equal a scope label would open the platform's envelope — the class
of bug an AAD exists to make impossible rather than unlikely, and it is tested
in exactly that collision. The `workspace:` segment is spelled as it always was;
changing it would make every stored storage binding undecryptable, which is
data loss no other test would catch.

The two live in different modules for the same reason: one keyset call away from
the wrong context object is one cross-domain decrypt.

### Anything needed before this table can be read cannot live in it

`STORAGE_SECRET_ENCRYPTION_KEY` is the key `appSecrets` rows are sealed with, so
a row holding it is a safe with its own combination inside — and worse, a
plausible-looking one: the console would accept the paste and report success
while the value is either unrecoverable or, if somebody "fixed" that by storing
it in the clear, the most damaging plaintext this control plane could hold.
`GATEWAY_SECRET` has to be checkable before any database content is trusted, so
it cannot be a database read. The auth signing key and the deploy key follow.

`RESERVED_SECRET_NAMES` is a **refusal, not a warning**. A warning is advice,
and somebody in a hurry — or an agent following an instruction — takes the path
that appears to work.

The console can set a credential and can never read one back. That is not a
property of its screens: `__tests__/structure.test.ts` forbids any public
function reaching `decryptSecret`, so a `getSecret` fails the suite rather than
merely being a bad idea. What it shows instead is 8 hex of SHA-256 — a hash and
not a prefix or a last-four, so what appears in screenshots and log lines is not
a fragment of the real credential.

### Usage is counted, never logged

The record of what somebody did in their own context already exists, in their
own bucket, under `.audit/`, where they can read and delete it. Mining that for
our dashboards would convert a customer-owned record into a product-analytics
pipeline, which is the first non-negotiable spent on a chart.

So `usageDaily` holds an integer per day per metric per optional workspace, and
`usageActiveDaily` one row per context per day per surface. There is
**structurally no field** a path, a query, a note title or a sub-day timestamp
could occupy, the metric name comes from a closed vocabulary and an
unrecognized one is dropped rather than stored, and the day is derived from this
deployment's clock so a report cannot be backdated into a window somebody has
already read. The gateway maps a tool name to a metric through a lookup table
and sends the metric — never the name, which is the difference between counting
traffic and recording behaviour.

Two shapes to keep: a cross-context call is counted against the context it was
**routed to**, not the connection's default, or one tenant's figures silently
include another's; and a counter may never fail the thing it counts, so the
report is deferred behind the response and dropped entirely on a host that
cannot defer.

### Context-owned objects have one versioned namespace

Every object Context creates that is not a user-authored note or attachment
lives under `.context/`: audit records, search indexes, meeting session state,
generated image objects, legacy ACLs, integration queues, proposals, probes and
migration journals each have a purpose-named child. User-authored roots remain
untouched, and `.obsidian/` remains the user's rather than ours.

Storage-layout v1 replaces the former sibling dot folders. Readers prefer v1
and fall back to legacy durable data; new writes use only v1. Search indexes are
disposable and may rebuild instead of paying a second read for a legacy index.
The owner-only migration copies bounded batches, refuses storage without
conditional create/write, byte-verifies every destination, records resumable
progress at `.context/migrations/storage-layout-v1.json`, and never overwrites a
different destination. Copy completion writes `.context/manifest.json`.
Deletion is a distinct explicit phase, unavailable until a seven-day rollback
window has elapsed, and re-verifies each source/destination pair before removing
the source. Re-running either phase is safe.

The console exposes this as an owner-only control in **Settings → Storage**,
and as a **dismissible notice** in the browse pane's existing notice band. It
is deliberately not chrome: it was briefly a gear in the file tree's toolbar,
beside the four controls somebody uses every day, and a maintenance operation
run once or never does not earn permanent room there. Both entry points are
gated on the same owner-only action and raise the same confirmation, which
names the boundary before anything runs: only reserved Context objects move;
notes, folders, `privacy.md`, and `index.md` do not. The notice carries one
further condition the settings row does not — a connected binding — because an
offer that appears in front of somebody has to earn the interruption, while a
row they went looking for should still be there while a probe is in flight;
neither condition decides who may run it. Its dismissal is remembered per
workspace on the device, because nothing tells the console whether a given
bucket still needs the update, so an offer drawn from availability alone would
return for ever.

One press queues a fresh capability check, bounded copy batches until copying
is complete, and safe cleanup for the end of the rollback window, so an owner
does not need to call an internal migration function or keep the console open.
A backend without verified conditional delete keeps its legacy copies rather
than risk deleting an object that changed; a stopped run is resumed by pressing
the same control again.

The connect-time capability probe persists conditional create and delete
alongside conditional writes. Older binding rows omit those fields and
therefore fail closed until they are reverified; claiming an adapter's support
without recording what the owner's bucket actually honored would make the
migration control an unsafe overwrite button.

**What a simplification of this would cost.** Writing another top-level hidden
folder recreates the clutter this layout removes; deleting during copy removes
rollback; unconditional copy can destroy a user's manually recovered object;
and requiring migration before reads breaks existing buckets. The gateway
migration checks pin all four properties, while producer tests pin the new
paths.

### Version history is the customer's object versioning, not a copy we keep

Every write path in this product used to snapshot the body it was about to
replace into `.history/<path>.<stamp>.md` — six paths in the gateway, two more
in the console. The stated premise, in the gateway's header comment, was that
"object storage has no dependable versioning".

**The premise was false.** R2, S3, B2 and Wasabi all version at the bucket. It
costs no write amplification, it is a setting on storage the customer owns, and
it captures something our snapshots never could: the writes Obsidian's sync
plugin and rclone make directly, which never pass through us at all. A product
whose first non-negotiable is that the customer owns the storage was hand-rolling
a worse version of a feature that storage already has.

What the snapshots actually bought:

- **Write amplification on somebody else's bill.** `app-and-console.md` measures
  it: tens of thousands of objects standing for a few hundred notes, in the
  customer's bucket, synced down to every Obsidian vault, and paid for by them.
- **A rollback that was never built**, and could not be read back if it were:
  `isPlumbing` refuses every dot-prefixed segment at every scope, personal
  included, so no tool could reach one. For a move or an archive it was not even
  insurance — the body still exists at the destination.
- **A permanent delete that had to hunt.** `deletePath` grew a whole purge —
  prefix-matched across five snapshot spellings written by four functions —
  because "permanently delete" was otherwise a lie. That machinery exists to
  clean up after a feature nobody used.

So the snapshots are gone and the honest consequence is stated rather than
dressed up: **with versioning off, an overwrite is final.** The setup guide tells
people to turn it on, `describeDeleteForever` says what deletion can and cannot
reach, and the offline conflict UI says "unless you turned on versioning, the
version it replaces is gone" instead of pointing at a `.history/` copy.

**What a "simplification" of this would cost.** Restoring snapshots to any one
write path re-creates every line above, quietly, in a customer's bucket. The
guard is a sweep over the whole bucket after every gateway write path has run,
not an assertion per path; sabotage `write_note` to snapshot again and it fails.

**Three things this decision deliberately keeps:**

- **`.history/` stays plumbing, and the purge stays.** Every bucket connected
  before this change is full of snapshots. Nothing writes them, everything still
  hides them, and `deletePath` is the only thing that removes them. Delete the
  purge when no such bucket can exist, which is not a date anyone can name.
- **`.context/recover/` is not a replacement history.** One file goes there: the
  unreadable `privacy.md` that `resetPrivacyManifest` repairs, whose other forty
  lines are the owner's record of what was shared. It is owner-triggered, one
  copy per repair, and the test for whether anything else belongs beside it is
  whether that thing is recoverable from anywhere else — from versioning, or from
  the notes. A note always is. `.context/` needed no plumbing changes: both
  privacy engines already refuse every dot-prefixed segment, and `.context-probe/`
  is a different segment that no prefix test collides with.
- **We do not ask for `DeleteObjectVersion`.** Permanent delete cannot remove the
  customer's noncurrent versions, and should not try. Reaching into version
  history we told them to enable, with a permission the binding does not
  currently need, to delete data in a bucket they own, is the opposite of the
  arrangement. The console names the condition instead — it cannot see the
  setting, so it does not guess which side of it somebody is on.

**Large moves are durable; their physical copy is still provider-bound.** A
large owner-scoped folder move now makes one logical cutover, persists its
marker in the customer's bucket, and materializes bounded batches through the
Cloudflare Queue. A queue ticket is hashed in the control plane and carries no
credential, note path, or note content. The owner can see only its phase and
measured object counts in Settings; source and destination names remain in the
bucket marker because a folder name can itself be private. Completed rows stay
visible for one day so progress does not disappear at 99 percent.

The storage adapter still has `get`/`put`/`delete`/`list` and no portable
server-side `copy`, so each backend pays its own read, write, verify, and delete
cost. A provider-specific `CopyObject` capability can reduce that cost later,
but it must preserve the same marker, conditional cleanup, retry, and progress
contract. The console's direct Convex move action remains synchronous; this
durable path and its progress describe gateway-triggered large moves until the
console starts the same job rather than its separate 45-second request.

### Dropbox's client secret is optional hardening, not a second credential to guard

The Dropbox app was registered as a public client on purpose: PKCE — a
verifier parked server-side in `dropboxConnectAttempts`, never in the browser
— already proves which flow a code belongs to, with no secret in the system
at all. `DROPBOX_APP_SECRET` exists on both of this project's deployments
anyway, unused, because Dropbox's app console hands one out whether or not the
app asks to be confidential.

That secret is now read — `readAppSecret()` in `functions/dropboxConnect.ts`
— and passed to `exchangeDropboxCode` and `refreshDropboxToken` as an
**optional** `clientSecret`, included in the token request only when present.
It is not required the way `DROPBOX_APP_KEY` is: PKCE already carries the
proof this flow needs, so a deployment with no secret configured — a
self-hoster mid-setup, or this repository's own tests — degrades to exactly
the public-client behaviour that shipped, rather than refusing to connect.
Where the secret **is** present, Dropbox now refuses a token request that
gets the PKCE proof right but does not also come from a process holding it —
a second, independent check that costs nothing because the exchange and every
refresh already run from a scheduled Convex action, never from a browser.

**What a "simplification" of this would cost.** Sending the secret
unconditionally (`client_secret: options.clientSecret ?? ""`) would send the
literal empty string the day a deployment's env var is unset, which Dropbox
refuses outright — turning a deployment with no secret configured into one
that cannot connect Dropbox at all instead of one that behaves as it always
did. The three call sites — `exchangeAndBind`, `revokeDropboxGrant`, and the
gateway's on-demand refresh in `functions/storage.ts` — all read the env var
themselves rather than through a shared "requireAppSecret", because requiring
it in one place while the other two stayed optional is exactly the kind of
drift nobody would notice until a refresh started failing on a deployment
that connects fine.

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

## The migration's outcome is recorded, because an offer nobody can answer is a nag

The storage-layout migration has always kept its own state in the bucket:
`migrateStorageLayout` persists it under `.context/` and short-circuits on
`complete`, so running it twice is a no-op. Nothing outside the bucket could
read it. A Convex query cannot open somebody's storage, so the console had no
way to tell **"this bucket still needs the update"** from **"it ran last
week"** — "the owner may run it" was as close to "pending" as it could get.

So the console's offer was answered by a flag on the device: `localStorage`,
per browser, per context. Run the migration on a laptop and the phone offered
it again. Clear site data and the laptop did too. Run it from Settings →
Storage — where the notice's own text sends people — and nothing was recorded
at all. The owner who reported it had pressed the button "so many times", on a
context that was already migrated, and every press was correct behaviour.

`storageBindings.storageLayoutState` is that outcome, written by
`recordStorageLayoutState` on **every** pass of the chain and on the
`unsupported` refusal, which never reaches the chain at all. It is the same
category as `scaffolded` and `noteCount`: something we observed while holding a
credential, which a query cannot recompute without becoming a public function
that opens one. The bucket stays authoritative; this is a copy that travels
with the workspace instead of with the device.

**Absent is a state, and it is the only one that still offers.** It means
nobody has run this through us. The other six are answers: `copying` and
`cleaning` are under way, `copied` is waiting out the seven-day rollback
window, `complete` is done, `conflict` needs somebody, and `unsupported` is a
bucket without conflict-safe writes, where pressing again could only produce
the same refusal. Settings → Storage reports each of them and keeps a button
for exactly one — `conflict`, the resumable one.

**A rebind clears it, for the same reason a rebind clears `lastVerifiedAt` and
the note count, and with a worse failure if it does not.** A `complete` carried
onto a bucket that has never been migrated is a bucket the console never offers
the migration to: pre-v1 plumbing left where it is, dual reads carrying it, and
nothing on any screen saying so. Silent, unlike a stale green check.

The device flag stays, as belt and braces rather than as the mechanism. It
covers the seconds between pressing and the recorded state arriving, and it is
the whole of the answer for "Not now" — a preference, not an outcome, with
nothing on the binding to record.

**What a simplification costs.** Dropping the recorded state puts the nag back
for every device a person signs in on. Dropping the rebind clear silently
strands a new bucket on the old layout. Clamping the state to owners, the way
`noteCount` is clamped, would be a category error: that number is about private
notes, and this names no key and counts nothing of the customer's.
`apps/convex/__tests__/storage.test.ts` and the migration's end-to-end case in
`files.test.ts` fail; so do four checks in
`apps/mobile/__tests__/storageMigrationEntry.test.ts`.

## Absent meant two things, and the bucket is asked which

Recording the outcome above ended the nag for every context migrated *after*
it shipped, and for nobody else. `storageLayoutState` was only ever written by
a migration pass, so a context migrated before that kept `complete` in its own
bucket and an empty column on its binding — and "absent is the only state that
still offers" then read that empty column as *nobody has run it*. The notice
came back on every device, for ever, for exactly the people who had already
run it. **The owner who reported the original nag was still being nagged by
the fix for it**, which is the sharpest version of the failure: a decision that
was right about the mechanism and wrong about the population it applied to.

Absent was never one answer. It is "nobody has run this" and "nobody has
looked", and those are opposites for every bucket that predates the column.

So the question is recorded separately from the answer.
`storageBindings.storageLayoutCheckedAt` says the bucket was **asked**;
`storageLayoutState` stays what it **said**, absent when it has genuinely never
run. The notice offers only on asked-and-never-run. Settings → Storage takes
neither condition and keeps its button while the answer is unknown, because
pressing it is still correct and now records what it finds.

**Asking runs nothing.** `readStorageLayoutState` is one `get` against
`.context/migrations/storage-layout-v1.json` — no write, no delete, and none of
the conditional-write capability the migration itself demands, because a bucket
that can never *run* the migration can still say whether it already has. It
reaches a credential through `runFileOperation`, the enumerated barrier, rather
than through a second internal action that opens one; `observeStorageLayout` is
a public owner-only mutation that schedules it, on `reverifyStorage`'s model.
`verifyStorageBinding` does the same read in the credential open it already
makes, beside `countNotes`, so connect and re-verify answer it for free.

**A bucket that will not answer is not an answer.** `readStorageLayoutState`
returns `observed: false` and nothing is recorded — a timestamp written there
would claim knowledge nobody has and close the offer on a context that may
genuinely still need it. Conversely an observation of "no state file here"
*clears* a state we had: the bucket is authoritative and this row is a copy, and
a copy that outlives what it copied is the stale-green-check failure the rebind
clear exists to avoid.

**What a simplification costs.** Collapsing `observed` into the state records a
false absence, and the nag returns with extra steps. Dropping
`storageLayoutCheckedAt` and offering on absent state alone is the bug this
section exists for. Offering while the question is still in flight puts the
notice in front of somebody about to be told it is unnecessary. Failing to
clear the timestamp on rebind is worse than failing to clear the state: a new
bucket then reads as *asked, and never migrated* — an answer nobody obtained —
and is never offered the migration at all, silently, which is the outcome the
rebind clear was written to prevent. `apps/mcp/test/storageLayout.test.mjs`
(`runStorageLayoutReadChecks`), the observation cases in
`apps/convex/__tests__/storage.test.ts`, and two checks in
`apps/mobile/__tests__/storageMigrationEntry.test.ts` fail.

## A bucket born on the layout has nothing to migrate, and is not asked to

The two sections above each fixed the offer for the population they were about
and left a third one being nagged — and the third one is **every workspace
created since**, which is the worst population to get wrong: the first thing a
new owner sees in their console is an offer to update storage they made ninety
seconds ago.

`readStorageLayoutState` asked one question — is there a migration state file?
— and an absent state file was the whole of the answer. For a bucket that
predates `.context/` that is exactly right. For a bucket **we scaffolded
ourselves** it is nonsense dressed as an answer: `scaffoldContext` writes the
v1 layout and nothing else, so a context created last week has never held a
`.audit/` or a `.history/`, will never grow one, and has no state file for
precisely the reason a migrated bucket has one — there was never anything here
to move. Asked "has the migration run?", it truthfully said no. The question
was wrong.

So the probe asks what the offer actually rests on: **is there any pre-v1
plumbing in this bucket at all?** Nine `list`s capped at one object each, only
on the path where there is no state file to read, and none of them means the
hidden files are already on the current layout — `complete`, the same answer a
migrated bucket gives, because it is the same fact. Still read-only: no `put`,
no `delete`, no capability requirement, so a bucket that can never *run* the
migration can still answer.

**A bucket that will not answer is not an empty bucket.** A listing that
throws, or a store too old to have `list` at all, falls back to the answer this
replaced: nothing recorded, offer stands. Closing the offer wrongly is the
failure with no screen behind it — pre-v1 plumbing left where nothing mentions
it — and it is worth one more dismissible notice to avoid.

**Fixing the question does not fix the answers it already gave**, and those
answers are the new workspaces this is about: `observeStorageLayout` spends
itself on `storageLayoutCheckedAt` and never asks twice. So the generation is
recorded beside the answer — `storageLayoutCheckedVersion`, against
`STORAGE_LAYOUT_PROBE_VERSION` in `functions/lib/storageLayout.ts` — and a row
from an older probe is asked once more by the next console that opens. Not a
backfill: this repository is self-hostable, and a deployment nobody here can
reach must heal itself. Only the *absence* of a state is re-asked; a recorded
state is the bucket's own word and reads the same to every generation.

`storageLayoutAnswerIsCurrent` is one predicate read by both the console (as
`layoutChecked`) and the mutation, because a console that believed the question
was open while the backend refused to ask it would put the notice back,
silently, on exactly the buckets this closes it for.

**What a simplification costs.** Dropping the plumbing probe offers a one-time
update to every context on its first load, for ever, with nothing behind it.
Reading a failed listing as an empty bucket retires the offer on a bucket
nobody could see into — the silent half of non-negotiable #2's dual-read
promise. Dropping the generation stamp fixes only contexts created after the
deploy and leaves today's new workspaces nagging for ever, which is this
section happening a fourth time. `runStorageLayoutReadChecks` in
`apps/mcp/test/storageLayout.test.mjs` (thirteen checks, including one per
legacy prefix), the whole chain end to end in `apps/convex/__tests__/files.test.ts`
("a bucket born on the layout answers 'already current'"), the
probe-generation cases in `apps/convex/__tests__/storage.test.ts`, and three
checks in `apps/mobile/__tests__/storageMigrationEntry.test.ts` fail.

## The same absence, in the capability column, made after the rule was written

`capabilities` is the section above happening a second time, in a column whose
absence disables a feature rather than offering one — and it shipped *after*
that argument was recorded, which is the part worth keeping.

`storageBindings.capabilities` held `conditionalWrite` alone until 2026-09-12,
when `conditionalCreate` and `conditionalDelete` joined it as optional fields
and nothing went back for the rows that already existed. The gateway composes
`declared && probed` (`store/factory.js`) and **must** fail closed on an
unproven capability: a binding that claims conditional writes it does not have
loses somebody's edit silently, which is the one failure a notes product cannot
have. That rule is right and is not what was wrong. What was wrong is that
absent and `false` arrived at it as the same value, so every binding older than
the field reported no conditional delete and `moveSafetyRefusal` refused every
move in those workspaces. A paying customer found it, not a test.

That section also asserted the buckets underneath "have supported conditional
delete throughout", and **the backfill it argued for is what disproved it**:
once every row was probed rather than assumed, `conditionalDelete` came back
`false` on all of them. R2 accepts `If-Match` on DELETE and does not enforce
it, which is the shape the probe is built to catch and the reason it fails
closed. The refusal was reporting the truth; the feature it refused was the
thing that needed to change. See the section below.

Nothing re-asked, and that is the structural half. There was no storage job in
`crons.ts`, and `reverifyStorage` is a button an owner presses; asking somebody
to press it requires them to know a capability exists, to know their row is
missing it, and to connect that to a refusal whose text names their storage
provider. `serverSideCopy` was the same fault one step further along: probed
since #374 and never in the schema at all, so no re-verification could have
filled it in and every move paid a full read-and-write round trip.

**The read stays fail-closed; the write grows a backfill.** This is the
opposite resolution to the section above, and deliberately so. There the
question was recorded separately from the answer because *asking* is a `get`
that any bucket can survive. Here asking is a probe that writes, reads and
deletes under `.context/` — real work against somebody's endpoint — so the
gateway is not the place to do it, and an `undefined` it cannot resolve must
stay a refusal. `sweepUnprobedCapabilities` answers the question where a
credential is already open: hourly, bounded, `connected` rows only, carrying no
`structure` so it cannot scaffold, and audited with no actor because a probe
the customer did not ask for still belongs in the trail of a bucket they own.

**Adding a capability is adding a backfill, and the predicate is what makes
that automatic.** The sweep matches on *any* known capability field being
absent, never on `conditionalDelete` by name, so the next field reaches
existing rows without anybody remembering this section. Its scan is indexless
— absence is not a thing an index answers — which is affordable at one row per
workspace with storage and stops being affordable past roughly ten thousand of
them, where a Convex transaction can no longer read the table and the job
becomes an hourly error. That is the loud direction, and the remedy is an
indexed `capabilitiesProbedVersion` rather than a larger batch.

**A capability observed only as `false` is a capability untested.** The reason
this survived ten days is that the S3 stub ignored `If-Match` on DELETE and did
not serve `x-amz-copy-source`, so no test ever ran against a backend that
*has* these — every assertion agreed the answer was `false` and none of them
could tell why. A probe is a claim about a backend, so its test needs the
honest backend as much as the lying one.

**What a simplification costs.** Letting the gateway treat absent as "probably
fine" trades a refusal anybody can see for a lost write nobody can, which is
the trade this whole file exists to refuse. Dropping the sweep leaves the
repair to a button pressed by owners who cannot know they need it. Narrowing
its predicate to the fields that are missing today guarantees the next
capability is found by a customer again. Restoring a stub that ignores write
preconditions makes every capability test vacuous in the direction that works.
`apps/convex/__tests__/capabilityBackfill.test.ts`, the capability assertions in
`provisioning.test.ts` and `reverifyStorage.test.ts`, and the two legacy-binding
checks in `apps/mcp/test/storeFactory.test.mjs` fail.

## A conditional write is the guard a conditional delete would have been

A move is copy-then-delete, and the delete is the half that can destroy work:
an edit landing between the two is lost, and the copy already taken is the
older version. So every move required `conditionalDelete` and refused without
it — the right instinct, applied to the wrong primitive.

**R2 does not enforce `If-Match` on DELETE.** Measured, after the capability
backfill above made it measurable: the probe declares the capability, tests it,
and every binding in production answered `false`. The consequence was total and
went unnoticed because it was worded as somebody else's fault — no note could
be moved, renamed, batched or handed to another workspace, on the storage this
product runs on, and each refusal named the storage provider. `conditionalWrite`
and `conditionalCreate` were `true` throughout.

The substitute is a conditional **write**, in `retireMovedSource`:

1. PUT the source path with `If-Match` on the etag that was copied. Atomic, and
   it fails if anybody touched the note — the same conflict the conditional
   delete reported, from the same evidence.
2. The object at that path is now a zero-byte marker of ours, so the DELETE
   that follows needs no precondition: there is nothing there left to lose.

`moveSafetyRefusal` therefore accepts **either** conditional, and a store with
neither is still refused by name. That is not a softening: a store that cannot
claim a path cannot move a note safely, and B2 and Wasabi remain refused.

**Trash is a cross-workspace concern only.** A same-workspace move needs no
extra copy, because the destination *is* the copy — a third one in the same
bucket is storage the customer pays for to hold what they already have. A
cross-workspace move is the exception, and the reason is the one thing it
cannot promise: its destination is a different bucket, which the owner may stop
being able to reach. So that move alone leaves the source bytes under
`.context/trash/<timestamp>/<original path>`, plumbing and therefore invisible
to every listing, search and privacy decision.

**What a simplification of this would cost.** Dropping the conditional claim
and deleting outright is the silent data loss, and it is three checks in
`test/moveWithoutConditionalDelete.test.mjs` — measured by sabotage, not
assumed. Accepting a store with neither conditional lets a move start that can
only finish unsafely. Taking the trash copy after the claim archives the
marker instead of the note. Keeping the old requirement in
`deleteObjectForMove` lets a large folder cut over logically and then never
materialize, which is worse than refusing up front.

## Which folder is "the archive" is a question, not a constant

`4-archive` was a literal in two places that had to agree and did not.
`archive_note` refused any context whose manifest did not declare it;
`archivePath`, behind the console's archive button, created it regardless. That
disagreement was invisible while `4-archive` was the only archive this product
shipped, and stopped being invisible the moment the `company` preset shipped
`5-archive` — **the default layout for a shared workspace**. The most common
shared context we create therefore had a folder plainly named the archive,
declared in its manifest and sitting in its own root listing, that Claude
refused to use while the console quietly opened a second archive beside it, in
a bucket the owner also reads in Obsidian. A customer archived a note by hand
and was told their context had no archive.

The refusal was right and its premise was wrong. Refusing to *invent* a
destination in somebody's bucket is the same rule `save_context` and the
connect instructions were purged for breaking — a layout is the owner's, and
an agent tidying up must not create a top-level folder they did not choose.
What was wrong was reading "has an archive" as "declares this exact string".

So `archiveRoot` resolves it from the manifest, and both surfaces call it:
`<number>-archive` or plain `archive`, case-insensitive, matched on the rule's
root segment so a rule naming something *inside* the archive still says the
folder exists. **A shape and not a list** — a list is the same assumption with
one more entry, and the next preset would reintroduce the bug it was written
for. `SESSION_FOLDERS` and the router's preview mirror are computed off the
archive roots this product ships for the same reason.

**It resolves; it does not guess.** `retired`, `old` and `cold-storage` all name
the same idea, and a folder name is not enough to know one is meant. Widening a
shape must not drift into inferring intent, so those still refuse, and
`archiveResolution.test.ts` pins the line — including `archived`, `archives` and
`my-archive-notes`, which merely contain the word.

**`4-archive` wins whenever it is declared at all.** Every context that already
had an archive keeps filing where its history is, so the installed base cannot
be moved by this. Absent that, the answer is the first in sorted order — a
property of the *set*, never of manifest order, because reordering `privacy.md`
must not silently repoint archiving. And "already archived" is measured against
**every** archive a context has, not the one that would be written to, or a note
put away in `5-archive` would be picked up and moved again into a `4-archive`
declared beside it.

Two consequences worth naming rather than discovering. `defaultSessionFolder`
resolves through the same function, so a context whose archive is not
`4-archive` now files new sessions beside its archive instead of into
`0-inbox/sessions` — the behaviour that function always described, reaching
contexts it had been failing to recognise; sessions already written stay where
they are. And `archivePath` adopts the gateway's refusal, so a layout with no
archive at all is now told so by the console instead of being given one: a
capability removed on purpose, because the thing it did was the invention the
gateway refuses.

**What a simplification costs.** Going back to a literal restores a bug whose
blast radius is "the default shared layout". Letting the two surfaces keep
their own copies of the answer puts one bucket's archive in two folders
depending on which one the person used, with neither reporting anything wrong —
which is why the differential in `archiveResolution.test.ts` drives the
gateway's real resolver rather than a restatement. Dropping the `4-archive`
preference moves the archive of every PARA context that ever gains a second
one. Narrowing "already archived" to the write destination re-archives notes
that were already put away. Both of those last two were **measured**: each was
sabotaged, each left the suite green, and the manifests and the check that now
catch them were added because of it.

## A verification snapshot is never read as live state

`scaffoldReason`, `scaffolded`, `scaffoldMissing`, `noteCount`,
`noteCountTruncated` and `noteCountedAt` are all written by exactly one thing:
the pass `verifyStorageBinding` makes when a binding is connected or
re-verified. Nothing that puts a note in a bucket touches any of them — not the
gateway, not `write_note`, not email ingestion, not the console's own editor —
because none of those opens the binding to record what it did, and a per-write
counter on the control plane would be a second source of truth for something
the bucket already knows.

That is the right design and it has one consequence, which has now cost us a
shipped defect: **every one of these fields is a measurement taken at a past
instant, and a live claim built on one is a guess.** The first version of the
console's empty-context card read `scaffoldReason === "empty"` as "this bucket
is empty" and drew *This context is empty*, with an offer to scaffold, over a
workspace whose tree was full of the owner's notes. The binding was telling the
truth about a moment months earlier; the card turned it into the present tense.

The rule, in the two shapes it takes:

**A decision reads the live thing.** Whether a context is empty is answered by
the listing in front of the person, never by the binding. The binding may still
be read *to stay quiet* — `existing-context` and `created` are reasons not to
offer — but it can never be the reason to assert. The pattern generalises:
snapshots may veto, only live reads may claim.

**A number says when it was taken.** Settings → Storage had this right from the
start — "412 notes — counted 3 weeks ago" — and the two surfaces that printed
the same walk bare have been brought into line: the Premium panel's usage line,
and the console's "notes across all" tile, which is dated by its *oldest*
contributing walk because a sum is only as fresh as its stalest part. A `+` is
not a substitute: notes are deleted as well as written, so a stale count can be
over as easily as under, and a floor would be a second false claim rather than
a hedge.

Two readers are legitimate and stay: onboarding's `structureStepFor` and the
Dropbox callback both read the field within seconds of the walk that wrote it,
standing in front of a bucket they have just watched being verified.
`applyStructure`'s server-side guards read it too, but they are a pre-filter and
not the safety boundary — `hasExistingContext` re-lists the bucket, and every
individual write is preceded by a `get`, so a stale `empty` costs a wasted round
trip and never a write over somebody's notes.

**What a simplification costs.** Re-deriving "is this context empty" from the
binding puts the scaffold offer back on live workspaces. Printing any of these
counts undated re-asserts a figure nobody measured recently — #25's shape, with
a real number instead of a constant. Dating the notes tile by its newest walk
rather than its oldest flatters a total whose other half is a year stale.
`apps/mobile/__tests__/contextSetup.test.ts`,
`browseSetupPrompt.test.ts` ("a context whose notes arrived after it was
verified"), `noteTotals.test.ts` ("how old the number is"),
`liveConsoleFacts.test.ts` ("dates the number rather than implying it is
current") and the two usage-line checks in `premiumSettings.test.ts` fail.

### A move between two contexts is three calls, not one function holding two keys

Moving a note or a folder from one context into another crosses a tenancy
boundary: two buckets, usually two credentials, often two customers' accounts.
The storage adapter has `get`, `put`, `delete` and `list` and **no portable
server-side copy**, so the bytes have to be read out of one bucket and written
into the other by something that can reach both.

The obvious shape is one internal action that opens both credentials. It is
refused. `runFileOperation` is one of the two members of `CREDENTIAL_BARRIERS`
and the whole argument for that enumeration — see "Credential barriers are
enumerated, never inferred" above — is that a barrier is small enough to audit
by reading it: it opens **one** workspace's credential, performs one operation,
and hands back a result that by construction cannot contain a key. A barrier
holding two customers' plaintext secrets in one scope is a different object with
a different blast radius, and it would need that argument made again from
scratch.

So a batch is three trips through the one barrier — `contextMoveExport` against
the source, `contextMoveImport` against the destination, `contextMoveDelete`
against the source — and the orchestrator that sequences them,
`functions/contextMoves.ts`, holds no credential at all. Note bodies pass
through it in flight, bounded by `CONTEXT_MOVE_BATCH_BYTES`; nothing is stored.
That is the same transit every `readNote` already makes and is not what
non-negotiable #1 forbids, which is the control plane *holding* note content.

**Copy, verify, then retire, per object.** The destination answers with an etag
before the source key is touched. A batch that dies leaves objects in both
places, which the next pass simply does not see — the recoverable direction. The
opposite order loses notes. A source edited between the copy and the retirement
keeps the newer text: the copy is rolled back and the move stops, because
silently deleting the newer one is the only outcome here that destroys work.

**"Retire" and not "delete", because a conditional DELETE is not a guard on the
storage this runs on.** R2 accepts `If-Match` on DELETE and ignores it, so the
obvious `delete(path, { onlyIf: { etagMatches } })` either refuses every move or
silently destroys that edit. `retireMovedSource` here is the gateway's, ported
rather than reinvented so two engines cannot drift on a data-loss guard: claim
the source path with a zero-byte marker under a conditional **PUT** on the
copied etag — atomic, and it fails if anybody touched the note — then delete the
marker, which by then is the only thing at that key. Either conditional
satisfies the source and `conditionalCreate` is required at the destination;
both are asked before a byte moves, and a store with neither is refused by name.

**No trash copy, and that is a divergence from the gateway's single-note
cross-workspace move, which keeps one.** The argument there is that this is the
one move whose destination is a bucket the owner may stop being able to reach.
It holds, and what does not carry to this path is the arithmetic: the gateway
trashes one note moved by an agent on a tool call, and this moves a folder a
person picked a destination for in a dialog that names it — so the copy would
scale with the folder and double a nine-thousand-note move in the customer's own
bucket until somebody empties trash. The content is not lost either way; access
to it is, and giving it away is what the press meant. Reversing this is a
`trashBody` away and would be a reasonable call to make differently.

**This is also why a cross-context move has no size limit.**
`FOLDER_OPERATION_CAP` refuses a single-store folder move past 500 files, and
that refusal is right where it is: `movePath` rewrites `privacy.md` as though
the whole walk happened, so a partial walk cannot be operated on. Here the
all-or-nothing unit is one *object*, so nine thousand notes is not a bigger
operation — it is more batches, carried by a `contextMoves` row and a chain of
scheduled passes that outlive the request that started them. Each pass lists the
subtree **from the beginning**, which costs nothing because the previous batch's
objects are gone by then, and which avoids the cursor-over-a-mutating-listing
skip that `clearVaultBatch` documents one function up.

**The row holds paths, and `gatewayJobs` beside it deliberately does not.** That
row is minted for a queue ticket and read again with nobody present, so the less
it knows the better. A `contextMoves` row exists only because a person pressed
Move, it is readable only by an owner of the context the move is leaving, and
the audit trail already records `file.move` with both paths for every
same-context move. A move job that could not name what was moving could not tell
that person which of their folders is still going.

**Authorization is asymmetric: `owner` on the source, `editor` on the
destination.** Taking something out of a context removes it from everybody who
could read it there, which is not a call an editor invited to help with one
project gets to make. Putting something in is an ordinary write. The
destination's own clearance is then re-checked by the same
`assertDestinationsVisible` a single-store move uses, so an editor cannot land
anything in a folder that context keeps private — this is the one place a write
arrives in a context from outside it, and a second implementation of "may they
write here" is a second one to get wrong.

**What a "simplification" of this would cost.** One action with two credentials
puts a second, wider entry in `CREDENTIAL_BARRIERS` and every argument that
enumeration exists to force. Deleting before the destination answers loses notes
on any failure. An unconditional delete loses the edit somebody made while the
move ran. A persisted listing cursor skips objects on S3-compatible providers. Trusting a
conditional DELETE destroys an edit made mid-move on R2, silently, while the
code claims it is kept.
Doing it in one request reintroduces the 500-file ceiling on the operation whose
whole point is not having one. `apps/convex/__tests__/contextMove.test.ts` and
`contextMoves.test.ts` fail — in particular "a folder larger than a single-store
move could touch still moves, whole", "a note edited between the copy and the
delete keeps the newer text", "on storage that ignores a conditional delete, the edit is still kept",
and the endpoint enumeration that makes a fourth public function in that module
impossible to add without an isolation test.

## The model key is a fourth credential route, not a fifth sibling on the binding

The agent spends the customer's own Anthropic or OpenAI account, so the control
plane holds an API key per workspace (`providerCredentials`, encrypted with the
workspace as AAD, exactly like a storage secret). The gateway has to have it in
plaintext for the length of one request, which makes it the fourth thing
`CREDENTIAL_HTTP_ROUTES` enumerates: `/gateway/provider`.

**Every previous gateway-facing credential deliberately avoided being a route.**
`searchIndex`, `encryptionKey` and `rotation` are all *siblings* on
`/gateway/binding`'s response, and `apps/convex/http.ts` says why in as many
words: a second route handing out a credential would be another entry in that
set, "which that comment says is a conversation". This is the conversation, and
it comes out the other way — for a reason that is about #661 rather than about
taste.

#661 was a **returns validator** accident. `storageBindings.capabilities` gained
a fourth key while two routes in `controlPlane.ts` restated the capability shape
inline; `v.object` is exact, so `openStorageBinding`'s own `returns` refused the
object it had just built, and `ReturnsValidationError` named what it rejected.
`s3BindingValidator` carries `secretAccessKey`, so a live R2 secret and a D1
token went into the production logs. Everything folded into that one validator
shares that fate: one drift anywhere in the shape serializes everything in the
shape. Adding a model key to it would make a single future accident spill a
storage secret *and* a credential issued by somebody else's console — which,
unlike ours, **we cannot rotate**.

So the model key gets a validator of its own: two flat fields, `provider` and
`apiKey`, with nothing nested in it to drift. That is a strictly smaller blast
radius than the sibling, bought with a door — and the door is the same door.
`/gateway/provider` is built by the same `gatewayRoute` factory, spends the same
gateway secret, resolves the same access token to a live grant independently,
applies the same rule that `expectedWorkspaceId` **selects within the grant's own
set and is never a lookup key**, and answers `{"credential": null}` for
everything that is not a hit — an unknown token, an expired or revoked grant, a
workspace outside the set, a provider this build does not know, a provider
nobody connected, and a decrypt that failed.

Two smaller things fall out of it, both worth keeping:

- **The key is opened only by the request about to spend it.** An ordinary MCP
  call fetches `/gateway/binding`; a model key riding that payload would be
  decrypted on every `list_notes` in the product.
- **No scope beyond a live grant**, and that is not an omission. A token that can
  open this can already open the same workspace's *storage* credential through
  `/gateway/binding` — the whole bucket, read and write. A model key that bills
  the owner's own provider account is strictly less than that, so a further check
  here would be theatre rather than a bound. What bounds it is what bounds the
  binding: the grant is live, it is revocable, and the connection is in the audit
  trail. A *member* of a shared context can therefore spend its owner's model
  account, the same way a member can already rewrite every note in it.

**What a "simplification" of this would cost.** Folding the credential back into
`/gateway/binding` puts a key we cannot rotate inside the validator that has
already leaked one we could. Letting the route's argument validator refuse an
unknown provider makes the refusal a *different* answer from every other one,
which is an oracle for the provider set — so the closed set is checked in the
handler, where the refusal is the same `null`. Letting anything ride beside the
credential in the response — a workspace id, a fingerprint, a grant id — makes
two refusals distinguishable and puts a fact about a customer next to a secret.
`apps/convex/__tests__/providerCredentials.test.ts` fails, in particular "a hit
names the provider and the key, and nothing else", "an unknown provider is
answered exactly like an unknown token" and "a token for one workspace cannot
open another's credential"; `apps/mcp/test/providerCredential.test.mjs` fails
"a token cannot reach another tenant's model account" and "a refusal is a 200
with a null, never a status the caller can count"; and
`apps/convex/__tests__/structure.test.ts` fails on the enumeration itself.

### A moved note leaves a forwarding address, and it is a trail rather than an index

`links.js` already rewrites every reference **inside** the bucket when
something moves: rename a folder and the wikilinks and Markdown links in every
note that can see it follow, by default. That is the whole of the problem for
references we can reach, and none of it for references we cannot. A share link
pasted into a thread last month, a deep link in somebody's chat log, a path an
agent wrote down — none of those live in a file, so no rewrite reaches them,
and until this landed every one of them died the first time a context was
tidied. Quietly, and to the wrong person: whoever moved the note is not whoever
is holding the link.

So a move appends to `.context/forwarding.json`: `{ from, to, kind, at }`,
written by the gateway and by the console through one module
(`apps/mcp/src/forwarding.js`, imported by `fileOps.ts` exactly as the search
modules are), so a rename through the app and the same rename through an MCP
client leave the same trail.

**The shape is a trail between paths, not an index of references, and that is
the decision.** An index — "who links to what" — is the obvious way to make a
move cheap, and it is the wrong thing to keep in a bucket that Obsidian,
`rclone` and a text editor also write. It would be a second copy of every link
in the context, drifting the moment somebody edits a note outside the gateway,
and a *stale* copy of a reference is worse than no copy because it names a
relationship that no longer exists. The links stay in the files, where they are
canonical and where the customer can read them without us (non-negotiable #3).
What is kept is the one fact a holder of a stale path needs, which is a fact
about the move rather than about any reference: where the thing went.

Four properties carry it, and each fails a test if removed:

- **A folder move is one entry.** Renaming `2-areas/` writes a single prefix
  rule, so the ledger's size follows the number of *moves* rather than the
  number of files, and a nine-thousand-note rename is one row. The prefix
  matches on a segment boundary, so `2-areas-old/x.md` is never carried by a
  rule written for `2-areas` — the same trailing-slash care `withinSharedFolder`
  takes.
- **Chains collapse as they are recorded.** Recording `b → c` rewrites an
  existing `a → b` into `a → c`, and an entry that would point at itself is
  dropped, so a note moved back where it started forwards nowhere rather than in
  a circle.
- **The most specific rule wins, never the newest.** An exact entry outranks a
  folder entry, because a note that left a folder before the folder moved has
  two possible answers and only its own is true — and between two folder
  entries that both contain a path, the longer prefix wins for the same reason.
  Move `2-areas/apps` out to `1-projects/apps`, then rename `2-areas`, and the
  newer rule is the wrong answer for everything under `apps`.
- **It is bounded and it expires rather than breaks.** Past
  `FORWARDING_ENTRY_CAP` the oldest entries are dropped, and a cold forwarding
  address is a link that stops working — which is what it did before this
  existed.

**It is never the only copy of anything**, which is what makes it safe to cap
and safe to lose. Delete the file and the bucket is unchanged: every in-bucket
link still resolves, because those were rewritten in place at move time. A
write failure is therefore swallowed rather than raised — by the time it runs
the objects have already moved, and an exception would fail an operation that
has already succeeded. The write is still conditional (`onlyIf`), because two
moves landing at once must not lose one to last-writer-wins; a store that
cannot do conditional writes simply does not keep the address.

**An absent ledger is a valid state, so this is not a layout migration.** The
on-bucket layout is a versioned stable format and changing it needs dual reads
and a verified migration. Adding a plumbing file whose absence already means
"no forwarding addresses" changes no existing key, is dual-read by
construction, and leaves a bucket that has never seen this code working exactly
as it did. A *future* change to the file's own shape is what needs the
migration, which is why it carries a `version` and why an unknown version reads
as empty rather than being guessed at.

**Two orders, and collapsing them would be a bug.** `readFile` takes
`forward: "never" | "onMiss"`. A deep link is `onMiss` — a path means what it
says today, so a note that exists where the address points wins, and only a
dead address is forwarded, which also keeps the extra GET off every successful
read. A share needs the opposite order and resolves through the `forward`
operation before it reads anything, argued in
[privacy-and-sharing](./privacy-and-sharing.md).

**What a "simplification" of this would cost.** Writing one entry per file in a
folder move turns a PARA reorganisation into thousands of rows in a file every
share read fetches. Matching the prefix with `startsWith` hands
`2-areas-old/x.md` to a rule written for `2-areas`. Dropping the collapse makes
a five-move note a five-hop resolution and lets a cycle exist. Resolving
overlapping folder rules by recency rather than by longest prefix sends
everything under a subfolder that moved out first to wherever its old parent
was later renamed. Letting
`recordForwarding` throw fails moves that already happened. Growing this into a
reference index puts a drifting second copy of the customer's links in their
own bucket and breaks non-negotiable #3's "never the only copy of anything" in
the other direction. `apps/mcp/test/forwarding.test.mjs` fails, in particular
"a folder move is one entry, not one per file", "a sibling whose name merely
starts the same is not carried", "a chain resolves to the end of the chain" and
"the oldest expired rather than corrupting the file"; the wired half of
`apps/mcp/test/links.test.mjs` fails "a path renamed and then carried by a
folder move still arrives" and "the forwarding ledger cannot be read as a note";
and `apps/convex/__tests__/shareSurvivesMove.test.ts` fails throughout.

## A live editing room holds note text, and the enumeration does not list it

**Raised 2026-09-20 by the adversarial review, against the live-merge work in
flight. The call is the owner's; this is the record they need to make it, not
the decision.**

Two people typing in one note need a place where both sets of characters exist
before either is saved. In the design under review that place is the presence
room's update log, in Durable Object storage: every keystroke is appended, the
log is replayed to whoever joins, and one elected member flushes to the bucket
on a debounce.

**The feature's own account of the cost is honest and is quoted rather than
paraphrased**, because it is the better half of this argument: *"While a room is
live, text exists in the room's log — Durable Object storage — until the elected
writer flushes it. That is the one place note content is durable outside the
customer's bucket, it is what lets everybody's letters reach everybody, and it
is dropped when the room empties."*

**Decided by the owner, 2026-09-20: the enumeration changes, not the design.**
Non-negotiable #2 now names a live note's in-flight keystrokes alongside the
buckets and the search databases. The reasoning below stands as the record of
what was weighed; what follows is which way it went and why the alternative was
not taken.

Two people typing in one note need a shared place for characters that are
seconds old, and there is no version of that feature without one — so the
choice was never "log or no log", it was "say so, or hold it somewhere that
loses work". The in-memory option priced below keeps the sentence shorter at
the cost of losing unflushed characters whenever a room is evicted
mid-sentence, which is a worse thing to explain to somebody than one more line
in an enumeration. The enumeration exists so that a customer asking what of
theirs we hold gets a complete answer; extending it is what keeps that true.

**What stays load-bearing** is every bound below, because they are the reason
this is a third category and not an open door: one room per note, append-only,
deleted when the last person leaves, replayed only to a socket that passed
`canSee`, and never the only copy of anything. Remove any of them and the
sentence in #2 stops being honest, which is a different decision from this one
and has to be taken deliberately.

**The original argument, kept.** It cites non-negotiable #3. The binding
citation is #2. #3 says a derivative
must be *"rebuildable from the files, never the only copy of anything"*, and for
a few hundred milliseconds between a keystroke and its flush the log **is** the
only copy of those characters — which is not a derivative at all. But the
sharper constraint is #2's enumeration of what may hold customer data in a
Cloudflare account of ours: *"those buckets, and the per-context search
databases — and nothing of ours."* A Durable Object holding note text is a
**third category, and it is not on that list.** Whichever way this is settled,
that sentence has to change or the design does; leaving both as they are is the
option that is not available.

**What the design does to bound it**, each verified rather than taken on trust:

- the log lives in one Durable Object per `(workspaceId, notePath)`, so it is
  per-tenant by construction and there is no key to get wrong;
- it is replayed only to a socket that passed `canSee` at join, and a socket is
  closed at `PRESENCE_SOCKET_MAX_MS`, so a withdrawn reader stops receiving
  within that bound;
- it is deleted when the last member leaves, and the sweep that deletes it stays
  armed on a non-empty log even at zero sockets, so the deletion is reachable;
- the flush is continuous, so the window in which the log holds unique
  characters is a debounce rather than a session.

**What a reversal would cost, in both directions.** Removing the log removes
concurrent editing: the alternative to a shared place for in-flight characters
is the conflict box this work exists to delete, and "two people typing in one
note" cannot be built without one. Keeping it while leaving #2's enumeration
unamended costs the thing the enumeration is for — a customer asking what of
theirs we hold, and getting an answer that is complete.

**A third option, if the enumeration is to stay closed:** hold the log in memory
rather than in Durable Object storage. It survives hibernation today because
storage does; in memory it would not, so a room evicted mid-sentence loses
unflushed characters. That is a real cost and a smaller one than it sounds — the
flush is continuous — and it is the version that keeps "nothing of ours" true.
Nobody has priced it.

**The test that fails if the bound is reversed** is in
`apps/mcp/test/presence.test.mjs`: the last socket leaving takes the log with
it, a room with anybody still in it keeps every letter, and an empty room that
still holds a log keeps its alarm armed — with a room holding neither as the
non-vacuity half, since an `ensureAlarm` that always armed would pass the third
alone. Before those, the retention guard was implemented and stood on nothing —
the checks beside it asserted a function's *arity*, which a deletion that
cleared the whole prefix would have passed.

The third of those is the one worth naming separately: `dropLogIfEmpty` is only
ever called from `alarm()`, so a guard that deletes correctly and is never
scheduled bounds nothing at all. This paragraph described all three before any
of them existed — they were written against a branch that did not merge — which
is the same failure it is documenting, one level up. They exist now.

**One thing this work got right that belongs in this file.** The author expected
to need the gateway's first npm dependency and said they would break the
zero-dependency rule deliberately — then read why the rule exists and did not.
`check-gateway-imports.mjs` gives three reasons and the sharpest is that this
workspace hoists, so a bare import would bundle and ship **without ever
appearing in `apps/mcp/package.json`**: an invisible dependency in a Worker that
decrypts a customer's storage credential on every request. The merge logic went
to the clients instead, and updates are opaque bytes to the gateway. That is the
strongest argument for the rule anyone has produced, and it was produced by
someone trying to make an exception to it.
