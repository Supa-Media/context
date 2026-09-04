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
