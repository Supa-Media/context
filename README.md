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
                            │  MCP gateway         │─────▶│  privacy.md        │
                            │  (Cloudflare Worker) │ your │  .history/         │
                            └──────────────────────┘ keys │  .audit/           │
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

## Development

```sh
pnpm install
npx convex dev          # creates your Convex deployment
pnpm dev                # Convex + Expo together

cd apps/mcp && pnpm test   # 194 checks, no dependencies, no network
```

Built on [supa-framework](https://github.com/Supa-Media/supa-framework).
