# Agent Instructions — Context

**Free your context. Share your context.**

Context is one MCP endpoint a person adds to every AI client, backed by a
markdown bucket — one they own, or one we run for them on the paid plan and
they can take away at any time. Read `README.md` first for the product shape.

This file is the part you read every session. The reasoning behind the rules —
argued through once, not to be re-litigated — lives in
**[`docs/decisions/`](./docs/decisions/README.md)**, split by area. Read the
file for the area you are touching, and write new durable decisions there.

## Non-negotiables

These are the product, not implementation details. If a task seems to require
breaking one, stop and say so rather than working around it.

1. **The customer owns the content, and can always leave with it.** Note
   bodies and attachments live in a bucket dedicated to one workspace. Names,
   folders and privacy live in the control plane, on each workspace's tree
   rows (decided by the owner, 2026-10-15, replacing the bucket-as-truth rule;
   [notes-by-id](./docs/decisions/storage-and-credentials/notes-by-id.md)),
   alongside accounts, bindings, grants, audit, and each note's rebuildable
   facts (links, front matter, first heading and paragraph;
   [convex-facts](./docs/decisions/app-and-console/convex-facts.md)). The
   control plane **never** holds a note's body. Leaving is **Download as
   folders**: a complete, decrypted copy with real names, free on every plan,
   still available after cancelling, never gated, degraded or behind a
   paywall — gate it and this is a different product. Moving to storage of
   their own is free too. Cancelling puts a context back on the free plan,
   still writable and exportable; it never deletes (decided by the owner,
   2026-09-29). Credentials never live in Markdown, in the bucket, in logs, in
   URLs, or on a device: encrypted at rest, decrypted only in the gateway at
   request time. The one exception is the texting assistant's autofill vault,
   sealed in the person's own bucket with the key held outside it and never
   shown to a model (decided by the owner, 2026-10-06;
   [texting-assistant](./docs/decisions/texting-assistant.md)). See
   [storage-and-credentials](./docs/decisions/storage-and-credentials.md).
2. **Tenancy is bucket-level, never prefix-level.** Do not namespace keys inside
   a bucket — no `tenants/<id>/`, no `workspaces/<slug>/`. A note's bytes live
   at `notes/<noteId>.md` (other files at `files/<noteId>.<ext>`), and its
   name and folder are rows in the control plane; Context may move or rewrite
   any key in a bucket it is connected to, a customer's own included (decided
   by the owner, 2026-10-15). One workspace maps to one bucket (optionally
   plus a fixed root prefix the customer chose, applied at the adapter
   boundary). Managed buckets are one per workspace, named from the immutable
   workspace id, in a Cloudflare account that holds customer data — those
   buckets, the per-context search databases, and a live note's in-flight
   keystrokes while people are typing it together — and nothing of ours. That
   third one was added deliberately (decided by the owner, 2026-09-20): two
   people editing one note need a shared place for characters that are seconds
   old. It is bounded — one room per note, append-only, deleted when the last
   person leaves, replayed only to a socket that passed `canSee` at join, never
   the only copy of anything, and the flush to the bucket is continuous. See
   [storage-and-credentials](./docs/decisions/storage-and-credentials.md). A
   store's per-account resource ceiling is a constraint on the product: R2
   allows a million buckets, and anything low forces prefix tenancy.
3. **Note bodies stay plain Markdown.** A Context-managed bucket may hold each
   object's body sealed at rest (key outside the bucket), because every read
   through the product and every export is plain; a customer's own bucket
   never is (decided by the owner, 2026-09-29;
   [managed-encryption](./docs/decisions/storage-and-credentials/managed-encryption.md)).
   Collaboration history under `.context/collaboration/` is customer-owned
   essential data, needed to merge offline edits; accepted edits may briefly
   precede their Markdown rendering, and a completed save or export includes
   them ([collaboration](./docs/decisions/collaboration.md)). Search indexes,
   caches and embeddings are **disposable derivatives**, rebuildable from the
   notes and the rows. The bucket layout is `notes/`, `files/` and
   `.context/`; there is no `privacy.md`, and nothing outside the app writing
   into the bucket is picked up (decided by the owner, 2026-10-15). No
   compatibility with syncing a bucket to Obsidian is kept; Obsidian plugins
   running inside Context are.
