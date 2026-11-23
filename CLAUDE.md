# Agent Instructions — Context

**Free your context. Share your context.**

Context is one MCP endpoint a person adds to every AI client, backed by plain
Markdown notes kept in one Durable Object per workspace, which they can take
away at any time as folders. Read `README.md` first for the product shape.

This file is the part you read every session. The reasoning behind the rules —
argued through once, not to be re-litigated — lives in
**[`docs/decisions/`](./docs/decisions/README.md)**, split by area. Read the
file for the area you are touching, and write new durable decisions there.

## Non-negotiables

These are the product, not implementation details. If a task seems to require
breaking one, stop and say so rather than working around it.

1. **The customer owns the content, and can always leave with it.** A
   workspace's note bodies, its editing history, its tree rows (names,
   folders, privacy, grants and shares) and its access rules live in its
   **workspace object**: one Durable Object per workspace, which answers a
   read with the permission check and the text in one call (decided by the
   owner, 2026-11-01, replacing bodies-in-the-bucket and rows-in-Convex;
   [workspace-objects](./docs/decisions/storage-and-credentials/workspace-objects.md)).
   Pictures and other files live in a files bucket of the workspace's own,
   pictures compressed and PDFs and audio as they are. Every save is also
   written behind to the workspace's managed bucket, a backup copy that no
   request reads. Until a workspace's reads are switched over (`home`:
   `bucket` | `dual` | `object`), its bodies stay in the bucket and its rows in
   the control plane ([notes-by-id](./docs/decisions/storage-and-credentials/notes-by-id.md)).
   The control plane keeps accounts, usernames, sign-in, AI client grants,
   billing, audit, a "shared with me" index and, only for a workspace not yet
   on its object, each note's rebuildable facts (links, front matter, first
   heading and paragraph;
   [convex-facts](./docs/decisions/app-and-console/convex-facts.md)); a
   workspace object keeps its own notes' facts beside their text, every
   reader (gateway and app) reads them there, and the control plane keeps no
   copy for it (decided by the owner, 2026-11-02;
   [facts-in-objects](./docs/decisions/storage-and-credentials/facts-in-objects.md)).
   The control plane **never** holds a note's body. Leaving is **Download as folders**: a complete, decrypted copy with
   real names, free on every plan, still available after cancelling, never
   gated, degraded or behind a paywall — gate it and this is a different
   product. Bring-your-own bucket is retired: nobody new connects one (decided by the
   owner, 2026-11-01); a workspace already on one stays supported, on its
   workspace object like any other, its bucket kept whole as the copy every
   save is written behind to (decided by the owner, 2026-11-22). Cancelling puts a context back on the free plan, still
   writable and exportable; it never deletes (decided by the owner,
   2026-09-29). Credentials never live in Markdown, in an object or bucket, in
   logs, in URLs, or on a device: encrypted at rest, decrypted only in the
   gateway at request time. The one exception is the texting assistant's
   autofill vault, sealed in the person's own storage with the key held
   outside it and never shown to a model, and its browser's sign-ins kept the
   same way and, first, in one saved Browserbase profile per person or group
   chat, which the control plane deletes there with the account, the
   workspace or "sign Tex out"; export carries the sealed copy (decided by
   the owner, 2026-10-06, 2026-10-20 and 2026-10-29;
   [texting-assistant](./docs/decisions/texting-assistant.md)). A group
   chat's memory is the other: its home is in `@context-lc` under
   `tex/groups/`, sealed so no role there opens it, an owner's included, only
   the chat's people (decided by the owner, 2026-10-31;
   [chat-homes](./docs/decisions/texting-assistant/chat-homes.md)). Tex's
   own notes are the third: each keeps its tree row, marked as living in
   Tex's store, which holds its text, read, searched and exported like any
   note: a person's in their personal workspace's own object, in tables of
   its own, and a group chat's in a Tex Durable Object of its own (decided by
   the owner, 2026-10-31 and 2026-11-02;
   [tex-durable-objects](./docs/decisions/texting-assistant/tex-durable-objects.md)). A
   workspace's storage binding and data key are the fourth: its own workspace object keeps
   them sealed with a key only the gateway derives, bound to that workspace and
   handed only to its live members (decided by the owner, 2026-11-02;
   [credential-basics](./docs/decisions/storage-and-credentials/credential-basics.md)). See
   [storage-and-credentials](./docs/decisions/storage-and-credentials.md).
