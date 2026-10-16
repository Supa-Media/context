# Context

**Free your context. Share your context.**

A simple notes app you, your team and your agents all work in — plain
Markdown, in a dedicated bucket you can move to storage you own at any time.

Your context is the durable layer. AI clients are replaceable interfaces.

Every context is a **workspace**. Your own is one per person, addressed by your
name; others are shared, with several members. Your workspace, the ones people
share with you, and the ones you belong to are, together, your **context**.

Context gives you one MCP endpoint you add everywhere — ChatGPT, Claude, Codex,
Notion AI, whatever comes next — so every tool starts already knowing your
projects, decisions, and history. You stop re-teaching each new assistant from
scratch.

## The deal

**You keep your data.** Start free with a Context-managed bucket — no card,
up to 1,000 notes — or bring a bucket you own outright: Cloudflare R2, AWS S3,
Backblaze B2, or any S3-compatible storage. A managed context can move every
raw object into your bucket from Settings; Context copies and verifies first,
then switches, for free and even after cancellation. Every way out is plain
Markdown, on either plan.

That's not a feature we might remove later. It's the architecture:

- **Plain files are canonical.** Markdown you can open in Obsidian, grep, or
  `rclone` out. Never a proprietary database that becomes the only copy.
- **Your storage keeps its native shape.** Tenancy is bucket-level: we never
  rewrite your keys or namespace your paths. An existing bucket connects
  without a migration.
- **The gateway is portable.** `apps/mcp` is a self-contained Cloudflare Worker.
  If Context.LC disappears tomorrow, deploy it and the control plane in
  `apps/convex` yourself, and your bucket keeps working.
- **Indexes are disposable.** Search caches and embeddings are derivatives that
  can be rebuilt from the files. The files are the truth.

## How it works

```
   Your AI clients                  Context.LC                 Dedicated storage
┌────────────────────┐      ┌──────────────────────┐      ┌────────────────────┐
│ ChatGPT            │      │  Control plane       │      │  R2 / S3 / B2      │
│ Claude             │─────▶│  (Convex)            │      │                    │
│ Codex              │ MCP  │  accounts, workspaces│      │  0-inbox/          │
│ Notion AI          │ over │  OAuth grants,       │      │  1-projects/       │
│ …                  │ OAuth│  storage bindings,   │      │  2-areas/          │
└────────────────────┘      │  file tree, privacy  │      │  3-resources/      │
                            │  rules, audit        │      │  4-archive/        │
                            ├──────────────────────┤      │  index.md          │
   The app (web, phone,     │  MCP gateway         │─────▶│  privacy.md        │
   desktop) and the     ───▶│  (Cloudflare Worker) │OAuth │  .context/         │
   texting assistant        └──────────────────────┘/keys └────────────────────┘
   control plane holds names, links and List front matter — never a note's body
```

Two planes, and the split is the whole point.

The **control plane** knows who you are, which storage serves each workspace,
which AI clients you've authorized, and who did what. It also holds each
workspace's **file tree** — one row per file and folder, with its path, parent,
version and size — and its privacy rules, so the sidebar, Lists, Home and the
map all read one live tree that changes the moment a note is created, renamed
or moved, with the files catching up behind it. To draw Lists and the map
without opening every file, each note's row also carries its links and the
front matter, heading and first paragraph a List card shows: derivatives
rebuilt from your files and deleted with your workspace. Never a note's body.
See [convex-tree](docs/decisions/app-and-console/convex-tree.md) and
[convex-facts](docs/decisions/app-and-console/convex-facts.md).

The **data plane** is one bucket per workspace, either operated by Context or
controlled by you. The gateway reads and writes it with a credential decrypted
per request and never cached. On customer-owned storage, deleting your Context
account removes the control-plane metadata and leaves the bucket untouched.
`privacy.md` stays in the bucket in the same format, so leaving keeps who sees
what.

## Structure your context however you like

