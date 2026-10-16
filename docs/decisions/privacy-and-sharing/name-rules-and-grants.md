# Privacy and sharing — name rules and grants

### Domain-based membership is not built, and would be an invitation, never a grant

"Anybody with an `@acme.com` address is in this workspace" is one sentence and
three separate decisions, none of which the current model makes:

- **A domain is not a person, and membership is per-identity.** Every row in
  `workspaceMembers` names a `userId`, every grant is revocable per person, and
  the audit trail records the acting identity. A rule that admits a *class* has
  to resolve to those rows at some moment, and choosing that moment is the whole
  design: at sign-in (a member appears without anybody adding them) or at first
  access (the workspace's member list is not the list of people who can read it).
  The first is the only one compatible with "audit records the acting identity".
- **It has to prove the domain, not read the string after the `@`.** An email
  address on an account is evidence only if it was verified, and Context's own
  sign-in is the only thing that verifies one. A rule keyed on an unverified
  address is a rule anybody can satisfy by typing.
- **It must not become an oracle.** Today an invitation is addressed to a string
  and resolved on acceptance precisely so that inviting `@lk` and inviting
  somebody who does not exist are indistinguishable. A domain rule that reported
  how many people it matched, or that behaved differently for a domain with no
  accounts, would be the enumeration endpoint that design exists to prevent.

The shape that fits: a **standing invitation** on the workspace, addressed to a
verified domain instead of to one identity, with a role, an expiry, and a
revocation — a `workspaceInvitations` row with `inviteeKind: "domain"`, consumed
by an account whose *verified* address matches, producing an ordinary
`workspaceMembers` row with `invitedBy` set to whoever created the rule. That
keeps every downstream invariant: membership stays per-identity, the audit
records who joined and under which rule, revoking the rule stops future joins
without touching the people already in, and nothing anywhere reports who
matched. It is a row and a resolver, not a new access model — which is why it is
worth waiting to build properly rather than special-casing into the invite box.

### A `@name` rule grants somebody something, which it did not until now

`canSee` has taken a fifth argument — the set of names the caller reaches —
since the group namespace existed, and **nothing in the product ever passed
it**. A search for a five-argument call matched the function's own definition
and nothing else, in both engines. So `2-areas/hr: @atlas-leads` was a rule
with no read path: readable by owners, who read at `private` scope and
short-circuit before any rule is consulted, and by nobody else on earth, the
people in the group included.

Everything around it was built. The manifest grammar parses and validates a
group scope; `workspaceGroups` and `workspaceGroupMembers` exist with their
intersection rule; `setNoteGroup` writes the rule with its own audit line;
`GroupMaker` in the share dialog makes a group out of the people in front of
you. The clearance those all rest on was never handed out, and no test noticed
because every test asserted the *refusal* — which passed for the wrong reason,
since nobody could see the note at all.

**The clearance replaced `scope` rather than being added beside it**, and that
is the whole implementation decision. Threading a second parameter through
about twenty-five `canSee` sites in `fileOps.ts` risks missing one; every miss
fails closed, which is the right direction and still a bug nobody would find
for months. `Clearance` is one value, so a site that was not updated **does not
compile** — `options.scope` no longer exists. The compiler is the completeness
check, which is what this repository means by a guard nobody has checked not
being a guard.

**The engines' own signature did not change.** `canSee`'s fifth parameter stays
optional in the port and in the gateway alike, because
`__tests__/privacyEngine.test.ts` runs the gateway's actual functions beside the
port over one matrix, and a port whose signature diverges from the original is
the divergence rather than the repair. The threading is the control plane's
business.

**A name is not a tier.** `Scope` stays two-valued, in both engines and in every
grant. A granted name widens what a `team` caller reaches one rule at a time and
never becomes a third clearance — the same shape the unlisted share took, a row
beside the manifest rather than a third word in it, and what keeps a rollback a
lost feature rather than a bucket that reads private.

**A rule may name one person, not only a group.** `@kola` resolves through
`resolveAddressedUser` exactly as an invitation's addressee does — a `names`
claim of `kind: "user"`, or the sole owner of a **personal** workspace with that
slug, which is what a handle actually is today. Decided by the owner
(2026-09-17) when the alternative on the table was minting a group of one behind
their back. The cost, stated rather than left to be found: a colleague's handle
now appears in `privacy.md`, a file that syncs to Obsidian and travels on
export. A user **id** there would be unreadable and would make the manifest a
directory of the workspace's membership; a handle the owner typed is neither,
and it is the same string the addressing scheme already puts in `@name/path`.

Five things hold it, and each fails a test in `__tests__/namedAccess.test.ts`:

- **Both sources are intersected with live membership.** A group row grants
  nothing by itself — the property `resolveGroupMembers` was written for, now
  load-bearing on the read path rather than only on the console's listing — and
  a handle is put back through `resolveAddressedUser` rather than trusted from
  the gathering step, which `identifiersForUser`'s own docstring demands.
  Dropping somebody from a group closes the folder without a byte of the
  customer's storage being touched, which is the whole reason the reference and
  the fact were split.
- **A group of another workspace reaches nothing here.** The first version of
  that test passed with *both* workspace checks deleted, because
  `buildGroupName` derives the name from the slug, so the other workspace's
  group was `@elsewhere-leads` and could never have matched `@atlas-leads`
  whatever the resolver did — a test of the naming scheme wearing a tenancy
  test's clothes. The real attack is a hand-edited manifest naming the *other*
  workspace's group, whose membership its owner cannot see or resolve. Found by
  sabotage, which is the only thing that could have found it.
- **The resolver refuses on its own authority.** Its membership check and its
  `resolveAddressedUser` authority are both unreachable through `listFiles` —
  `authorizeFileAccess` refuses a non-member first, and a handle normally
  resolves to its owner — and both were unprotected until sabotage said so.
  They are driven directly now, because the guard that holds when a future
  caller does neither is exactly the guard worth having.
- **A pinned context grants no name.** The pin is reach rather than membership,
  and `grantedNamesFor` answers from `workspaceMembers`, which a pinned reader
  has no row in. Widening that would mean deciding a pin confers group
  membership, which nobody has decided and no audit row would record.
- **`folderVisibleAtScope` learned the same widening.** Every `=== "team"` in it
  had to; missing one makes a group-named folder readable by direct path and
  absent from the tree — reachable only by somebody who already knew its name,
  the exact failure its own nested-rule scan exists to prevent.

**What is knowingly not fixed here, and fails closed.** With fast search
provisioned, a search by somebody the rule names silently omits the notes it
names. `tablesForTier("team")` reads `notes_team_fts` alone and `project.js`
files a `@name` note into `notes_private_fts` — deliberately, to keep its
vocabulary out of every team caller's corpus statistics — so the projection
never offers it, and a hit elsewhere short-circuits the fall-through to the R2
index that would have found it. The R2 path is correct, because it filters on
`isVisible` and nothing else. Fixing it means either putting every group note's
corpus statistics into the ranking of a caller who may see one of them, which is
the inference channel the table split exists to close, or a table per name,
which is unbounded. That is a decision with a cost on both sides and it is not
made here.

### A folder is pointed at somebody by its own action, and its audit row is owner-only

The bug an owner hit, in their own words: "I tried to share a folder with a
group and it's showing me this." The console answered

> Only markdown notes can have their own visibility. Set the folder's default
> instead.

— advice that names the right instrument and **cannot be followed**, because
the control that sets a folder's default takes the two tiers and has no way to
say a name. `shareWithGroup` threw away the `entryKind` the sheet had held all
along and called `setNoteGroup` for everything; that action runs
`fileOps.setVisibility`, which refuses a path that is not `.md`. Nothing in the
engine was ever in the way — `setFolderVisibility` has taken a `Visibility`,
and a name is one, since the group namespace existed. Only the route was
missing.

**`kind` is required rather than defaulted, and that earned its keep
immediately.** The obvious fix is an optional parameter defaulting to `"file"`,
which compiles everywhere and silently keeps the bug on every call site nobody
remembered. Making it required turned the compiler into the search: the fix
started at two call sites in the Browse pane and the type error named two more
in the console frame, which would otherwise have gone on calling the note
action. `__tests__/shareWithGroupRouting.test.ts` lists all four by name and
carries its own self-test, because the matcher passing everything is the way a
structural test fails silently.

**One resolver for the note and the folder alike.** `resolveNamedAudience`
answers both, so the two cannot start disagreeing about the same name — which
is how a folder accepts an audience a note refuses, or the reverse. It also
taught the note path to accept a person's handle, which it did not before.
Every way of failing is one `GROUP_NOT_FOUND`: no such group, a group of
another workspace, no such handle, a handle belonging to a shared context
rather than a person, and a person who is not a member here. An owner who could
tell them apart would have an oracle for which names exist on the platform, and
the tenant-isolation sweep in `files.test.ts` now drives this endpoint too —
the refusal has to come from the workspace check *ahead* of the resolution.

**A name that reaches nobody is refused rather than written.** `grantedNamesFor`
intersects with membership, so a rule naming a non-member grants nothing — but
it would sit in the owner's manifest looking exactly like access somebody had
been given. Same reasoning as `addGroupMember` refusing a stranger.

**The audit action is split, and that is the decision rather than a spelling.**
`visibility.folder` is on `MEMBER_VISIBLE_DETAIL_ACTIONS`, defended there on
the details it carries: its subject is "one a member already sees first-hand in
their own listing". That is true of `private` and `team` — a member watching a
folder learns its default changed the instant their own listing does, so the
row tells them nothing new. **It stops being true the moment the value can be a
name.** A member who is not in `@atlas-leads` sees the folder leave their
listing and learns *that*; the row would additionally hand them the group's
name, which `listGroups` is owner-only to withhold, "for the reason the note
census is: a member who could enumerate them could work out the shape of what
is being kept from them".

So `visibility.folder` goes on meaning the two tiers and stays member-visible,
and `visibility.folder.named` carries a name and is absent from the allow-list.
The gate stays purely **per-action**, which is the shape it was deliberately
given: a value-dependent gate would make a row's shape depend on its contents,
and `pathsWithheld` is computed from the reader and never from the row for
exactly that reason. Both directions are sabotage-tested — adding the action to
the allow-list fails, and recording the named change under the old action fails.

What a member still learns, stated rather than left to be rediscovered: the
row's action, actor and timestamp are ungated, so "the owner pointed this folder
at somebody at 14:02" is visible. That is the incidence signal this file already
leaves open for every other action, and it names nobody.

### The console names the context; the manifest keeps its two words

Asked for by the owner (2026-09-17), in the form of three questions they could
not answer from the screen in front of them: *"what's team? what's private? can
I share a private note with a group?"*

None of the three is a misunderstanding. They are fair questions about words
this product chose:

- **"Private"** is the manifest's word for *owners only*. In a shared context
  that is not "mine", it is "not the members, not the editors" — and somebody
  learns that by marking a folder private and locking out their co-lead, which
  is why `privateMeans` already existed to say so.
- **"Team"** names a set that exists nowhere as an object. There is no team;
  there is this workspace's members, whom the owner invited by name. Worse, it
  is the one word in the product that *sounds* like it might reach further,
  which is the reading non-negotiable #5 exists to forbid.
- **"Can I share a private note with a group?"** has the answer **yes** — a
  note override may name one — and nothing on screen suggested it.

So the console moves to the words this audience already holds, from Drive and
Dropbox: `private` → **Restricted**, `team` → **Everyone in @supa**, a `@name`
rule → **the name**, a link → **Anyone with the link**, unchanged because it was
already honest.

**`privacy.md` is untouched, and that is the point.** It is the stable on-bucket
format (#3), parsed by a gateway that fails *closed* on a rule it cannot read,
so renaming a word in the file would make every note in every bucket private for
anybody on an older deployment. `Scope` stays two-valued. This is the console
speaking, and nothing about what the file means moved.

**Naming the context is the change that does the work.** "Everyone in @supa" is
checkable against the People list; "Workspace" is not. A reader cannot conclude
from a name that it might mean the internet, which is what the old word invited.
Where the handle has not loaded, every sentence has a form that is true without
it — "Everyone in this context" — because a label reading "Everyone in
@undefined" is worse than one that is merely vague.

**`Restricted` claims nothing about who, and the sentence beside it does.** That
is what lets one word be honest in a personal context ("Yours alone") and in a
shared one ("Owners of this context only — not its editors, and not its
members") without either being the default that misleads the other.

Three things hold it, and each fails a test:

- **A group is never labelled "Restricted".** The exact defect `words.ts` opens
  by naming, pointed at the new vocabulary: a note two colleagues can read,
  labelled as reaching nobody but its owner. A live member count rides along
  when the caller knows it, and `undefined` is not zero — a group whose
  membership is still loading must not render as a group nobody is in.
- **The words reach the screen, not just the module.** `audienceWords.test.ts`
  proves what the sentences say; `noteChrome.test.ts` proves the sheet is the
  thing saying them. Both were needed: the first version of this change passed
  every existing test while the dialog went on rendering the old labels,
  because no test read one. The render assertion failed immediately and
  correctly — no caller was passing the context yet.
- **A half-rename fails.** `privacyPanelRender.test.ts` asserts the *retired*
  words are absent from the whole panel, not merely that the new ones appear.
  That assertion exists because renaming the pills without the prose around
  them shipped a panel saying "Restricted" over a paragraph explaining how to
  "mark it team" — two vocabularies for one question, which is worse than
  either alone and is precisely the confusion being fixed.

**And the padlock that this was going to remove had already gone.** The three
functions modelling it — `nextScope`, `SCOPE_ICON`, `scopeActionLabel` — were
imported by nothing but the tests describing them, dead since the audience moved
into the sheet as named positions. Deleted rather than deprecated. The property
they carried is not: *no single press takes a note from private to a public
link*, which is now asserted against `stepsTo`, the model the sheet actually
drives, where reaching `anyone` from `private` is two steps and the public one
is confirmed in words. `accessSummary` went the same way, replaced by the shared
vocabulary rather than left beside it.

### A note shared with a named person opens for them wherever it lives (decided by the owner, 2026-10-14)

Until now a share addressed to a person read its note at `team` scope with no
granted names, so it opened only if the workspace already published that note
to its own members. A personal workspace scaffolds everything `private`, so
sharing a note from your own workspace with a friend produced a link that
refused them, every time. The owner was asked whether a named person should be
able to read a note shared with them even when it is private, and answered
"yeah, lets use google drive behavior, people are used to that".

So, Drive's rule, and exactly as far as Drive goes:

- **Only the entry note widens, and only for a share addressed to a person**
  (`recipientKind` `name` or `email`). It is read at `private` scope, the
  owner's own clearance, because the owner pointed that one note at that one
  account. `shareStillStands` still decides that the share is live and the
  caller is the identity it names, so nobody else holding the token gets
  anything.
- **Everything the note links to is still read at `team` scope.** Sharing a
  note is not sharing what it mentions; a private note linked from it stays
  absent, as it would in Drive.
- **Links never widen.** A team link, an anyone-with-the-link share, a folder
  link and a short link are not addressed to anybody, so they keep reading
  through the live `privacy.md` exactly as before, and a note moved into a
  private folder is absent through them.
- **Plumbing never opens.** `privacy.md` and everything under a dot-folder are
  refused on the live path, after forwarding, whatever the share says.
- **Moving the note keeps the share; revoking ends it.** A share follows its
  note (see "A share follows the note"), now into a private folder too, because
  filing a note is not taking back a share. Revoking is.

`team` still never means public: this is one named reader, minted and
revocable by the owner, never a setting and never a third word in
`privacy.md`. The person finds what was shared with them in @shared, the
account-wide list beside their workspaces (`shares.listSharedWithMe`).

A "simplification" back to one scope for every share would make sharing from a
personal workspace impossible again. `apps/convex/__tests__/shareRead.test.ts`
("a note shared with a named person opens wherever it lives") fails if the
entry note refuses its named reader, if a stranger with the token gets it, or
if a private note linked from it opens; `shareSurvivesMove.test.ts` fails if a
link follows a note into a private folder.

### A tier keeps the owner's list; only a list names people (2026-10-16)

In rows mode a row's base (`private`, `team`, or inherit) and its list are
separate. A change between `private` and `team` that names no list keeps the
owner's list as it is. A given list replaces it, and `[]` is the explicit way to
clear it. A reset to `inherit` clears the owner's list too: inherit means "share
exactly like the parent", and a list left behind would be a grant the console no
longer shows. The gateway sends `grantees` only when the caller passes one, and
the console's tier verb sends none. Before this, a tier change cleared the list,
so making a note `team` quietly removed every person the owner had named.

The owner names people with `nodesAccess.setGrantees`: a handle (a group of
this workspace, or one of its members), a group id, or an email. Someone
outside the workspace is named by email only: an email grant is stored whether
or not an account holds it, so no answer says whether a handle exists anywhere
else, and an outsider's handle gets the same refusal as a handle nobody holds. Every entry that does not resolve gets one refusal, `GRANTEE_NOT_FOUND`,
with nothing else in it, and nothing is written. A missing account and a
deleted one are the same refusal. A member or an editor is `FORBIDDEN`. A
non-member, or a path with no row, is `NOT_FOUND`. Each list is capped at 100
entries, and past that it is `INVALID`.

Every change of the owner's list writes one `access.list` audit row, with the
row's id, counts, and grantee ids. An email is audited only as a SHA-256 of its
lowercased form. A refused change writes no audit row.

What a "simplification" would cost: a tier change that clears the list leaves
outsiders' access to go away silently, an inherit that keeps the list leaves a
grant nobody can see, and a refusal that names what failed is an oracle for
whether a handle exists. A reset to inherit by an editor, on a row with an
owner's list, is `FORBIDDEN`, since it changes the list. `setAccess.test.ts`,
`setAccessLists.test.ts` ("a tier change keeps the owner's list", "101
grantees are refused", "a missing account and a deleted one") and
`setGrantees.test.ts` ("one refusal for every grantee that does not resolve")
fail if either is reverted. The gateway's `setAccessBody.test.mjs` fails if
it sends `grantees` for a tier.

## An edit grant lets a member write one note's body

*Built on 2026-10-16 (edit-grants, PR 2).* A workspace `member` who holds the
edit name of the row that governs a note (`lib/nodes/governingRow.ts`, the walk
`canSee` makes) may write that note's body through `writeNote`. Nothing else
is opened: moves, renames, trash, archive, copies, sharing, groups, images,
mail and creating a note stay `editor`. The new text may not carry a form
block, since that creates response files. A path that is not canonical (`..`,
`.`, empty segments, backslashes) is refused for a member, because the walk
reads the path as written.

Every refusal is the `INSUFFICIENT_ROLE` a member without a grant gets, so a
member cannot tell an ungranted note from one that does not exist.

What a "simplification" would cost: reading the grant from the rendered rules
loses a team-base row's list, and a write that trusts the path text lets a
`..` walk into another folder's notes. `__tests__/files/memberEditWrite.test.ts`
fails if the grant is ignored, a form block is allowed, or a non-canonical path
is not refused; `__tests__/files/memberWriteCoverage.test.ts` fails if any other
console write takes the member path.

## Email grants match a member's confirmed addresses

An email grant on a row (`nodeAccess`, `granteeKind: "email"`, stored lower
case) used to match nobody: `grantedNamesFor` passed the caller's user and
groups to `accessNamesFor` and no emails. Now a member holds the grant when the
address is one they have proved they read: their main `users.email` once it is
verified, or an added sign-in email. `ownedConfirmedEmailsOf` (`lib/signInEmails.ts`)
gives that list, and drops any address that `accountForEmail` does not give to
this same account. A full account holds one main address and ten added ones,
so the list is bounded at eleven, and the newest added address still grants.
Membership is still checked first, so a non-member gets
`[]` as before; outsiders are a later slice.

An address two accounts hold matches neither of them. That state is one the
add flow refuses to create, but old rows predate it, and the owner's grant
cannot say which person was meant, so both get nothing. Unverified
`users.email` matches nothing, as it does everywhere else in sign-in and
sharing.

What a "simplification" would cost: dropping the ownership check lets an address
that someone else also holds open a private note to both of them, which is a
wider grant than the owner named. Dropping the `emails` argument turns every
email grant back into a silent no-op, and the owner sees a grant that never
works. Counting an unverified address as proved lets anyone who typed a
person's address into their own unverified profile read notes granted to that
address. `emailGrants.test.ts` fails on each of these: "an added, confirmed
address grants a member the note", "an address two accounts hold grants neither
of them" and "an unverified users.email grants nothing" (which needs both
verified checks broken, since the ownership lookup refuses an unverified
address too).

## Outsiders read what they were granted, through the share path

*Built on 2026-10-16 (outsider read, slice 2).* A row's access list can name an
account that is not a member of the workspace (`granteeKind: "user"`), or an
address that account holds (`granteeKind: "email"`, counted only when
`ownedConfirmedEmailsOf` gives it to that account alone). Such a person reads
what was granted to them, read-only, and nothing else.

- **Found, then re-derived.** `nodeAccess` is found through two global indexes
  (`by_grantee_user`, `by_grantee_email`), bounded at 200. Each candidate is
  judged again from its workspace's live rows: the names come from
  `accessNamesFor` over `accessRowsOf`, the node must be live, and `canSee` at
  `team` scope with those names over the **guest** rendering
  (`renderAccess(rows, "guest")`) must open the path.
- **The guest rendering never shows `team`.** A row a member can see because of
  its `team` base is `private` to an outsider. Only a row that names them (by
  account or by a confirmed address) opens to them.
- **One path, one decision, through the share read.** `shares.readGrantedNote`
  (a note, by its stable id or by a path under a grant) and
  `shares.listGrantedFolder` read through `readThroughShare` at `team` scope with
  the caller's names. A folder grant covers its subtree, and every path beneath
  it is decided again: a private subfolder, a note held back by name, and a note
  the members can see are all absent. A listing is filtered entry by entry.
- **One refusal.** Not granted, not there, trashed, granted in another
  workspace, a member, and a grant the live rows no longer name all answer
  `SHARE_UNAVAILABLE`, with the same message. A signed-out caller gets
  `NOT_AUTHENTICATED` for every target. A storage failure is passed through.
- **Leaving takes the account's grants along.** `removeMember` and
  `leaveWorkspace` delete that account's `user` grants in that workspace, rebuild
  the snapshot the readers judge by, and write one `access.list` row. Email grants
  are left as they are: they name an address, and the owner who wrote one takes
  it back. (An open question, below.)
- **Edit is read as view.** An outsider's edit grant reads the note and writes
  nothing in this slice.

What a "simplification" would cost. Trusting the candidate grant row, instead of
the names the live rows give, lets a revoked grant, or a grant a stale snapshot
no longer records, keep reading. Judging an outsider by the member rendering
lets anyone holding one folder read a note the members can see, which is the
`team` base that non-negotiable #5 forbids reaching the internet. Leaving the
departed member's account grants in place turns "removed" into a read the owner
did not keep. `outsiderRead.test.ts` ("the candidate row is never trusted on its
own", and "a note the members can see is not opened to an outsider by a folder
grant") fails on the first two. "every refusal is the one answer" pins the
byte-identical refusal, and `outsiderRemoval.test.ts` ("removeMember deletes the
user's grants in that workspace and audits the change") fails on the third.

Open, and not decided here: an email grant on a removed member's address still
reaches them as an outsider. Removing it too would be a second decision with its
own cost (an owner who named a person by address and then removed them from the
workspace for an unrelated reason would lose that address's grant without being
asked), so this slice leaves it and says so.
