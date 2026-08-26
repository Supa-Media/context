# Contributing to Context

Thanks for being here. Context is a small codebase with a few strong opinions,
and this file is mostly about which opinions are load-bearing.

## The short version

- Read `CLAUDE.md`. It holds the non-negotiables — customer-owned storage,
  bucket-level tenancy, plain-file portability, per-workspace isolation, and
  `team` never meaning public. Those aren't implementation details; they're the
  reason the project exists.
- Work on a branch, open a pull request. Nobody pushes to `main`.
- Write the failing test first.
- If a change touches auth, isolation, path handling, or credentials, expect a
  slow and skeptical review. That's not distrust — it's the deal we've made
  with people whose buckets we hold keys to.

## Setup

```sh
pnpm install
```

`@supa-media/*` packages come from GitHub Packages, so you'll need a token with
`read:packages` exported as `GITHUB_TOKEN`.

```sh
npx convex dev                  # your own Convex deployment
pnpm dev                        # Convex + Expo

cd apps/mcp && pnpm test        # 320 checks, offline, no dependencies
```

## Repository layout

| Path               | What lives there                                            |
| ------------------ | ----------------------------------------------------------- |
| `apps/convex/`     | Control plane — metadata only, never note content            |
| `apps/mobile/`     | Expo app (iOS, Android, web)                                 |
| `apps/web/`        | Landing page                                                 |
| `apps/mcp/`        | The MCP gateway Worker                                       |
| `packages/shared/` | Shared types and constants                                   |

### `apps/mcp` has one unusual rule

**It has zero npm dependencies, and we intend to keep it that way.** It runs on
the Cloudflare Workers runtime — Web Crypto and `fetch`, no Node APIs. Its test
suite runs offline against an in-memory store stub with a bare
`node test/test.mjs`.

This is deliberate. The gateway is the piece users self-host, and a dependency
is a thing that can break under them or quietly change what happens to their
notes. If you think you need a package, propose it in an issue first — the
answer is often "that's 80 lines, let's just write it."

## Tests

New behavior needs a test. Changed behavior needs the test changed *in the same
commit*, with the reason in the message.

Some areas need more than a happy path:

- **Tenant isolation** — prove a non-member can't read, list, or *infer the
  existence of* another workspace's anything.
- **Privacy tiers** — prove a `team` caller can't discover a `private` note's
  name, let alone its content.
- **Conflict-safe writes** — etag preconditions, and honest behavior on stores
  that don't support them.
- **Revocation** — revoking one grant leaves the others working.
- **Ingestion idempotency** — a retried delivery doesn't duplicate a note.

## Commits and pull requests

Write commit messages that explain *why*. The diff already says what.

Keep commits atomic — one logical change each. A PR that does three things is
three PRs.

In the PR description, say what you changed, how you tested it, and anything
you're unsure about. Flagging your own uncertainty is genuinely useful and
never counts against you.

## Security

Found a vulnerability? **Don't open an issue.** See [SECURITY.md](SECURITY.md)
for private reporting.

## Code style

- Prefer readable over clever, even when clever is shorter.
- Three similar lines beat a premature abstraction.
- Delete old patterns rather than keeping both. No compatibility shims where
  you could just change the code.
- Comment the *why*. The code shows the what.
- If you can't simplify something, leave a note explaining why it's complex.

## Licensing

Context is MIT. By contributing, you agree your contributions are licensed the
same way.