2. **Tenancy is object-level and bucket-level, never prefix-level.** One
   workspace has one workspace object, named `workspace:<workspaceId>` from
   the immutable id, and its own buckets; never two workspaces in one object
   or one bucket, and no `tenants/<id>/` or `workspaces/<slug>/` keys. Inside,
   a note's bytes are `notes/<noteId>.md` and its history is under
   `.context/collaboration/`; files are `files/<noteId>.<ext>` in the files
   bucket; names and folders are rows. Context may move or rewrite any key it
   holds (decided by the owner, 2026-10-15). **Where each runs:** a Durable
   Object answers only to Workers in its own Cloudflare account, so the
   workspace objects, Tex's objects and the live-typing rooms run in the
   gateway's account, placed with the location hint `enam` (decided by the
   owner, 2026-11-01); the boundary between workspaces there is the object,
   never a shared one. The
   customer-data account holds the buckets (files and backup copies) and the
   per-context search databases, and nothing of ours: no Worker, queue or
   bucket of our own state
   ([managed-storage](./docs/decisions/storage-and-credentials/managed-storage.md)).
   The live-typing rooms stay bounded (decided by the owner, 2026-09-20): one
   room per note, append-only, deleted when the last person leaves, replayed
   only to a socket that passed `canSee` at join, never the only copy of
   anything, and the flush to the note is continuous. See
   [storage-and-credentials](./docs/decisions/storage-and-credentials.md). A
   store's per-account ceiling is a constraint on the product: R2 allows a
   million buckets, and anything low forces prefix tenancy; one object holds
   at most 10 GB, so a workspace that would not fit is held back and named,
   never cut short.
3. **Note bodies stay plain Markdown.** A workspace object stores each body as
   its Markdown (Cloudflare encrypts Durable Object storage at rest); the
   backup copy in a managed bucket may be sealed at rest with the key outside
   the bucket, because every read through the product and every export is
   plain (decided by the owner, 2026-09-29;
   [managed-encryption](./docs/decisions/storage-and-credentials/managed-encryption.md)).
   Collaboration history under `.context/collaboration/` is customer-owned
   essential data, needed to merge offline edits; accepted edits may briefly
   precede their Markdown rendering, and a completed save or export includes
   them ([collaboration](./docs/decisions/collaboration.md)). Search indexes,
   caches and embeddings are **disposable derivatives**, rebuildable from the
   notes and the rows. The layout is `notes/` and `.context/` in the object
   and `files/` in the files bucket; there is no `privacy.md`, and nothing
   written into a bucket from outside the app is picked up (decided by the
   owner, 2026-10-15). No compatibility with syncing a bucket to Obsidian is
   kept; Obsidian plugins running inside Context are.
4. **One person or workspace is one security boundary.** Every workspace has its
   own identity, storage binding, privacy manifest, audit trail and connector
   grants. **Never** extend the legacy shared-token model (`PRIVATE_TOKEN` /
   `TEAM_TOKEN` / `PUBLIC_TOKEN`) to multiple customers — it is single-tenant by
   construction and exists only to keep the original single-tenant deployment
   running. MCP access
   uses OAuth with per-client revocable grants, the token in a header; the
   token-in-URL fallback is retired (decided by the owner, 2026-11-05;
   [token-transport](./docs/decisions/gateway-protocol/token-transport.md)). Prove isolation with tests: one
   tenant must not enumerate, read, or infer the existence of another.
