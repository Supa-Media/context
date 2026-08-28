# Context

**Free your context. Share your context.**

Your context is the durable layer. AI clients are replaceable interfaces.

Context gives you one MCP endpoint you add everywhere — ChatGPT, Claude, Codex,
Notion AI, whatever comes next — so every tool starts already knowing your
projects, decisions, and history. You stop re-teaching each new assistant from
scratch.

## The deal

**You keep your data.** Your notes are plain Markdown in a bucket *you* own —
Cloudflare R2, AWS S3, Backblaze B2, any S3-compatible storage. You paste a
scoped key; we read and write through it. Revoke the key and we're gone, and
every file is still sitting in your bucket, still readable, still yours.

That's not a feature we might remove later. It's the architecture:

- **Plain files are canonical.** Markdown you can open in Obsidian, grep, or
  `rclone` out. Never a proprietary database that becomes the only copy.
- **Tenancy is bucket-level.** We never rewrite your keys or namespace your
  paths. A bucket already laid out this way just works — connect it and nothing
  about it changes.
- **The gateway is portable.** `apps/mcp` is a self-contained Cloudflare Worker.
  If Context.LC disappears tomorrow, deploy it yourself and your bucket keeps
  working.
- **Indexes are disposable.** Search caches and embeddings are derivatives that
  can be rebuilt from the files. The files are the truth.

## How it works

```
   Your AI clients                  Context.LC                    Your storage
┌────────────────────┐      ┌──────────────────────┐      ┌────────────────────┐
│ ChatGPT            │      │  Control plane       │      │  R2 / S3 / B2      │
│ Claude             │─────▶│  (Convex)            │      │                    │
│ Codex              │ MCP  │  accounts,           │      │  0-inbox/          │
│ Notion AI          │ over │  workspaces,         │      │  1-projects/       │
│ …                  │ OAuth│  OAuth grants,       │      │  2-areas/          │
└────────────────────┘      │  storage bindings    │      │  3-resources/      │
                            ├──────────────────────┤      │  4-archive/        │
                            │  MCP gateway         │─────▶│  index.md          │
                            │  (Cloudflare Worker) │ your │  privacy.md        │
                            └──────────────────────┘ keys │  .history/         │
                                                          │  .audit/           │
                                                          └────────────────────┘
     control plane holds metadata only — never your notes, never a second copy
```

Two planes, and the split is the whole point. The **control plane** knows who
you are, which bucket is yours, and which AI clients you've authorized. The
**data plane** is your bucket. Delete your Context account and the control plane
forgets you; the data plane is untouched.

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

## `index.md` — the front page every agent reads

Every connected client is told to call one tool first, `orient`. It is cheap on
purpose: your front page, what you touched most recently, and a map of your
folders with note counts. It is the difference between an AI client that knows
you already have a project on this and one that asks you to explain yourself
again.

Most of what `orient` returns is derived from the bucket and rebuilt on every
call. One part is not: `index.md`, an ordinary Markdown file at the root of your
bucket that you own. Setting up a new context writes a starting one describing
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
anything, so an imported context may have no `index.md` at all. `orient` then
says so and tells the agent what it's for, which is usually enough to get one
written.

## Sessions save themselves

`orient` gets an agent to read your context. The other half is getting what it
learned back in, and the honest position is that agents forget: a long session
ends, and the decision worth keeping was never written down.

Two answers, and you want both:

- **`save_context`**, a tool the agent calls when it finishes. What it does is
  yours to define — put a `## Save context` section in your `index.md` with a
  `destination:` line and whatever procedure you want followed, and `orient`
  hands it to every agent that connects.
- **A session-end hook**, for when the agent does not call it:

  ```sh
  npx -y @context-lc/hook install
  ```

  Signs you in once and adds a `SessionEnd` hook to Claude Code. From then on a
  session's user-visible messages land in `0-inbox/` on their own. It asks for
  capture access only — it can add to your inbox and cannot read a single note —
  and it shows up in Connections like any other client, revocable on its own.
  See [`packages/hook`](packages/hook).

## Privacy tiers

Every note is `private` or `team`. Folder defaults live in a `privacy.md`
manifest at the root of your bucket — visible to you in Obsidian, enforced
server-side before any content is returned. Exact notes can override their
folder in either direction.

`team` means *people you've named*, never the public internet. There is no
anonymous tier.

## Repository layout

| Path              | What it is                                                     |
| ----------------- | -------------------------------------------------------------- |
| `apps/convex/`    | Control plane — accounts, workspaces, storage bindings, grants  |
| `apps/mobile/`    | Expo app (iOS, Android, web) — onboarding and dashboard         |
| `apps/mcp/`       | The MCP gateway Worker — tools, privacy engine, storage adapter |
| `packages/shared/`| Types and constants shared across apps                          |
| `packages/hook/`  | `npx @context-lc/hook` — the session-end hook                    |

## Development

```sh
pnpm install
npx convex dev          # creates your Convex deployment
pnpm dev                # Convex + Expo together

cd apps/mcp && pnpm test   # 442 checks, no dependencies, no network
```

Built on [supa-framework](https://github.com/Supa-Media/supa-framework).
