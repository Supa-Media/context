# Agent Instructions — Context

**Free your context. Share your context.**

Context is one MCP endpoint a person adds to every AI client, backed by a
markdown bucket they own. Read `README.md` first for the product shape.

## Non-negotiables

These are the product, not implementation details. If a task seems to require
breaking one, stop and say so rather than working around it.

### 1. The customer owns the storage

- Canonical Markdown and attachments live in a bucket the **customer** owns
  (R2, S3, B2, any S3-compatible endpoint). We are a tenant in it.
- The control plane is **never** the canonical store. It holds metadata only:
  accounts, workspaces, storage bindings, grants, audit. Never note content.
- A customer can revoke our storage credential without asking us first, and
  keep a complete, usable context.
- Credentials never live in Markdown, in the customer's bucket, in logs, in
  URLs, or on a device. Encrypted at rest in the control plane, decrypted only
  in the gateway at request time.

### 2. Tenancy is bucket-level, never prefix-level

**Do not namespace keys inside a customer's bucket.** No `tenants/<id>/`, no
`workspaces/<slug>/`. A note lives at `1-projects/foo.md`, full stop.

This is load-bearing. An existing brain — including Seyi's live bucket, which
has been running since August — must connect to Context and work unchanged, with
zero migration. Users also sync the same bucket to Obsidian via Remotely Save;
rewriting keys breaks that. One workspace maps to one bucket (optionally one
bucket + a fixed root prefix chosen by the customer, applied at the adapter
boundary and invisible above it).

### 3. Plain files stay canonical

- Markdown stays portable and human-readable.
- Search indexes, caches, and embeddings are **disposable derivatives**,
  rebuildable from the files. Never the only copy of anything.
- The on-bucket layout is a stable format, not an internal detail:
  `index.md` and `privacy.md` at root, `.history/`, `.audit/`, PARA folders.
  Treat changes to it as breaking changes.

### 4. One person or workspace is one security boundary

- Every workspace has its own identity, storage binding, privacy manifest,
  audit trail, and connector grants. **Not an ingestion alias** — only a
  personal context has one. See "Ingestion is on the apex" below.
- **Never** extend the legacy shared-token model (`PRIVATE_TOKEN` /
  `TEAM_TOKEN` / `PUBLIC_TOKEN`) to multiple customers. It is single-tenant by
  construction and exists only to keep the original brain running.
- MCP access uses OAuth with per-client revocable grants. Token-in-URL is a
  compatibility fallback only, and never the security boundary.
- Prove isolation with tests: one tenant must not enumerate, read, or infer the
  existence of another.

### 5. `team` never means public

Visibility is `private` or `team`. `team` means **named people the owner
granted access to**. There is no anonymous or internet-public tier. Do not add
one.

## Architecture

```
apps/convex/     control plane: accounts, workspaces, usernames, storage
                 bindings, OAuth clients + grants, audit events
apps/mobile/     Expo (iOS/Android/web): onboarding, dashboard, health
apps/web/        landing page
apps/mcp/        Cloudflare Worker: MCP gateway, privacy engine, tools,
                 storage adapter, email ingestion
packages/shared/ types and constants shared across apps
packages/hook/   `npx @context-lc/hook` — the session-end hook that saves a
                 coding session without the agent having to remember to
```

### The gateway (`apps/mcp`)

Originally a single-tenant personal Brain worker; being generalized in place.
Zero npm dependencies — keep it that way. It runs on the Workers runtime, so
use Web Crypto and `fetch`, not Node APIs.

`pnpm test` in `apps/mcp` runs the suite against an in-memory store stub. It is
fast, offline, and currently 546 checks. **Do not let it regress.** If you
change behavior, change the test in the same commit and say why.

The privacy engine (`privacy.md` parsing, `canSee`, `effectiveVisibility`,
folder defaults with exact-note overrides) is proven and load-bearing. Refactor
its *plumbing* freely; changing its *semantics* needs an explicit decision.

## Vocabulary

The user-facing noun is **context**, never "brain". People structure their
context however they like, so a name implying one shape is wrong. Use it in
tool descriptions, UI copy, docs, and new code.

Legacy single-tenant names (`BRAIN` binding, `PRIVATE_TOKEN`) survive only
where they're load-bearing for the original deployment, and should disappear as
code is generalized.

## The workspace model (build this now, it's cheap)

**A workspace is the unit that owns a context.** One workspace, one storage
binding, one privacy manifest, one audit trail.

Everything the product will eventually need is the same object with different
membership:

| Shape                       | What it is                                   |
| --------------------------- | -------------------------------------------- |
| Personal context            | workspace with one member (`owner`)          |
| Someone granting you access | you added as a member of *their* workspace   |
| Shared project context      | workspace with several members, no single personal owner |

Do not model these separately, and in particular:

