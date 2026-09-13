# Vocabulary and the workspace model

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

## Vocabulary

One user-facing noun for a context, decided by the owner (2026-09-13). This
**reverses** the three-noun rule of 2026-08, which gave the two kinds two words
— "brain" for a personal context, "workspace" for a shared one — and it reverses
it for the owner's reason: *a brain is just a workspace, so we should just call
it a workspace*.

- **Workspace** — a context, personal or shared. One person's own is a
  workspace; a slug-addressed one with several members is a workspace. The same
  word as the internal unit, so code and copy agree, which is what the earlier
  rule had right about half of its vocabulary.
- **Context** — the aggregate: everything one person can reach through the
  endpoint — their own workspace, the ones shared with them, and the ones they
  belong to. Also the product name. New copy never uses "context" for a single
  unit. One pragmatic allowance survives from the earlier rule: existing
  unit-generic strings (permission errors, refusals) at call sites that do not
  know the unit's `kind` may keep "this context" until the site learns the kind.
- **Brain** — retired. No new user-facing copy uses it.

A sentence that has to tell the two kinds apart says **personal workspace** and
**shared workspace** — or "your own" and "a shared one" when the contrast is
already in the paragraph. The distinction is real and load-bearing: only a
personal workspace has an ingestion alias, reads a mailbox, a calendar or a
chat archive, and is deleted with its account. What was wrong was having two
*nouns* for one kind of object, not having two adjectives for two shapes of it.

Where the rail drew that distinction as structure it now draws it as a pin:
one list, the person's own workspace at the top of it, marked `yours` — see
[app & console](./app-and-console.md), *The rail is one list*.

The earlier exception is unchanged: copy addressed to a **connected AI client**
about the one thing its grant reaches (gateway `instructions`, `orient`, tool
descriptions and results) keeps saying "your context" — from that client's side,
what it can reach *is* the person's context, and a grant can be to either kind
of unit, which the gateway does not always know.

Code identifiers do not change, and did not change under the earlier rule
either: `workspace`/`workspaceId` stay the internal unit, `kind: "personal" |
"shared"` stays the discriminator. Legacy single-tenant names (`BRAIN` binding,
the `brain` Worker, `PRIVATE_TOKEN`) survive only where they're load-bearing for
the original deployment, and should disappear as code is generalized.

*What a "simplification" costs:* bringing a second noun back — for the personal
kind, or for the shared one — buys nothing the adjective does not, and costs
every sentence that has to pick between them, every heading that has to split on
them, and every person who has to learn that two words mean one thing. *The
tests that fail if it is reversed:* `railGroup.test.ts` — `says nothing about
brains` — and `consoleIdentityChrome.test.ts`, which asserts the rendered rail
matches `/brain/i` nowhere.

## "Brain" is retired, and stays reserved

`brain` and `brains` remain in `RESERVED_NAMES` (`functions/lib/names.ts`), and
retiring the word is the reason to hold them harder rather than the reason to
free them.

The reservation was never about vocabulary. **Ingestion is on the apex**, so
`<name>@<apex>` is a live capture address: whoever claimed `brain` would receive
mail people believed they were sending to the product, and `@brain/...` would
read as a product path rather than a person's. Retiring a word does not stop
people saying it — they will say it for years — so the window in which the
handle is believable is longer after the retirement, not shorter.

The same holds for the two words still in use: `workspace`, `workspaces` and
`context` stay reserved for the identical reason.

Two places keep the word on purpose and must not be "cleaned up":

- **`<!-- BEGIN BRAIN PRIVACY RULES -->`** and its `END` twin. These are
  on-bucket format, sitting inside every live `privacy.md` and located by string
  search. Changing them is a storage-layout migration with dual reads and a
  rollback window — non-negotiable #3 — not a copy edit.
- **Settings search keeps `brain` in its keyword haystack.** A haystack matches
  what people type, not what the product calls things. `settingsSections.test.ts`
  asserts that "delete my brain" still lands on the account screen — and that
  `workspace` never joins that row, since "delete workspace" must reach Advanced
  rather than the screen that closes an account.

