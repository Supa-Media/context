# Privacy and sharing — All Context users

_See `docs/decisions/README.md` for the index._

### In the pinned workspace, `team` is shown as "All Context users" (decided by the owner, 2026-10-19)

**What `team` already reaches there.** `@context-lc` is the pinned workspace
(`packages/shared/src/pinnedContext.ts`, `apps/convex/functions/lib/pinnedContext.ts`):
every Context account reads it through the pin, with no membership row, at
role `member` and scope `team`. So in that one workspace a note or folder at
`team` is open to every signed-in account, and signing up is open to anyone.
The share dialog called that "Everyone in @context-lc" and the privacy panel
"everyone on People", which understated the reach in the direction
`apps/mobile/features/console/privacy/words.ts` forbids.

**Data does not change meaning; only the words do.**

| Position (pinned workspace) | Data |
|---|---|
| Restricted | base `private` (unchanged) |
| Members of @context-lc | base `private` + the built-in `members` grantee |
| All Context users | base `team`, exactly what it always was |
| Anyone with the link | a share row (unchanged) |

Widest last. The `members` grantee (`Grantee.kind "members"` in
`lib/nodes/rowAccess.ts` and its gateway port) is held by every person with a
real membership row and by nobody else: never an outsider, never a pin reader.
It works in any workspace in the data model; the app offers it only in the
pinned one (`audiencePositions` in `apps/mobile/features/console/files/scope.ts`),
and shows it anywhere a note already carries it so its position is never
misdrawn. Ordinary workspaces keep their three positions and every sentence
they had.

How the console knows: `listMyWorkspaces` marks the pinned workspace
`everyAccountReadsTeam` for everyone who lists it, its real members and owner
included. That is a separate flag from `pinned`, which means reach without
membership and is absent on a real member's row, and the share dialog is the
owner's. In the gateway, `orient`'s workspace row and the sharing judge's
summary (`privacy/widening.js`) say "every signed-in Context account" for
`@context-lc` instead of "team".

**How the positions are written.** Members is a tier write
(`setNoteVisibility` / `setDirectoryVisibility` with `members: true`, rows
mode only), and it is the one that touches the list: base `private`, the
members grant added, everybody else kept. Every other tier write clears that
grant (`lib/nodes/membersPosition.ts`), so Restricted means owners and the
people named, with nothing hidden. Every list write sends the grant back
(`granteeInputOf`, `requestOf`), so editing People never drops it, and People
never draws it as a person.

**Picking All Context users confirms in place**, from Restricted or Members,
with the same block and buttons as going public: "Anyone signed in to Context
will be able to open {name}, not just the {n} members. Signing up is open to
all, so keep anything sensitive out." / Cancel / Open to all users. Leaving
it, or reaching it from a link (a narrowing), never asks. The row carries the
link's `accentDim` tile and one neutral tag, "Not just members. Keep anything
sensitive out.", in place of "From the folder…": no new hue, because accent is
"yours, active" and amber is "degraded", and neither job is a warning.

**The tension with non-negotiable #5, stated rather than hidden.** #5 says no
*setting* publishes a note, a folder or a visibility class, and that every
grantee is a person. In the pinned workspace the `team` tier, behind a free
sign-up, is close to public, and that is uncomfortable. This decision does
not create that reach: the pin did, on 2026-09-16, and it was already true
of every `team` note there. What changes is that the product now says so, and
offers a narrower position that means the members. It widens nothing. Making
the pinned workspace's `team` narrower than every account (a membership row
per account, or reading pin readers at a scope below `team`) is a different
decision and is not this one: the first would turn `listMembers` into a
directory of everyone on the platform.

**What a "simplification" would cost.**

- Calling `team` "Everyone in @context-lc" again, or keying the words off
  `pinned` (absent for the owner): the owner is told a note reaches the people
  on People when every account can open it. Fails:
  `apps/mobile/__tests__/allContextUsers.test.ts` ("team is All Context
  users", "every sentence about team says every account"),
  `apps/convex/__tests__/pinnedContext.test.ts` ("everybody's row says its
  team tier is every account").
- Reading a members grant as Restricted or as a group (it is a list token to
  the owner): a note every member can open drawn as owners only. Fails:
  `allContextUsersDialog.test.ts` ("a members grant is the Members position"),
  `allContextUsers.test.ts` ("never Restricted").
- Rebuilding a list without the `members` kind, or leaving it on a tier
  write: the grant silently vanishes on an edit, or survives a press of
  Restricted. Fails: `apps/convex/__tests__/nodes/membersPosition.test.ts`,
  `apps/convex/__tests__/grants/addGrantees.test.ts` ("a members grant
  stays"), `allContextUsersDialog.test.ts` ("adding somebody keeps the
  members grant").
- Dropping the confirm: one press opens a note to anyone who signs up. Fails:
  `allContextUsersDialog.test.ts` ("All Context users asks first").
- An AI told "team notes" in `@context-lc`. Fails:
  `apps/mcp/test/pinnedTeamWords.test.mjs`.