5. **`team` never means public.** A row's access is `private` (owners) or
   `team` (members), plus any mix of groups and named people, inside the
   workspace or not, each with view or edit (decided by the owner,
   2026-10-15). Every grantee is a person with an account or an email awaiting
   one, or a phone number invited from a Tex chat
   ([invited-family](./docs/decisions/texting-assistant/invited-family.md));
   a Tex group chat's home is the exception: the grant that reaches it is its
   sponsor's, and it reaches that home and what is shared with the chat
   ([chat-homes](./docs/decisions/texting-assistant/chat-homes.md)). No *setting* publishes a
   context, a folder, or a visibility class to the internet, and nothing here is
   indexed. **A link an owner mints and can revoke is the single exception**, and
   it is always a share row, never a value of a row's access. A link covers one note, or one folder and the subtree
   beneath it — and a folder link **narrows**: every path under it is still
   re-derived through the live rows at `team` scope with no granted
   names, so a note held back by name, a private subfolder and a note pointed at
   a group are all absent through it. It publishes what the folder already
   published to the workspace and never more, which is why this is a wider
   *locator* and not a wider *tier*. The whole context is never the subject of
   one. A page (`.page.md`) linked for the team or for anyone previews its
   cover, its first screen (decided by the owner, 2026-10-27;
   [page-covers](./docs/decisions/privacy-and-sharing/page-covers.md)).
   See [privacy-and-sharing](./docs/decisions/privacy-and-sharing.md).
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
   nobody can take back: an email, a handle claim, a vault key's first use
   (a change to the person's own calendar that tells nobody no longer
   waits for Tex; one Google would tell a guest about does: decided by the
   owner, 2026-10-22)
   ([agent-egress](./docs/decisions/privacy-and-sharing/agent-egress.md)).

Only a *personal* context has an ingestion alias; a shared context has no capture
address at all, and a Tex group chat's own `group-<words>@` files into its sealed
home (decided by the owner, 2026-11-08;
[identity-and-access](./docs/decisions/identity-and-access.md)).

## Architecture