- **A storage binding belongs to a `workspaceId`, never a `userId`.** Getting
  this backwards makes shared contexts a migration instead of a row.
- **A user belongs to many workspaces**, and an authenticated session resolves
  to a *set* of accessible contexts — even while that set has exactly one
  member today. Do not hardcode one-session-one-bucket anywhere.
- **Membership carries an explicit role.** Read access and write access to
  someone else's context are different grants; write is never implied. Start
  with `owner` | `editor` | `member`, mapping onto the existing
  private/team visibility tiers.
- **Usernames and workspace slugs share one global namespace**, unique and
  stable, with a reserved-word list. Sharing is addressed by name.
- **Audit records the acting identity, not just the scope.** `actorScope:
  "team"` is useless once "team" is four people.

Cross-context paths are addressed `@name/1-projects/foo.md`, where `name` is a
username or workspace slug. A bare path means the caller's own context.

### Deliberately not yet

Do **not** build these; just don't foreclose them:

- **Mounts** — a folder that is really a link to another workspace's bucket
  (`1-projects/thing/` → `@shared-thing`). Falls out of `@name/path` addressing
  plus a stored alias when we want it.
- Federation UI, cross-context search ranking, discovery, org/enterprise
  administration.

## This repository is public and MIT licensed

Open source from the first commit. That raises the bar in three concrete ways:

- **Assume every line is read by an attacker.** No secrets, no internal
  hostnames, no account identifiers, no customer data — not in code, tests,
  fixtures, comments, commit messages, or docs. Fixtures use obviously fake
  values.
- **Security-sensitive code gets adversarial review, not a skim.** Anything
  touching auth, token handling, tenant isolation, path resolution, signature
  verification, or credential storage must be reviewed for what an attacker
  could do with it — and needs a test proving the attack fails.
- **Self-hosting is a supported path, not a courtesy.** Someone must be able to
  clone this, deploy the gateway, point it at their own bucket, and have a
  working context without us. Keep `apps/mcp` dependency-free and its setup
  documented.

Work goes through pull requests. Do not push to `main` — the PR is the record
of what changed and why, and it is what makes the history readable by somebody
who was not here.

**Review is self-review, and merging is yours to do.** Nobody is waiting to
approve; a branch parked green and unmerged is not delivered, it is abandoned.
So a change is finished when it is *merged*, and that means the self-review has
to be real work rather than a formality — you are the only reader the diff will
get before it lands. Read it as an adversary would: what would a reviewer catch,
what does this file's own doc comments claim that the change now makes untrue,
what rule stated elsewhere in this file does it quietly break. Act on what you
find and say what you found; a self-review that finds nothing on a non-trivial
diff is a self-review that did not happen.

Merge only on green CI, and never on red — this is a public repository and the
default branch is what people clone.

## Durable decisions

Things that were argued through once and should not be silently reversed. Each
names what a "simplification" of it would actually cost.

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

### Ingestion is on the apex, which makes the reserved-name list a security control

Capture addresses are `<username>@context.lc`. A user who claimed `support`
would receive mail sent to support@context.lc. The reserved list in
`functions/lib/names.ts` is therefore a mail-interception control, not
cosmetic. RFC 2142 requires `postmaster` and `abuse` stay deliverable to us;
both are asserted separately so a tidy-up cannot drop them.

### Mail lands in a personal context and nowhere else

A shared context has no ingestion address. Not a disabled one, not one awaiting
configuration — mail cannot reach it. A note gets into a shared context only
when a person moves one there, so everything from outside passes through one
accountable owner's hands.

Inbound email is unauthenticated by nature: anyone who learns an address can
send to it, and the only thing between a stranger and a stored note is an
allow-list over a header the sender wrote. Writing into a space several people
read is a different risk from writing into your own. A shared address also
survives its members leaving and produces notes attributable to nobody, and the
sensible default allow-list — the address you signed up with — has no answer at
all for a shared context ("whose email?").

`resolvePersonalContextForIngestion` in `functions/lib/ingestionStore.ts` is the
single place that decides this, and it establishes "personal" structurally
(exactly one member, who is the owner) rather than by trusting the `kind` label.
Every refusal is byte-identical to the one an unclaimed name gets — a rejection
that singled out the shared case would publish which names here are teams.

### Link previews reveal nothing about a context

A crawler is unauthenticated, and Context has no public tier. Every
name-bearing path renders one frozen object — same title, description and
image, canonical pointing at the root rather than the requested URL. Nine
variants are asserted equal by whole response body.

A "nicer" preview showing an owner or a note count would hand anyone in a Slack
channel an existence oracle for usernames, undoing what the control plane's
byte-identical errors exist for.

### Two MCP eras, two lists, and they must never be merged

