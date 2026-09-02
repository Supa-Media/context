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