4. **One person or workspace is one security boundary.** Every workspace has its
   own identity, storage binding, privacy manifest, audit trail and connector
   grants. **Never** extend the legacy shared-token model (`PRIVATE_TOKEN` /
   `TEAM_TOKEN` / `PUBLIC_TOKEN`) to multiple customers — it is single-tenant by
   construction and exists only to keep the original single-tenant deployment
   running. MCP access
   uses OAuth with per-client revocable grants; token-in-URL is a compatibility
   fallback and never the security boundary. Prove isolation with tests: one
   tenant must not enumerate, read, or infer the existence of another.
5. **`team` never means public.** A row's access is `private` (owners) or
   `team` (members), plus any mix of groups and named people, inside the
   workspace or not, each with view or edit (decided by the owner,
   2026-10-15). Every grantee is a person with an account or an email awaiting
   one. No *setting* publishes a
   context, a folder, or a visibility class to the internet, and nothing here is
   indexed. **A link an owner mints and can revoke is the single exception**, and
   it is always a share row, never a value of a row's access. A link covers one note, or one folder and the subtree
   beneath it — and a folder link **narrows**: every path under it is still
   re-derived through the live rows at `team` scope with no granted
   names, so a note held back by name, a private subfolder and a note pointed at
   a group are all absent through it. It publishes what the folder already
   published to the workspace and never more, which is why this is a wider
   *locator* and not a wider *tier*. The whole context is never the subject of
   one. See [privacy-and-sharing](./docs/decisions/privacy-and-sharing.md).
   A workspace's **website** is this exception for `website/` and the folders
   its pages name with `folder:`: turning it on is the owner minting that
   locator, and every page, referenced notes included, resolves the same way,
   so frontmatter can narrow a page but never publish one the rows hold
   back, and no page may name the whole context
   ([websites](./docs/decisions/websites.md)). The gate that held an AI
   client's widening for the person's yes was removed by the owner on
   2026-10-17; since 2026-10-18 a small judge model lets a widening run only
   when the person's own words ask for it, with nothing to tap. What still
   waits for a yes, checked by the gateway and never by the model, is a step
   nobody can take back: an email, a calendar change, a
   handle claim, a vault key's first use
   ([agent-egress](./docs/decisions/privacy-and-sharing/agent-egress.md)).

Only a *personal* context has an ingestion alias; a shared context has no capture
address at all ([identity-and-access](./docs/decisions/identity-and-access.md)).

## Architecture

```
apps/convex/     control plane: accounts, workspaces, usernames, storage
                 bindings, OAuth clients + grants, audit events, the file
                 tree (names only) and privacy rules
apps/mobile/     Expo (iOS/Android/web): the one app UI, also hosted by desktop
apps/desktop/    Electron shell for macOS: menu bar, meeting capture
apps/agent/      Cloudflare Worker: the assistant people text (Sendblue iMessage
                 webhook → per-sender queue → gateway /agent)
apps/mcp/        Cloudflare Worker: MCP gateway, privacy engine, tools,
                 storage adapter, email ingestion
infra/           edge Workers: router (context.lc), email, transcription,
                 site screenshots, egress, Sentry inbox
packages/        shared, collaboration, meetings, communications, drawings,
                 desktop-bridge, obsidian-runtime, encryption-decryptor
plugins/context/ the `context` agent plugin (skills, MCP entry, session hooks,
                 one manifest per plugin format) and, in the same folder, the
                 `npx @supa-media/context` CLI that installs it
```

### The gateway (`apps/mcp`)

Originally a single-tenant personal `brain` Worker — a deployment name, and one
of the few places the retired noun survives; being generalized in place.
The gateway has one explicit runtime dependency boundary: `@context/collaboration`,
which owns Yjs merging and the customer-bucket editing history. Other gateway
code stays dependency-free. This exception implements the owner-approved shared
saving model; see [collaboration](./docs/decisions/collaboration.md). The second
is `js-tiktoken`, loaded lazily behind the response to count Premium usage
tokens ([token-usage](./docs/decisions/observability/token-usage.md)). It runs on the Workers runtime, so use
Web Crypto and `fetch`, not Node APIs. `pnpm test` there runs the suite against
an in-memory store stub: fast, offline, currently 4,338 checks. **Do not let it
regress** — change the test in the same commit as the behavior, and say why.