`2026-07-28` is not an increment on `2025-11-25`. It deletes the `initialize`
handshake, protocol-level sessions, `Mcp-Session-Id`, the GET stream, SSE
resumability and `ping`, and replaces the version counter-offer with an error.
The spec calls the two shapes **modern** and **legacy**; this gateway serves
both, which it can only do because it never had a session to remove.

`src/protocol.js` therefore keeps `MODERN_PROTOCOLS` and `LEGACY_PROTOCOLS`
apart. Sorting them into one array is the obvious-looking tidy-up and is wrong
in both directions:

- **Legacy negotiation may only offer legacy revisions.** A client that sent
  `initialize` has declared it speaks the handshake era; answering it with
  `2026-07-28` names a revision that has no `initialize` in it.
- **Modern negotiation may only offer modern revisions.** `server/discover` and
  the `-32022` error both carry a list the client is expected to *retry with* on
  the path it is already on. A legacy revision there sends it looking for a
  handshake it just declared it is not using.

Negotiation itself is inverted between the two, and implementing it backwards is
the single most common way real MCP servers fail to connect: legacy **must**
counter-offer inside a normal `InitializeResult` and **must not** error; modern
**must** error with `-32022` and `data.supported` and has no result to
counter-offer in.

A revision goes in a list only once its semantics are implemented. Claiming one
we do not speak is worse than lagging, and it is self-detecting: a conformant
client probes, gets an answer that is not modern, and correctly concludes the
server lied.

### Authority is decided once, never per protocol era

`toolsForSession` and `callToolForSession` are the only two places that decide
what a connection may see and do. Both eras call them. A scope check
implemented separately for a new protocol revision is a scope check that will
drift, and the drift would be a privilege escalation reachable by adding one
header to a request. There is a test asserting the read-only filter and the
write gate hold identically on both paths.

### An absent `Origin` is allowed; `null` is not

The transport paths (`/mcp`, `/inbox`) refuse any browser origin not on the
allowlist. Two halves of that are counter-intuitive enough to be "fixed" by
someone tidying up, and each fix is a different disaster:

- **No `Origin` header at all must pass.** Claude Desktop, Codex CLI and the
  SDKs are not browsers and send none. Refusing absence would take down every
  real client while stopping nothing, because the header a browser cannot forge
  is precisely the one an attacker's page always sends.
- **`Origin: null` must not pass.** A sandboxed iframe serializes to the opaque
  origin `null`, so folding it in with "no header" is a one-line bypass an
  attacker can trigger with an `<iframe sandbox>` attribute.

Matching is exact — scheme, host, port, no wildcards — for the same reason
`redirectUriMatches` is. Unset `ALLOWED_ORIGINS` means non-browser clients only,
which is fail-closed and breaks nothing already deployed. See `src/origin.js`.
### The privacy tier is a scope on the grant, never an inference from a role

`visibilityTierForRole(role) => role === "owner" ? "private" : "team"` used to
decide, per request, how much of a context an AI client could see. It meant an
owner could not connect a client at team level: whatever they connected saw
every note they had ever marked private, and no setting, scope, or screen
changed that, because there was nothing to change. The owner of this product
asked for exactly this and there was no answer.

The tier is `context:private`, an ordinary member of `SUPPORTED_SCOPES`,
recorded on the grant and read back by `visibilityTierForGrant(scopes, role)`.
Four things about that are load-bearing:

- **It is the only representation of itself.** No `visibilityTier` column
  beside it. A tier stored twice is a tier that can disagree with itself, and
  the direction that disagreement fails is "an AI client reads more than the
  person allowed".
- **Absence means `team`, and that is the migration.** A grant issued before
  the tier existed carries no `context:private`, so it narrows. Reading an
  unmarked grant as private would leave every pre-feature grant at full access
  forever — on exactly the grants nobody was ever asked about.
- **The role still clamps, and the clamp is not the tier.** Reading the grant
  says what a person chose; the clamp says what their membership can still back
  up. Collapsing the two in either direction restores the old bug or invents a
  new one.
- **The consent screen defaults to `team` for everybody, owners included.** The
  old behaviour was private-by-default with no way out; a switch next to the old
  default would have changed nothing. Approving is opting in.

There are three clamps, at three moments, and they are not redundant:
`applyApproval` decides what may be *written* (a person, in a browser),
`createGrant` re-clamps what the gateway *relays* (a Worker, which may be
compromised or newer than this deployment), and `effectiveScopes` decides what a
*live request* may do (membership can change after both). `functions/lib/consentScopes.ts`
is the control plane's copy of the vocabulary; `apps/mcp/src/session.js` keeps
its own because the gateway is dependency-free, and the mobile screen's mirror
is asserted against the control plane's in `__tests__/consentScopes.test.ts`
rather than claimed in a comment.

