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
or a dead socket at the create step says the outcome is *unknown* rather than
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
holds one forever *and* blocks the person from retrying, because a pending row
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

**What this does not solve.** A bulk move still copies every byte through the
Worker, because the storage adapter has `get`/`put`/`delete`/`list` and no
`copy`; a folder move still rewrites `privacy.md` once per note under a
conditional-write retry loop, which serialises the batch; and both run inside one
Worker invocation against a 50-subrequest budget, which is what `FOLDER_MOVE_CAP`
of 500 and `BATCH_MOVE_CAP` of 100 are optimistic about. Removing the snapshot
takes one round trip and one full body copy per object out of that, and no more.
Server-side `CopyObject` behind a probed `copy` capability, one manifest write per
operation, and a resumable job for anything larger than an invocation are the
next three, in that order.

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
*mechanism* of the first non-negotiable and deliberately keeps its *promise* —
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
   non-negotiable, and managed storage changes what it is *for*: it used to be
   about connecting an existing brain without migration, and it is now also
   the thing that makes handing a bucket over possible at all. A bucket
   holding one customer's notes can be given to them; a shared bucket with a
   prefix per customer can only ever be exported *from*. `managedBucketName()`
   derives the name from the workspace id — immutable, unique, and structurally
   incapable of colliding — rather than from a slug that can be reserved,
   renamed, or typed by somebody else.
2. **A separate Cloudflare account, holding customer buckets and nothing
   else.** R2 has a flat bucket namespace with no grouping, so the account
   *is* the boundary: a blast radius, a billing line, and an API token that
   cannot reach anything of ours. It costs nothing to create now and is a
   multi-day migration with one cutover per tenant later, because R2 has no
   "move bucket between accounts" operation — only a copy (Super Slurper) and
   a repoint.
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

### Why R2 specifically, and not S3

The whole design rests on being able to afford a bucket per workspace. AWS S3
allows **100 buckets per account by default**, raisable into the low thousands
— a ceiling this product would hit while still small, at which point the only
remaining option is prefix tenancy and the exit promise dies with it. R2's
limit is **1,000,000 buckets per account**, so the ceiling is not a design
constraint. This is the fact that makes the architecture legal; if the store
ever moves, it has to be re-checked first.

The price is operational, and it is real: a five-figure bucket count means
lifecycle rules, CORS and metrics can never be managed by hand, the Cloudflare
dashboard stops being useful for browsing, and provisioning has to be code
from the first bucket. That is the accepted cost of being able to hand
somebody their storage.

### The credential, which is more dangerous than the BYO one

The managed account's API token can create buckets and mint further
credentials across *every* customer bucket, which makes it categorically worse
than anything this codebase has held before: the BYO setup credential is one
customer's, used for seconds, and never stored. This one is ours, standing,
and long-lived. So it lives only in `MANAGED_R2_API_TOKEN`, is read only
inside actions, is never written to any table, never returned by any function,
never logged, and never reaches the gateway — the gateway continues to receive
only the per-bucket S3 key that provisioning mints, exactly as it does for a
BYO binding. A workspace's binding is indistinguishable downstream from one a
customer pasted, which is the point: the adapter has no idea who is paying.

`bindStorage` also refuses an endpoint pointing at the managed account. A
customer cannot reach it without our token, so this guard blocks nothing an
attacker could otherwise do — it exists so that "the managed account holds
customer buckets and nothing else" is enforced in code rather than asserted in
this file.

### What a "simplification" of this would cost

Putting managed buckets in the same Cloudflare account as our own
infrastructure saves one account and costs the blast radius: a token scoped to
"R2 in this account" would then reach production buckets too. Reusing one
bucket with a prefix per workspace saves a five-figure bucket count and costs
the entire hand-off story, turning the product into every other SaaS that lets
you export a zip. Deriving the bucket name from a slug instead of a workspace
id saves nothing and buys a rename bug. Each of these is the cheap version of
a promise that is the reason the product exists.

**The test that fails if this is reversed.** `__tests__/managedStorage.test.ts`
asserts that two workspaces can never derive the same bucket name, that a
managed name is recognisably ours, that the managed account id is refused as a
customer-supplied one, and that nothing in the module returns or embeds the
managed token.