*What a "simplification" costs:* freeing the names hands an impersonation handle
and a mail-interception address to whoever claims them first; rewriting the
on-bucket markers breaks every existing bucket. *The tests that fail if it is
reversed:* `names.test.ts` — `the retired 'brain' vocabulary can never be
claimed` — and `settingsSections.test.ts` —
`deleting a workspace and deleting an account are not the same search`.

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

## The reserved list is vendored, and it is taken whole

The hand-written list grew a name at a time, each with the reason it is there.
That is the right way to *decide* a name and a bad way to *cover* the space:
measured against the two blocklists most services vendor —
[shouldbee/reserved-usernames](https://github.com/shouldbee/reserved-usernames)
and
[marteinn/The-Big-Username-Blocklist](https://github.com/marteinn/The-Big-Username-Blocklist)
— it held 66 of the 834 applicable entries. The other 768 are names somebody
else already got wrong first: `wpad` and `isatap` (proxy auto-discovery
hijacking), `autodiscover` and `autoconfig` (hostnames a mail client probes on
its own), `null` and `true` (not impersonation but *parsing* — a name lands in
YAML frontmatter and in `@name/path`), `sudo`, `paypal`, `yourusername`.

**Taken whole rather than pruned.** Pruning means re-deciding 834 times on a
judgement the lists already made, and the names it buys back are ones nobody is
owed. The cost is real, small, and stated rather than discovered: `@test`,
`@demo`, `@beta`, `@premium`, every HTTP status code and a pile of SSH cipher
suites stop being claimable. Six fixture workspaces in the test suite were
renamed because of it.

`scripts/build-reserved-names.mjs` regenerates the vendored file and records
each source's URL, version marker and SHA-256 in it. The guard on that file is
deliberately weaker than the editor bundle's and says so: its inputs are remote
and CI has no network, so `reservedNames.test.ts` checks the file against
*itself* — the digest matches the names, so nobody hand-edited it — and re-running
the script is what answers whether the copy still matches upstream.

### Never reserve a name you intend to hold

`checkAvailability` runs `validateName` and there is **no bypass** — not for an
admin, not for a seeding script, not for us. A reserved name is refused for
everyone, so reserving the handle of a context we actually run would mean never
being able to recreate it after a delete or a migration.

So `context-lc`, `supa` and `supa-media` are deliberately **absent** from the
list, and each looks like it belongs there. What protects a name we hold is
holding it: the row in `names` is what makes it unavailable. What is worth
reserving is the shape nobody legitimate will ever want — `context-support`,
`context-official`, `contextlc` — and the test that fails when somebody makes
the obvious mistake is `but never the ones this company holds, which must stay
claimable`.

### A group label is a different question from a handle

`buildGroupName` checks the label a person types, and the reason is intact: the
reserved list is a mail-interception control and the label is the half a person
supplies. But a group is stored as `<workspace-slug>-<label>`, so it is never a
route, a mailbox, or a subdomain on its own.

Applying the whole list to a label silently took `@supa-owners` and
`@publicworship-staff` away — real group names refused because a word inside
them is a bad *handle*. So the sets are split: `RESERVED_GROUP_LABELS` is
`PRODUCT_RESERVED_NAMES`, the entries decided here with reasons that apply to a
label too; the vendored bulk and the handle-only names are not in it. The
**assembled** name is still checked against all of `RESERVED_NAMES`, which is
the check that matches what actually gets stored and addressed.

### Owed: skeleton matching

`RESERVED_LABEL_FORM` catches a homograph smuggled in from outside the charset.
It cannot see one built inside it: in the system UI face digit `1` and letter
`l` are one glyph, so `@context-1c` beside `@context-lc` is indistinguishable —
and `@context-lc` is the shared context every user is a member of, which is what
makes it worth wearing.

The named lookalikes are reserved. The general fix is **skeleton matching** —
fold `1`→`l`, `0`→`o`, drop hyphens, and check uniqueness on the folded form, so
`context-1c`, `contextlc` and `context-l-c` collapse to one name and only the
first registration wins. It is deliberately not in that change: it alters what
`validateName` *means* rather than what it knows, and it can refuse a name
somebody already holds, so it needs its own migration over the existing `names`
rows. A list cannot substitute for it — the near-misses are infinite and the
list is not.