Adding a scope means adding it to `SUPPORTED_SCOPES` in `session.js` — which
`oauth.js` imports, so discovery and `/oauth/authorize` validation cannot learn
about it separately. A client that follows discovery to a scope the
authorization endpoint then rejects is a client that concludes the server lied.

### An invitation is addressed to a string, and its token is stored in the clear

Two things about `functions/invitations.ts` look like oversights and are not.

**`inviteMember` never resolves the invitee.** It writes a row addressed to the
`@name` or the email, returns `null`, and finds out who that is only when
somebody accepts. Resolving up front — to store a `userId`, to answer "sent"
versus "no such person", to skip writing a row nobody can answer — turns the
invite box into a name-enumeration endpoint for the whole platform, because the
attacker in this threat model is the *inviter* and anybody with an account has
one. For the same reason `listInvitations` returns pending invitations and
nothing else: a decline, a withdrawal and an expiry must be the same absence, or
saying no tells the sender you exist. The one permitted asymmetry is that
inviting an existing member is a no-op — an owner can already enumerate their
own members.

**The token is not hashed**, which is the opposite of the rule `oauthGrants`
follows, and the difference is that this token is not a bearer credential:
accepting also requires being the addressed identity, so a dump of the table is
inert for anybody who is not already the invitee. Hashing would buy no
confidentiality and would cost the only delivery channel there is —
`listMyInvitations`, the invitee's own query — while nothing here sends email.

Ownership is not transferable. Every context has exactly one `owner`, written by
`createWorkspace`; `inviteMember` and `setMemberRole` both exclude `owner` in
their argument validators, and `removeMember` refuses to delete it. Adding
`owner` to either union would be an ownership transfer with no confirmation and
no way back. `@name` resolving to a person depends on that invariant — a handle
addresses the sole owner of the personal context it names.

### An invitation is delivered, and the delivery is scheduled rather than sent

`inviteMember` mails an `email` invitee a link. Three things about how are
load-bearing, and each undoes a different half of the section above.

**The send is scheduled, never called.** A `ctx.runAction` would hand the
inviter three answers to "does that mailbox exist": a return value, an exception
from Resend, and — needing no API at all — a latency difference between a call
that made an HTTPS round trip and one that did not. `ctx.scheduler.runAfter`
enqueues a job in a separate transaction whose return value is discarded, so
`inviteMember` still returns `null` and still takes the same time. That is what
makes it safe for the *scheduled* job to decide things the mutation never could,
including whether the address already belongs to somebody.

**A `@name` invitee is mailed nothing.** Not a deferred send: we have no
address, and finding one would be resolving an identifier to a person at invite
time, which is exactly what the invite box refuses to do. `listMyInvitations`
stays the channel for a handle and the fallback for every address, because mail
is dropped for an unverified inviter, dropped with no Resend key, sent at most
once per row, and may simply not arrive.

**The emailed link is not the invitation token being used as a credential.** The
token still only addresses the invitation; what signs a recipient in is a
separate `authVerificationCodes` row, minted through `auth:store` and stored as
`sha256(code)`. Making the token itself authenticate would invert the
unhashed-token decision in one step: a forwarded email would hand over an
account. No code is minted for an address whose account already has any
membership; auto-authentication serves the referral path, and the blast radius
of a standing credential in a stranger's empty account is not that of one in an
established member's.

**What bounds that code is single use, not a short clock.** It lives as long as
the invitation it travelled with — seven days — and dies on first claim:
`verifyCodeOnly` deletes the row before validating anything else, and answering
the invitation at all (accept, decline, or the owner revoking it) deletes it too.
So the window is seven days of *unclaimed* link, never seven days of usable
credential.

This was 24 hours, on the reasoning that a link is replayable and forwardable in
a way a typed code is not, so a week of it is a week of a live credential in
other people's archives. That risk is real and was overruled deliberately: at 24
hours the common case is somebody opening on Tuesday an invitation sent on
Sunday, and being asked for a code anyway. A link that expires before its
invitation does is a link that mostly expires, and an invitation that half-works
is the thing this flow exists to remove. Shortening it again without also
changing what "expires on first claim" means would be re-taking a decision
somebody already made with the trade in front of them.

`emailSentAt` is claimed in a transaction *before* the HTTP call, so one row is
one message. At-most-once over at-least-once deliberately: Context mailing the
same person four times because a job retried is indistinguishable, from their
side, from us being the abuse.

**That bounds duplicates and does not bound floods**, which is worth stating
because it read as a fence and was not one. `inviteMember` supersedes an
existing invitation and clears `emailSentAt` — on purpose, since re-inviting
somebody must not be a no-op in their inbox — so a re-invitation mails again,
and the only ceiling was `INVITE_LIMIT`, 20 per hour per account, on free
accounts. What rode on that gap is a subject line: a workspace display name is
80 characters the sender chooses, arriving from our domain with a real app
link beneath it.