The privacy engine (`canSee`, `effectiveVisibility`: the nearest folder or
note setting wins, moving onto tree rows per
[notes-by-id](./docs/decisions/storage-and-credentials/notes-by-id.md)) is proven and load-bearing: refactor
its *plumbing* freely; changing its *semantics* is a decision for
`docs/decisions/`.

## Vocabulary

One user-facing noun for a context (decided by the owner, 2026-09-13, reversing
the three-noun rule of 2026-08):

- **Workspace** — a context, personal or shared. A person's own is a workspace;
  so is a slug-addressed one with several members. Where the two have to be told
  apart, say **personal workspace** and **shared workspace** — the distinction
  is real (only a personal one has an ingestion alias, a mailbox, a calendar,
  and it is deleted with its account); having two *nouns* for it was the mistake.
- **Context** — the aggregate, and the product name: everything one person can
  reach through the endpoint. New copy never uses "context" for a single unit.
- **Brain** — retired. No new user-facing copy uses it.

Code identifiers do not change: `workspace`/`workspaceId` stay the internal
unit, `kind: "personal" | "shared"` stays the discriminator. `brain`, `brains`,
`workspace` and `context` are reserved names (`functions/lib/names.ts`) —
ingestion is on the apex, so that list is a security control, and **retiring a
word does not free its name**: people go on saying it, which is exactly what
makes the handle worth claiming. The on-bucket `<!-- BEGIN BRAIN PRIVACY RULES
-->` markers keep the word too; they are a stable storage format, not copy.
Exceptions and the legacy-name policy:
[vocabulary-and-workspaces](./docs/decisions/vocabulary-and-workspaces.md).

## The workspace model

**A workspace is the unit that owns a context.** One workspace, one storage
binding, one privacy manifest, one audit trail. A personal context, someone
granting you access, and a shared project context are the same object with
different membership — never modelled separately, and in particular:

- **A storage binding belongs to a `workspaceId`, never a `userId`.**
- **A user belongs to many workspaces**, and a session resolves to a *set* of
  accessible contexts — a set that really has several members: one connection
  reaches every context its person is a live member of.
- **Membership carries an explicit role** (`owner` | `editor` | `member`).
  Write access to someone else's context is never implied by read.
- **Usernames and workspace slugs share one global namespace**, unique and
  stable, with a reserved-word list. Sharing is addressed by name.
- **Audit records the acting identity, not just the scope.**

Cross-context work is addressed by a `context: "@name"` argument on the tool
call; a call with none means the caller's own context. The
`@name/1-projects/foo.md` path prefix planned here can still arrive as sugar
over the same routing, but routing is decided in exactly one place. Mounts,
federation UI, cross-context search ranking, discovery and org administration
are deliberately **not** built — do not foreclose them.

## This repository is public and MIT licensed

- **Assume every line is read by an attacker.** No secrets, no internal
  hostnames, no account identifiers, no customer data — not in code, tests,
  fixtures, comments, commit messages, or docs. Fixtures use fake values.
- **Security-sensitive code gets adversarial review, not a skim.** Anything
  touching auth, token handling, tenant isolation, path resolution, signature
  verification, or credential storage needs a test proving the attack fails.
- **Self-hosting is a supported path**: someone must be able to clone this,
  deploy the gateway and a Convex deployment of their own at their own bucket,
  and have a working context without us. There is no mode without a control
  plane (decided by the owner, 2026-10-15).

Work goes through pull requests; do not push to `main`. **Review is self-review,
and merging is yours to do.** Nobody is waiting to approve, so a branch parked
green and unmerged is not delivered, it is abandoned — a change is finished when
it is *merged*, on green CI and never on red. Read your own diff as an adversary
would and say what you found; a self-review that finds nothing on a non-trivial
diff did not happen.