We suggest [PARA](https://fortelabs.com/blog/para/) and will scaffold it for you
on setup:

| Folder          | Holds                                        |
| --------------- | -------------------------------------------- |
| `0-inbox/`      | raw captures, unfiled                        |
| `1-projects/`   | active work with an end state                |
| `2-areas/`      | ongoing responsibilities                     |
| `3-resources/`  | reference material                           |
| `4-archive/`    | anything no longer active                    |

It's a suggestion, not a schema. Bring your own structure and Context works the
same — the tools operate on paths, not on a fixed taxonomy.

Context-owned data — audit records, attachments, editing history, search
state and the like — is kept under one reserved `.context/` folder, so the
bucket root stays yours and human-readable. Collaboration history under
`.context/collaboration/` is your data too, backed up and exported with the
notes; search indexes and caches are disposable and rebuilt from the files.

Buckets created before storage-layout v1 continue to work through dual reads;
the owner-only `migrate_storage_layout` tool copies and verifies legacy objects,
keeps them for a seven-day rollback window, and removes them only in a separate
explicit cleanup phase.

## `index.md` — the front page every agent reads

Every connected client is told to call one tool first, `orient`. It is cheap on
purpose: your front page, what you touched most recently, and a map of your
folders with note counts. It is the difference between an AI client that knows
you already have a project on this and one that asks you to explain yourself
again.

That instruction lives in the connection, though, not in the client — a fresh
chat can still forget to act on it. To make it permanent, paste this into the
client's own custom instructions, system prompt, or rules file (the connect
screen shows you exactly where, per client):

> Always orient using the Context MCP (call `orient`) before answering
> anything about me or my work, and save what you learn with `write` (action
> `save_session`) before you finish.

Most of what `orient` returns is derived from the bucket and rebuilt on every
call. One part is not: `index.md`, an ordinary Markdown file at the root of your
bucket that you own. Setting up a new workspace writes a starting one describing
the conventions; what makes it earn its place is the part only you can write.

```markdown
# Context

Building the gateway; consulting on the side. Mornings are for deep work.

## Now
- 1-projects/gateway — shipping the MCP server. Decisions in decisions.md.
- 1-projects/acme — client work, weekly check-in Thursdays.

## Where things go
- Anything a client said → 1-projects/<client>/notes.md
- Reusable how-to → 3-resources/
- Mail I send myself lands in 0-inbox/ and I file it on Fridays.
```

Nothing about the format is enforced. Edit it in Obsidian, in your editor, or
ask an agent to bring it up to date — it is a note like any other, so it obeys
the same privacy rules, keeps the same history, and travels with the bucket.
Agents are told to add to it rather than replace it, and to say what they are
changing first. Owners can add an `index-private.md` beside it for anything that
should only reach a personal connection.

Connecting a bucket that already has months of notes in it never overwrites
anything, so an imported workspace may have no `index.md` at all. `orient` then
says so and tells the agent what it's for, which is usually enough to get one
written.

## Sessions save themselves

`orient` gets an agent to read your context. The other half is getting what it
learned back in, and the honest position is that agents forget: a long session
ends, and the decision worth keeping was never written down.

Two answers, and you want both:

- **`save_session`**, an action of `write` the agent calls when it finishes. What it does is
  yours to define — put a `## Save context` section in your `index.md` with a
  `destination:` line and whatever procedure you want followed, and `orient`
  hands it to every agent that connects.
- **A session-end hook**, for when the agent does not call it:

  ```sh
  npx -y @supa-media/context install
  ```

  Signs you in once and adds a `SessionEnd` hook to Claude Code. From then on a
  session's user-visible messages land in `0-inbox/` on their own. It asks for
  capture access only — it can add to your inbox and cannot read a single note —
  and it shows up in Connections like any other client, revocable on its own.
  See [`plugins/context`](plugins/context).

## Privacy tiers

Every note is `private` or `team`. Folders set defaults and exact notes can
override their folder in either direction; the gateway enforces this before
any content is returned. The rules are held in the control plane and written
out to a `privacy.md` at the root of your bucket in the same readable format,
so a bucket you take with you keeps who sees what.

`team` means *people you've named*, never the public internet. No setting
publishes a context. The one exception is a link an owner mints for one note
or one folder and can revoke, and a folder link still hides whatever
`privacy.md` holds back ([decision](docs/decisions/privacy-and-sharing.md)).

## What else is in the box

- **The app** — one Expo codebase that is the UI on web, iOS, Android and,
  inside a thin Electron shell, macOS. Live collaborative editing, Lists and
  Boards over folders, a live map of your notes, comments, forms, drawings.
- **Meetings** — the desktop app notices a meeting and records it without a
  bot joining the call; the note lands as Markdown in your bucket.
- **Capture** — mail sent to `<username>@context.lc` lands in your personal
  workspace's inbox. Shared workspaces have no capture address.
- **Texting assistant** — text Context over iMessage and it answers from your
  notes with your own grant ([decision](docs/decisions/texting-assistant.md)).