So there is a second limit, keyed on the **recipient** rather than the row or
the sender, which is the only key that survives a second offer, a second
inviter, a second workspace and a second account. It is consumed inside the
scheduled action, and *last*, after every other refusal: enforcing it in
`inviteMember` would raise an error at an inviter whose presence depended on
other people's invitations to that address, which is a cross-tenant oracle, and
consuming it earlier would spend budget on mail that was never going to be
sent. The key is a hash of the address — footprint, not confidentiality, since
addresses are guessable.

**The link signs its recipient in, through a second provider, and that
separation is load-bearing.** `@convex-dev/auth`'s `Email()` hardcodes an
`authorize` that refuses any verification without a matching `params.email` —
right for a code typed off a screen, fatal for a link whose premise is that the
URL carries everything. `@supa-media/convex` registers a separate link-only
provider (`MAGIC_LINK_PROVIDER_ID`), which `auth.ts` opts into via `magicLink`.

Clearing the check on the OTP provider instead is one line shorter and would be
a serious regression: the rate-limit key in `verifyCodeAndSignIn` is derived
from `params.email`, so a verification with no email is not rate limited at
all, and the OTP secret is six digits. The separation holds at redemption
because the library resolves which `authorize` to run from the provider
recorded **on the row**, never from what the caller claims — and there is now a
test that redeems a real mailed code with no email and asserts a session, so
losing the override fails CI instead of silently making every link inert.

Sign-in codes for the link are minted by the app, not the library, so
`SIGNIN_CODE_TTL_MS` governs their life and `magicLink.maxAge` does not — see
"The sign-in link's life is `SIGNIN_CODE_TTL_MS`" below.

### The two onboarding gates ask two different questions

They both used to count workspace memberships, and somebody invited into another
person's context broke that rule in both directions at once: before accepting
they had zero, so the `(app)` gate sent them to onboarding and they never saw
the invitation; the moment they accepted they had one, so the welcome gate sent
them to the console permanently, and they could never claim a name or own
anything. Being given a context locked them out of having one.

So the `(app)` gate asks whether there is anything here for you — a context you
can open, or an invitation you can answer — and the welcome gate asks whether
this flow has already run, which is a question about contexts you **own**.
Collapsing them back into one number restores both bugs. `standingFrom` returns
`undefined` unless *both* subscriptions have landed, because a standing built
from a resolved workspace list and an in-flight invitation list reads
`invitations: 0` — the exact shape of "send this person to onboarding".

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

### The visibility tier is displayed, never stored

A person given access to somebody else's context sees only `team` notes, and
that is enforced twice already — `visibilityTierForGrant` in the gateway and
`scopeForRole` in the control plane, both answering "team" for any role that is
not owner before consulting anything else. The console shows it and stores
nothing: a tier stored twice is a tier that can disagree with itself, and the
direction it fails is "an AI client reads more than the person allowed".

The chip lives in the frame beside the storage pill rather than in each pane
head, because the tier is a property of the context you are in rather than of
the route. It is gated on being inside a context while the storage chip is not,
and that asymmetry is deliberate: on an all-contexts route you may hold three
different roles in three contexts, and the wrong direction for one chip to be
wrong in is "you are seeing everything".

The owner's side states the rule and never a count of what is withheld. There
is a note census now (see "The note count is measured" below), and it is
**owner-only for this reason**: it counts every Markdown file in the bucket,
private ones included, so handing it to a member would let them derive exactly
how much they are not being shown — an exact private-note total for a person who
deliberately shared a subset. `getStorageBinding` withholds the three census
fields from anybody whose role is not `owner`, and the console's total treats a
context it cannot count as an unknown, which makes the sum a floor rather than
silently dropping it.

### There is no get-invitation-by-token query, and there must not be one

`acceptInvitation` throws one `INVITATION_NOT_FOUND` for never-issued,
not-yours, already-answered and expired. The invite screen keeps that collapse
structurally rather than by discipline: it looks its token up in the caller's
own `listMyInvitations`, so all four causes arrive as the same absence before
any copy is chosen. The obvious future improvement — a by-token query, for a
faster first paint — would reopen exactly the oracle `invitationNotFound()`
closes.

A failed subscription is the one permitted exception, with its own view. A query
error says nothing about the token, and telling somebody their emailed link is
spent when it is not is unrecoverable — the link is in an email they may never
open again.

### The note count is measured, stamped, and allowed to be a floor

