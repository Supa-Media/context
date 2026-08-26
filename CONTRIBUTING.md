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
bash scripts/cloud-setup.sh
```

Idempotent, safe to re-run, and the right thing to point an unattended runner
at — Claude Code on the web, a cloud session, a Routine. It installs
dependencies with the GitHub Packages token and applies the checked-in
permission allowlist.

That second half exists because of a trap worth knowing about:

> Project-level `permissions.allow` rules in `.claude/settings.json` are gated
> behind the **workspace-trust dialog**, and a non-interactive session never
> shows that dialog. On a fresh clone the allow rules are read and then
> **ignored** — while `deny` rules always apply. So an agent that looks
> correctly configured spends its whole run asking for permission it was
> already granted.

The script makes the allowlist effective two independent ways: it copies the
rules into user-level `~/.claude/settings.json` (never trust-gated) and
pre-seeds workspace trust for the clone path.

Doing it by hand instead:

```sh
pnpm install                    # needs GITHUB_TOKEN with read:packages
npx convex dev                  # links your own Convex deployment
cp .env.example .env.local
```

`@supa-media/*` come from GitHub Packages, so `pnpm install` fails without a
token. `.npmrc` reads `${GITHUB_TOKEN}`; locally, `gh auth token` supplies one.

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
