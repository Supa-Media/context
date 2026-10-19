# Privacy and sharing — All Context users

_See `docs/decisions/README.md` for the index._

### In the pinned workspace, `team` means its members, and All Context users is its own grant (decided by the owner, 2026-10-19)

**This supersedes the decision below, made the same morning.** That one kept
the data as it was and changed the words: `team` in `@context-lc` was read by
every account through the pin, so the console called it All Context users and
added Members (base `private` plus a `members` grant) for the people actually
invited. The owner then decided that `team` must mean real members there, as in
every other workspace, and that "All Context users" is a level of its own.

**Why the morning's version was not enough.** It left two meanings of `team`,
one of them close to public, and its Members position did not work where it
mattered: an ordinary MCP grant carries no granted names (`contextsForGrant`
hands them to the console's client only), so a `members` grant hid a note from
every member's AI client. In production the Areas folder, which holds the `ai/`
notes a benchmark runner reads through MCP, was set to Members and went dark for
that runner.

**What the data means now.**

| Position (pinned workspace) | Data |
|---|---|
| Restricted | base `private` |
| Members of @context-lc | base `team` (a row written the morning's way, base `private` plus the `members` grantee, reads the same) |
| All Context users | base `team` plus the built-in `accounts` grantee, view only |
| Anyone with the link | a share row |

**The `accounts` grantee** (`Grantee.kind "accounts"` in `lib/nodes/rowAccess.ts`
and its gateway port) is held by a caller marked `account: true`: every
signed-in account, members included. It is honoured in the pinned workspace
(`pinnedContextWorkspace`) and nowhere else: `wantedOf` in `lib/nodes/setAccess.ts`
refuses to write it anywhere else and refuses `edit`, and `withAccountsHonoured`
in `lib/nodes/accessRows.ts` drops one that reached the table some other way, so
it grants nothing on read either. **This is the one exception to
non-negotiable #5's "every grantee is a person"**: a grant to every account,
behind a free sign-up, close to public. It is allowed in exactly one workspace,
which staff own, and the dialog confirms it in place before it is written.

**A pin reader reads as a guest** (`lib/pinnedReaders.ts`). Somebody who
reaches `@context-lc` through the pin alone has no membership row, so they are
cleared the way an outsider is: the rows rendered for guests, where `team` never
appears, and as names the tokens of the rows granted to `accounts`. Beside those
they hold `#reads-as-guest`, carried in `grantedNames` because every read path
already carries those from where a caller is resolved to where a path is judged:
`resolveFileAccess` (console reads, listings, the feed, forms, search),
`contextsForGrant` (every MCP session, for every client, not only the console's),
`openStorageBinding` (the binding then hands the gateway a guest's rules), and
`gatewayReadClearance` (the gateway's tree routes). The mark does two jobs: it
says which rendering to judge by (`audienceOfNames`), and `canSee` shuts `team`
to whoever holds it even where a reader was handed a member's rules, so a read
path that missed the change fails closed rather than open. A real member keeps
`team`, holds the `accounts` names too, and so reads every note but a private
one; their MCP connection reads `team` with no names at all.

**The bug reports are members only.** `bugNotes.shareWithTeam` writes a report at
base `team`, and still refuses to write into a folder a pin reader could read,
judged by the guest names (`guestNamesIn`).

**Nothing goes dark: the switch waits for the migration.** Every row that was
`team` was readable by every account, and reading pin readers as guests before
those rows carry the `accounts` grant would shut every account out of the
guides, the forms and the website. So pin readers read exactly as before until
`nodeMigration.pinnedAccountsAt` is set, and `functions/pinnedAccounts.ts` sets
it. Staff run it once per deployment, staging first, after the deploy:

    npx convex run functions/pinnedAccounts:start

It pages the pinned workspace's rows (each page its own transaction): first every
live base-`team` row outside the Areas folder's `tex-bugs/` gets the `accounts`
view grant, and the last page of that pass sets the switch in the same
transaction; then every row in the morning's Members position, notes and folders
alike, becomes base `team` with the `members` grant removed. It is idempotent and
can be started again. Until the switch flips, the console writes Members the
morning's way (`positionOf` in `functions/nodesAccess.ts`), which the second pass
converts, so nothing written in the window reaches every account by accident.
Between the deploy and the run, a plain `team` row is drawn as Members although
pin readers still read it, as they did that morning; the run is the release's
last step for that reason.

**What a "simplification" would cost.**

- Reading pin readers at `team` again, or dropping the mark from their names:
  every account reads every members' note, the bug reports included. Fails:
  `apps/convex/__tests__/pinnedReaders.test.ts` ("sees the All Context users notes
  and nothing else", "an MCP session carries the guest mark", "the binding hands
  the gateway a guest's rules", "the gateway's tree manifest").
- Letting `team` through for the mark in `canSee`: any read path judged by a
  member's rules opens every team note to a pin reader. Fails:
  `apps/convex/__tests__/nodes/rowAccessPort.test.ts` ("the guest mark") and
  `apps/mcp/test/privacy/readsAsGuest.test.mjs`.
- Honouring `accounts` anywhere: a setting that publishes a note to every
  account, in any workspace. Fails: `apps/convex/__tests__/nodes/accountsGrantee.test.ts`.
- Flipping the switch before the grants, or skipping folders in the second pass:
  the guides go dark for every account, or a member's MCP client cannot read under
  a folder that was Members. Fails: `apps/convex/__tests__/pinnedAccountsMigration.test.ts`,
  `pinnedReaders.test.ts` ("an ordinary MCP session ... reads a note under the
  folder that was in the Members position").
- Filing bug reports the morning's way after the switch, or judging the
  pre-write check as a member: a member's AI cannot read them, or a report lands
  where every account reads it. Fails: `apps/convex/__tests__/controlPlane/bugNotes.test.ts`
  ("once the pinned workspace has moved ...").
- Calling `team` All Context users in the console again: the owner is told a
  members' note reaches every account. Fails:
  `apps/mobile/__tests__/allContextUsers.test.ts` ("team is the members"),
  `allContextUsersDialog.test.ts` ("plain team is Members").
- An AI told that team notes in `@context-lc` reach every account. Fails:
  `apps/mcp/test/pinnedTeamWords.test.mjs`.

### Superseded: in the pinned workspace, `team` is shown as "All Context users" (decided by the owner, 2026-10-19, morning)

_Superseded the same day by the decision above. Kept for the reasoning; the
flag it names is now `offersAllContextUsers`, and the data it describes is no
longer what the positions write._

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