```
apps/convex/     control plane: accounts, workspaces, usernames, storage
                 bindings, OAuth clients + grants, audit events, the file
                 tree (names only) and privacy rules
apps/mobile/     Expo (iOS/Android/web): the one app UI, also hosted by desktop
apps/desktop/    Electron shell for macOS and Linux: menu bar, meeting capture
apps/agent/      Cloudflare Worker: the assistant people text (Sendblue iMessage
                 webhook → per-sender queue → gateway /agent)
apps/mcp/        Cloudflare Worker: MCP gateway, privacy engine, tools,
                 storage adapter, email ingestion
infra/           edge Workers: router (context.lc), email, transcription,
                 site screenshots, egress, Sentry inbox
packages/        shared, tex (Tex's config graph, prompts, judge examples,
                 Training, tool rules), lab (the Tex Lab), collaboration, meetings,
                 communications, drawings, desktop-bridge, obsidian-runtime,
                 encryption-decryptor
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
an in-memory store stub: fast, offline, currently 4,682 checks. **Do not let it
regress** — change the test in the same commit as the behavior, and say why.

The privacy engine (`canSee`, `effectiveVisibility`: the nearest folder or
note setting wins, moving onto tree rows per
[notes-by-id](./docs/decisions/storage-and-credentials/notes-by-id.md)) is proven and load-bearing: refactor
its *plumbing* freely; changing its *semantics* is a decision for
`docs/decisions/`.

**Tex has one graph**, `packages/tex/src/texConfig.json`: every node and
every wire Tex runs; nodes are code, wires are config (decided by the owner,
2026-11-14; [config-graph](./docs/decisions/texting-assistant/config-graph.md)).
Its drawing, [`docs/architecture/tex.md`](./docs/architecture/tex.md), and the
map every Tex agent is told (`texArchitecture.generated.js`) are generated from
it by `node scripts/tex-architecture.mjs`, so an architecture change is a
config change in the same pull request
([architecture-diagram](./docs/decisions/texting-assistant/architecture-diagram.md));
`scripts/tex-diagram-check.mjs` fails CI when either is stale or code runs a
step or model call the config has no node for.

**Tex has one capability list**, `packages/tex/gateway/agent/capabilities.js`: what it
can do in a 1:1 text, a group chat and a guest chat, who asks, drafts and
approves, and what it can't do yet with the way around it. A change to what a person can get Tex to do, or how they set it up
(an app-only setting included), changes its line in the same pull request,
and a new capability removes or narrows the `cant` it replaces
(decided by the owner, 2026-11-08;
[capabilities](./docs/decisions/texting-assistant/capabilities.md));
`apps/mcp/test/capabilities.test.mjs` fails when a tool or command is missing.

**Try changes in a sandbox, merge what won**: a Tex or search config change is a Lab
draft tried in a test chat or benched with `tex_dev search_bench` in seconds; a code
change is tried on its pull request's preview sandbox, redeployed on every push;
merging lands what won and is never the test. How: [`docs/lab.md`](./docs/lab.md). A pull request that
changes the Lab, its test chats, its bench or the previews updates `docs/lab.md`,
`docs/preview-sandbox.md` or the `tex_dev` guide in the same pull request, or says
"No Lab docs change: <why>"; `scripts/check-lab-docs-updated.mjs` fails it otherwise
([lab-docs](./docs/decisions/testing/lab-docs.md)).

**Tex changes merge through the replay gate**
([replay-gate](./docs/decisions/testing/replay-gate.md); decided by the owner,
2026-11-13): a Tex change adds the case that proves it, and one that reaches a
model area needs a passing **Tex test set** run before **Tex replay required**
can go green: the sealed Test Set only, started on main by that check, capped,
and never shown to an agent (decided by the owner, 2026-11-15;
[test-set-service](./docs/decisions/testing/test-set-service.md)). The full
**Tex replay** is the Dev Set's, on demand, and never gates.

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
- **Usernames and workspace slugs share one global namespace**, unique, with a
  reserved-word list. Sharing is addressed by name. A username changes at most
  twice and keeps its old names
  ([username-changes](./docs/decisions/identity-and-access/username-changes.md)).
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
  deploy the gateway (its objects on Cloudflare or on `workerd`) and a Convex
  deployment of their own, and have a working context without us. There is no
  mode without a control plane (decided by the owner, 2026-10-15).

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

**Merging deploys staging, and production follows a green main CI.** Every
merge to `main` runs `Deploy Staging`. `Promote to Production`
(`promote-production.yml`) starts `Deploy to Production` when that CI run
succeeds, for the newest commit on main whose CI succeeded, and not before
(decided by the owner, 2026-11-17). Staging does not gate it. A red main CI
does not deploy.
Check that production finished; do not dispatch it a second time. Set
`AUTO_DEPLOY_PRODUCTION` to `off` to leave production to the manual press.
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
- **Before every push, run `pnpm precheck`.** It runs the fast guards
  (including the Tex diagram check and the replay-case check), the app
  typecheck, and the architecture check. Do not push a red precheck. It needs
  `pnpm install` and stays within a couple of minutes.
- **Pull request flow.**
  1. To iterate on code, open the pull request early as a draft, with auto-merge
     off, and push as often as you need: each push redeploys its preview
     sandbox. Mark it ready only when the work is finished: `pnpm precheck`
     passes, and the branch was rebased on main once. After that, a follow-up
     is a new pull request, not another push.
  2. Right after it is ready (opened finished, or marked ready), run `gh pr merge <n> --auto --squash` with your own
     credentials. Auto-merge is approved for agent pull requests. Never merge
     with `GITHUB_TOKEN`; that merge does not start the deploy. Skip a pull
     request Seyi said to hold, and skip jewunetie's.
  3. After opening, do not merge or rebase main into the branch unless GitHub
     reports a merge conflict (`mergeable_state` `dirty`). Main does not
     require an up-to-date branch. Every merge from main restarts CI and the
     Tex replay on a new commit. To retry a flaky check, re-run the failed
     job (`gh run rerun <id> --failed`). Do not push.
  4. Done means live in production. Open to live in 10 minutes, 30 at most.
- **Sabotage-test rather than trusting a green run**: break the invariant
  deliberately and confirm the right tests fail.
- **Small, tested increments.** Atomic commits; describe *why*.
- **Agent-first: no feature is buttons-only.** What a person can do in the app,
  Tex can do from a text, or the capability list
  (`packages/tex/gateway/agent/capabilities.js`) names the one step only a person can
  take and what Tex hands for it: an agent prompt, a link, an app path, a vault
  entry. A PR that adds an app route adds its line; one that gives Tex a
  capability deletes its `cant` entry (decided by the owner, 2026-11-08;
  [computer-setup](./docs/decisions/texting-assistant/computer-setup.md)).
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
- **Gateway**: Cloudflare Workers; notes in workspace Durable Objects, files and backup copies in R2 via the storage adapter
- **Mobile/web app**: React Native + Expo, Expo Router
- **Ingestion**: Cloudflare Email Routing → Email Worker → `inbox/`
- **Framework**: [supa-framework](https://github.com/Supa-Media/supa-framework)
  (`@supa-media/*` from npmjs, public — no token, no `.npmrc` scope line)

Upstream-first: if a change is generic, it belongs in supa-framework, not here.
