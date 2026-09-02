# Vocabulary and the workspace model

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

## Vocabulary

Three user-facing nouns, decided by the owner (2026-08). This replaces the
earlier rule "context, never brain", which guarded against *brain as the
generic unit noun*; these are per-shape names, and the generic unit noun is
gone from user-facing copy instead.

- **Brain** — a personal context: the workspace a username names, exactly one
  per person. "Create your brain", "@seyi's brain".
- **Workspace** — a shared context: slug-addressed, several members, no single
  personal owner. Deliberately the same word as the internal noun, so code and
  copy agree.
- **Context** — the aggregate: everything one person can reach through the
  endpoint — their brain, brains shared with them, and their workspaces. Also
  the product name. New copy never uses "context" for a single unit; a
  sentence that needs "either kind" says "a brain or a workspace". One
  pragmatic allowance: existing unit-generic strings (permission errors,
  refusals) at call sites that do not know the unit's `kind` may keep "this
  context" until the site learns the kind — prefer the specific noun wherever
  `kind` is already in hand, and never introduce new "a context" copy.

One deliberate exception: copy addressed to a **connected AI client** about
the one thing its grant reaches (gateway `instructions`, `orient`, tool
descriptions and results) keeps saying "your context" — from that client's
side, what it can reach *is* the person's context, and a grant can be to
either kind of unit, which the gateway does not always know.

`brain` and `brains` are reserved names (`functions/lib/names.ts`), like
`workspace` and `context` before them — product vocabulary as a claimable
handle is an impersonation risk, and ingestion is on the apex.

Code identifiers do not change: `workspace`/`workspaceId` stay the internal
unit, `kind: "personal" | "shared"` stays the discriminator. Legacy
single-tenant names (`BRAIN` binding, `PRIVATE_TOKEN`) survive only where
they're load-bearing for the original deployment, and should disappear as code
is generalized.

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
