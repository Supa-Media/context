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
  `privacy.md` at root, `.history/`, `.audit/`, PARA folders. Treat changes to
  it as breaking changes.

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
```

### The gateway (`apps/mcp`)

Originally a single-tenant personal Brain worker; being generalized in place.
Zero npm dependencies — keep it that way. It runs on the Workers runtime, so
use Web Crypto and `fetch`, not Node APIs.

`pnpm test` in `apps/mcp` runs the suite against an in-memory store stub. It is
fast, offline, and currently 408 checks. **Do not let it regress.** If you
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

Work goes through pull requests with review. Do not push to `main`.

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