For two issues running (#20, #25) the console printed facts about somebody's
bucket that nothing had measured: "1,284 notes across all", "2.4 GB in your own
bucket", "Reachable — 1,284 objects" — over a live bucket holding six. The fix
then was to delete the tiles, because there was no honest number available. The
tile is back, and four things are what make it safe.

**It counts notes, not objects.** `.history/` on a real context holds every
revision of every file: tens of thousands of objects standing for a few hundred
notes. An object count wearing the label "your notes" is the original bug with
a measurement attached.

**The walk is delimited at the root, then flat inside each real folder.** Not
an optimisation. A flat listing returns `.history/…` first, because `.` sorts
before every digit and letter, so a flat walk with any page budget spends it
inside the history and reports **zero notes for the largest contexts there
are** — the same trap `hasExistingContext` documents, and the first version of
the test for it was vacuous because the seeded history fit inside the budget.
Sabotaging the delimiter is what found that.

**Absent is not zero, at every layer.** `countNotes` returns `null` rather than
throwing or reporting `0`; `recordVerification` leaves the previous count
standing when a probe brings none; `totalNotes` returns `null` when nothing has
been counted and the console renders no tile rather than an em dash. A `0`
anywhere on that path means "this person has no notes", and a listing that
failed partway would be saying it about somebody's life's work.

**A floor is never printed as a total.** The walk is bounded — it runs against
a bucket we do not own, on their request quota — so `noteCountTruncated` travels
with the number, and a total is also a floor when a context that *has* a bucket
has not been walked. Both render `1,284+`. A precise-looking number that is not
the truth is #25 with a measurement in front of it.

`noteCountedAt` is stored separately from `lastVerifiedAt` for the same family
of reasons: a verification can succeed and learn nothing about the contents, and
dating a stale count from a fresh probe is a quieter version of inventing it.
Nothing re-counts on a schedule, so the storage card prints the count's own date
beside it rather than letting a months-old number read as current.

Three more places the absence has to survive, each of which was wrong first:

- **A rebind clears it.** A rebind points at a different bucket, so a count
  carried across is a number about somewhere else. Left standing it produced
  `status: "error"` beside a confident total for a bucket nothing had reached.
- **Loading is not "no bucket".** `totalNotes` takes the binding, `null` for a
  context with no bucket, and `undefined` for one whose query has not landed.
  Collapsing the last two made every first paint print an *exact* total that
  was missing a whole bucket's notes.
- **The status write does not wait on the walk.** `recordNoteCount` is its own
  internal mutation, called after `recordVerification`. Folded together, up to
  forty sequential LIST round trips sat inside the window where the binding
  still read `unverified`, and an action that died mid-walk left a good bucket
  permanently unverified over a number nobody was waiting for.

And one thing a single `try` got wrong: the folder prefixes fed back into
`store.list` are **names the customer chose**, and the adapter's
`assertSafePrefix` throws on a backslash, a control character or a `.`/`..`
segment. Under one outer catch, a single oddly named folder silently suppressed
the count for that whole bucket forever. Each folder is walked in its own `try`
now, and one that will not walk makes the total a floor.

### The sign-in link's life is `SIGNIN_CODE_TTL_MS`, and never `magicLink.maxAge`

`auth.ts` sets `magicLink: { maxAge: 60 * 60 }` while the link is good for the
invitation's seven days. Both are correct, and the obvious reading — that the
provider's `maxAge` is the link's expiry, so the two contradict each other — is
wrong. An earlier comment in `auth.ts` believed it, and "aligning" them is the
tidy-up to expect.

`@convex-dev/auth` reads `maxAge` in exactly one place, `signIn.js`, and only
where the **library** generates the code. Redemption checks the row instead
(`verifyCodeAndSignIn.js`: `verificationCode.expirationTime < Date.now()`).
`functions/invitationEmail.ts` mints its own code and passes its own
`expirationTime`, so `maxAge` never touches the invitation link at all.
Verified rather than argued: with `maxAge` set to **one second** the whole suite
still passes, including the seven-day expiry assertion. A test pins this.

What `maxAge` does bound is the one path that reaches this provider without
going through us. `api.auth.signIn` is public, so anybody can call
`signIn("magic-link", { email })` for an address they do not own. Nothing
reaches them — no `sendVerificationRequest` is configured, and a configured one
would mail the address that was named — but the code it mints is real, and this
is the provider with no email check and no rate limit. An hour is the shortest
useful life for it. **Setting it to seven days to "match" the invitation
lengthens only that code and buys the link nothing.**

### Orientation is the front door, and `index.md` is the part we do not generate

A context nobody's agent reads is worth nothing, and the first version of this
gateway lost that fight quietly: clients connected, never called `orient`, never
wrote anything back, and the owner concluded the product did not work. The fix
is not one lever. There are three surfaces and they act at three different
moments, and only the first two decide whether a tool is *reached for at all*:

- **Connect** — the `instructions` payload (legacy `initialize`, modern
  `server/discover`). Read once, sits in the system prompt for every
  conversation, and reaches the model before it has decided anything.
- **Decision** — the tool descriptions in `tools/list`, present every turn, for
  every client. A description that explains mechanics ("List note paths,
  optionally under a folder prefix") tells a model how a tool works and gives it
  no reason to believe the user's question is answered inside. They are written
  in the language of the user's intent for that reason.
- **Result** — text appended to tool output. Only ever reaches an agent that
  already called something.

**There is deliberately no "you have not oriented yet" banner**, though it is
the obvious next idea and the only mechanically enforceable one. It would live
at *result* time, which is the moment least related to the failure, and it needs
per-grant state to avoid becoming noise — and a grant is a **connection, not a
conversation**. One desktop client holds one grant for weeks, so "already
oriented" would need an invented TTL and would stay silent for exactly the fresh
chat worth catching. It buys a Convex schema change and a write on the hot path
to solve the least of the three problems.

`orient` itself leads with the person's context and ends with the rules. It used
to open with twenty-five lines of visibility governance handed to an agent that
had not yet been given one reason to care, which is a document to comply with
rather than a context to explore.

**`index.md` is the one part of orientation we never generate.** Everything else
— folder map, counts, recency — is derived and rebuilt per call. The front page
is an ordinary root note the customer writes, edits in Obsidian, and owns; it is
in the stable on-bucket layout above. Absent, `orient` says so and says what it
is for. Generating a plausible one instead would be the product inventing the
one thing only its owner can say.

**Who may write the front page is settled, and it is not "whoever asks".** The
onboarding seed prompt tells a connected client outright not to touch
`index.md`, because `write_note` only checks an etag when one is supplied and a
client told to write "who I am" would replace the scaffolded manifest with a
biography on its first call. The orientation contract does ask agents to keep it
current, and the two are reconciled rather than left to collide: read it, pass
its etag, add to what is there, say what is changing first, never replace it
wholesale. Loosening that to "keep index.md up to date" is one sentence shorter
and hands every connected client a wholesale overwrite of the one file the whole
orientation is built on.

Three properties of the survey are load-bearing:

- **Every count counts only what this connection can see.** Counting hidden
  notes would let a colleague subtract and derive an exact private-note total
  for the person who withheld them — what the console's census is owner-only to
  prevent.
- **Two listings per folder, answering different questions.** Delimited names
  every subfolder; a bounded flat walk counts and dates them. Deriving the map
  from the walk alone is simpler and drops the siblings of one huge folder off
  the map entirely — for precisely the people with the most in here. Anything
  the walk could not reach is a floor (`5000+`), never a total, and a recency
  list built from a partial walk says that it is.
- **The connect-time sketch fails soft, always.** A slow bucket, a revoked key,
  a `privacy.md` somebody broke in Obsidian: none of them may take down a
  handshake. A client that gets the static instructions is fully working and
  merely less curious. Note that a thrown handler is answered with a JSON-RPC
  error over HTTP 200, so "the handshake returned 200" does not test this.

### The hook is a capture-only OAuth client, and that is the whole design

An agent can call `save_context` when it finishes, and the failure mode is not
refusal — it is a long session that ends without one, where the thing worth
keeping was in the part nobody wrote down. The hook is the safety net, and
because it runs unattended it is the one credential in this system that sits on
somebody's laptop indefinitely.

So it asks for `context:capture` and nothing else. That grant writes to
`0-inbox/` and **cannot read a single note** — no search, no listing, no
existence oracle. The obvious upgrade, `context:write`, would let the hook
honour the user's own save destination instead of always landing in the inbox,
and it would also mean a stale credential on an old laptop can read every
private note its owner has ever written. That trade only goes one way, and a
capture landing in `0-inbox/` is not even a compromise: it is what that folder
is for.

It authenticates with the ordinary authorization-code flow over a loopback
redirect, which the gateway already supported — `redirectUriMatches` implements
the RFC 8252 §7.3 port exception precisely so native clients can do this. The
three alternatives were considered and are worse: a dashboard-minted long-lived
token is a bearer secret with no client identity behind it, so revoking it is
all-or-nothing; reusing the token the AI client already holds would require
reading another application's credential store; and token-in-URL is already the
compatibility fallback and never the boundary.

Each machine registers its own client, so revoking the laptop you lost does not
sign out the one on your desk.

**The capture boundary is an allow-list, and it is the most security-sensitive
code in the package.** A session log holds the system prompt, the model's
reasoning, every tool call and result, and the contents of files read along the
way. A message travels only if its role is `user` or `assistant` *and* its
content block is declared `type: "text"`. Switching on the declared type rather
than reaching for any `.text` present is what stops a `tool_result` — whose
nested blocks also have a `.text` — from being posted; the fishing version
passes every test written with plain string messages, which is why the suite
seeds a log carrying six distinct marker strings and asserts each one absent.

**The session-start hook is where the scope question actually bites.** Claude
Code injects a `SessionStart` hook's output into the session before the first
turn, which is the only mechanism anywhere in this product that does not depend
on an agent deciding something — and it is therefore the strongest available
answer to "connected agents never call `orient`". Fetching a real orientation
needs read access, on the credential that sits unattended on a laptop, so there
are two versions and the default is the narrow one: capture-only injects an
instruction to call `orient`, and `--orient` injects the orientation itself.

Three things hold that line. The wider mode is a flag somebody types, never a
default they discover afterwards. A change of scope **re-registers the client**
rather than re-authorizing the one that declared it wanted less. And neither
mode ever requests `context:private` — a hook that could read every note its
owner marked private is past what any convenience is worth, and the cost is
paid honestly: on a mostly-private context the injected orientation is thin and
says so.

Both hooks fail towards doing nothing loudly rather than something wrong
quietly. The start hook runs before the person has typed anything, so a revoked
grant, a slow gateway or a capture-only credential all come out as the
directive, and a capture-only install does not even spend the request finding
out it cannot read.

**A hook is only offered for a client whose contract can be read rather than
guessed** — and the first version of that list was wrong, in a way worth
recording because the error was not in the rule.

It said Claude Code was the only client with a documented end-of-session hook.
That was **asserted from memory and never checked**, and it is false: Codex CLI
and Gemini CLI both ship hook systems of the same shape — a command per
lifecycle event, `session_id`/`transcript_path`/`cwd` on stdin, and an
`additionalContext` field at session start. The claim shipped into a doc
comment, a README, a console string and this file before a question caught it.
Never state what another product does or does not support without looking; a
confident sentence about somebody else's software is the cheapest thing here to
get wrong and the most expensive to notice.

The rule itself survives intact, and still excludes two: **Cursor** has hooks
(`beforeSubmitPrompt` … `stop`) but publishes no transcript path, so the capture
half has nothing to read; **hosted ChatGPT** has no hook system at all. A hook
that silently never fires is worse than no button, because the person believes
their sessions are being saved and finds out months later that none were.

Three details differ between the three that are supported, and all three are
places to be careful: the file (`~/.claude/settings.json`, `~/.codex/hooks.json`,
`~/.gemini/settings.json`); what the end of a session is called (Codex says
`Stop`); and **the unit of `timeout` — seconds for Claude Code and Codex,
milliseconds for Gemini CLI**. The installer writes no timeout at all rather
than carry a number that means two different things depending on where it lands.

It also writes **no property outside the client's own schema.** An earlier
version stamped a marker key onto its hook entry to recognise it later; that is
an unknown field inside somebody else's config, across three parsers whose
strictness we cannot test, and the cost of being wrong is their whole settings
file failing to load. Our entries are identified by the command string instead —
still recognised on read, so an upgrade replaces an old marked entry rather than
stacking a second one beside it.

### A guard nobody has checked is not a guard

Three times now a protection has been weaker than it looked: a credential check
that grepped export names (defeated by a rename in a new file), an isolation
claim that inverted without breaking a test, and an import guard that read
English prose as code. Every guard here should have a test proving it catches
what it claims — and where practical, a self-test proving the checker itself
works.

Sabotage-test rather than trusting a green run: break the invariant deliberately
and confirm the right tests fail.

## Engineering standards

- **Test-first.** Write the failing test, then the code. Tenant isolation,
  authorization scopes, etag conflicts, storage failures, ingestion
  idempotency, and revocation all need real coverage.
- **Small, tested increments.** Atomic commits; describe *why*.
- **No secrets** in source, Markdown, logs, URLs, or customer buckets.
- **Structured logs** carry request, workspace, and grant identifiers — never
  secrets, never note content.
- **Conflict-safe writes.** Reads return a version; writes pass it back. R2
  supports `onlyIf: { etagMatches }` natively and AWS S3 supports conditional
  `If-Match` writes; **B2 and Wasabi do not reliably.** Probe capability at
  connect time and degrade honestly — never silently drop conflict detection.
- **Never weaken** customer-owned storage, plain-file portability, privacy,
  tenant isolation, or revocability to move faster. Raise it instead.

## Working style

- Ask all questions up front, then execute.
- Surface architectural decisions rather than making them silently. Especially:
  auth provider, billing, retention defaults, attachment policy, index
  location, client compatibility targets.
- Leave the code better than you found it, and update this file when a
  durable decision lands.

## Stack

- **Control plane**: Convex (`@convex-dev/auth`, email OTP via Resend)
- **Gateway**: Cloudflare Workers + R2/S3 via the storage adapter
- **Mobile/web app**: React Native + Expo, Expo Router
- **Ingestion**: Cloudflare Email Routing → Email Worker → `0-inbox/`
- **Framework**: [supa-framework](https://github.com/Supa-Media/supa-framework)
  (`@supa-media/*` from GitHub Packages; needs a `read:packages` token)

Upstream-first: if a change is generic, it belongs in supa-framework, not here.