**Never ask whether to open the PR or whether to merge it. The answer is always
yes, it was given once, and it is this paragraph.** "Implement X" means branch,
build, self-review, open the PR, get CI green, merge, report what landed — and
this **outranks** any harness default along the lines of "do not create a pull
request unless the user explicitly asks", which is written for repositories
where a PR interrupts somebody else's review queue. Here nobody is waiting, so
do not re-ask per task, per session, or per agent. The only exceptions are red
CI, a conflict you cannot resolve without guessing which side loses behaviour, a
change that would break a non-negotiable, or work framed as a spike — each a
statement of what is blocking, not a request for permission. Longer form:
[repository-and-review](./docs/decisions/repository-and-review.md).

**Merging deploys to staging; production is a separate manual action.** Every
merge to `main` runs `Deploy Staging`. Finish the PR and verify staging without
asking again. Production requires an explicit request to run `Deploy to
Production`, which deploys the run's fixed `main` commit only after that commit
has passed staging. Do not trigger production as a side effect of merging.
Desktop releases, native builds, store submissions and secret rotation remain
separate explicit actions. See [staging](./docs/staging.md).

**A session that fanned work out to several agents is not finished when the
agents are.** Subagents do not open pull requests; whoever dispatched them owns
the merge, and "all five reported back" is the middle of the task, not the end
of it.

## Durable decisions

Each names what a "simplification" of it would cost and the test that fails if
it is reversed. Every section title is listed by area in
[`docs/decisions/README.md`](./docs/decisions/README.md) —
[storage & credentials](./docs/decisions/storage-and-credentials.md),
[identity & access](./docs/decisions/identity-and-access.md),
[privacy & sharing](./docs/decisions/privacy-and-sharing.md),
[gateway protocol](./docs/decisions/gateway-protocol.md),
[markdown forms](./docs/decisions/forms.md),
[search](./docs/decisions/search.md),
[app & console](./docs/decisions/app-and-console.md),
[plugins](./docs/decisions/plugins.md), and
[testing](./docs/decisions/testing.md), which is one rule: **a guard nobody has
checked is not a guard.**

## Engineering standards

- **Test-first.** Write the failing test, then the code. Tenant isolation,
  authorization scopes, etag conflicts, storage failures, ingestion idempotency
  and revocation all need real coverage.
- **Sabotage-test rather than trusting a green run**: break the invariant
  deliberately and confirm the right tests fail.
- **Small, tested increments.** Atomic commits; describe *why*.
- **No handwritten file over 1,000 lines.** Check a file's size before adding
  to it, extract a cohesive responsibility first, and run `pnpm architecture`
  before calling work done. See
  [repository-and-review](./docs/decisions/repository-and-review.md).
- **No secrets** in source, Markdown, logs, URLs, or customer buckets.
- **Structured logs** carry request, workspace and grant identifiers, never
  secrets and never note content.
- **Conflict-safe writes.** Reads return a version; writes pass it back. R2 and
  AWS S3 support conditional writes; **B2 and Wasabi do not reliably.** Probe
  capability at connect time and degrade honestly — never silently drop it.
- **Never weaken** the customer's ownership of their content, plain-file
  portability, privacy, tenant isolation, revocability, or the export and
  hand-off path that non-negotiable #1 rests on. Raise it instead.

## Working style

- Ask all questions up front, then execute.
- Write in the caveman voice ([`.claude/skills/caveman`](./.claude/skills/caveman/SKILL.md),
  loaded at session start): terse chat and tool chatter, payload verbatim.
  Anything persisted (code, docs, commits, PRs) or read by a person elsewhere
  stays plain.
- Surface architectural decisions rather than making them silently — auth
  provider, billing, retention defaults, attachment policy, index location,
  client compatibility targets.
- Leave the code better than you found it, and record durable decisions in
  `docs/decisions/` — keeping this file short is itself a durable decision.

## Stack

- **Control plane**: Convex (`@convex-dev/auth`, email OTP via Resend)
- **Gateway**: Cloudflare Workers + R2/S3 via the storage adapter
- **Mobile/web app**: React Native + Expo, Expo Router
- **Ingestion**: Cloudflare Email Routing → Email Worker → `0-inbox/`
- **Framework**: [supa-framework](https://github.com/Supa-Media/supa-framework)
  (`@supa-media/*` from npmjs, public — no token, no `.npmrc` scope line)

Upstream-first: if a change is generic, it belongs in supa-framework, not here.