- **Websites** — a workspace's `website/` folder can be published at
  `context.lc/@<handle>`, `<handle>.ctxlc.site` or your own domain, narrowed by
  `privacy.md` ([decision](docs/decisions/websites.md)).

## Repository layout

| Path                              | What it is                                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| `apps/convex/`                    | Control plane — accounts, workspaces, grants, bindings, audit, file tree, privacy rules, billing |
| `apps/mcp/`                       | The MCP gateway Worker — tools, OAuth, privacy engine, storage adapter. Self-hosting: [`apps/mcp/SETUP.md`](apps/mcp/SETUP.md) |
| `apps/mobile/`                    | The Expo app: web, iOS, Android, and the UI the desktop shell hosts        |
| `apps/desktop/`                   | Electron shell for macOS: menu bar, meeting capture, offline queue         |
| `apps/agent/`                     | Worker behind the texting assistant (Linq iMessage webhook → gateway `/agent`) |
| `infra/router/`                   | Worker fronting `context.lc`: the web app, Convex auth routes, websites    |
| `infra/email-worker/`             | Email Worker that turns mail to `<username>@context.lc` into an inbox capture |
| `infra/transcribe-worker/`        | Turns a chunk of meeting audio into text; stores nothing                   |
| `infra/site-shots/`               | Screenshots a published website for an agent's site check                  |
| `infra/egress-service/`           | Public-only network egress for already-authorized plugin requests          |
| `infra/sentry-worker/`            | Turns new Sentry issues into short incident notes                          |
| `infra/domain-connect/`           | Domain Connect template for custom website domains                         |
| `packages/collaboration/`         | Yjs merging and the customer-bucket editing history                        |
| `packages/meetings/`              | Meeting session state, detection and the Markdown a meeting becomes        |
| `packages/communications/`        | What a day of mail or calendar becomes in the bucket                       |
| `packages/drawings/`              | Excalidraw drawings as notes                                               |
| `packages/desktop-bridge/`        | `window.desktop`: the typed contract between the app and the desktop shell |
| `packages/obsidian-runtime/`      | Capability-scoped bridge for sandboxed Obsidian plugins                    |
| `packages/encryption-decryptor/`  | Offline decryptor for encrypted notes, published to npm                    |
| `packages/shared/`                | Types and constants shared across apps                                     |
| `plugins/context/`                | The agent plugin, and `npx @supa-media/context`, which installs it         |

## Development

Node 22 and pnpm 9. Built on
[supa-framework](https://github.com/Supa-Media/supa-framework); `@supa-media/*`
packages come from npmjs, so a plain install needs no token.

```sh
pnpm install
npx convex dev                       # links your own Convex deployment
cp .env.example .env.local           # or `pnpm setup:secrets` with 1Password access
pnpm dev                             # Convex + Expo together
pnpm dev:convex / pnpm dev:mobile    # just one of them
pnpm --filter @context/mcp dev       # the gateway under wrangler
```

Cloud and unattended sessions run `bash scripts/cloud-setup.sh` once; see
[CONTRIBUTING.md](CONTRIBUTING.md) for why.

### Tests

```sh
pnpm test                            # every package, through turbo
pnpm --filter @context/mcp test      # gateway suite: in-memory store, offline
pnpm --filter @context/convex test   # control plane (vitest + convex-test)
pnpm --filter @context/mobile test   # app (jest)
pnpm typecheck
pnpm architecture                    # file-size limits; run before calling work done
```

Change a test in the same commit as the behavior it covers. Security-sensitive
changes need a test proving the attack fails.

### Deploying

Work goes through pull requests; nobody pushes to `main`. Every merge to
`main` runs **Deploy Staging** (`staging.context.lc`), which deploys only the
components the commit can affect. Production is a separate manual run of
**Deploy to Production** on a commit that already passed staging. Desktop
releases and native store builds are their own manual workflows. See
[docs/staging.md](docs/staging.md).

## Docs

- [`CLAUDE.md`](CLAUDE.md) — the non-negotiables, architecture and vocabulary;
  read it before changing anything.
- [`docs/decisions/`](docs/decisions/README.md) — every durable decision, by
  area, with what reversing it would cost.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup and review expectations.
- [`SECURITY.md`](SECURITY.md) — reporting a vulnerability.
- [`docs/staging.md`](docs/staging.md) — staging and production releases.
- [`docs/observability.md`](docs/observability.md) — monitoring, privacy
  rules for telemetry, release verification and the incident runbook.
- [`apps/mcp/SETUP.md`](apps/mcp/SETUP.md) — connecting a client, and
  self-hosting the gateway over your own bucket.
