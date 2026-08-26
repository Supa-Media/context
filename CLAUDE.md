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
  audit trail, ingestion alias, and connector grants.
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
fast, offline, and currently 168 checks. **Do not let it regress.** If you
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
