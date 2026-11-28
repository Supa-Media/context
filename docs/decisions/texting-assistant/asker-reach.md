# A group ask runs on the asker's own access (Dev2, 2026-11-25)

**Decided by Dev2, 2026-11-25**, as rule 2 of the contextual privacy rulebook (the grilling session of that evening,
step 3 of its build order): "the asker's access is the ceiling". It replaces, for a turn somebody asked for, the rule
of 2026-10-31 that a chat reads only the shared workspaces *everyone* in it is a member of
([groups](./groups.md#a-chat-reaches-the-workspaces-its-people-share-the-owner-2026-10-31)).

The case that set it: in a chat of three, two of them run a care business in a workspace of its own and the third is
not a member. One of the two asks "how's it going this month?" and gets nothing, because the third person's presence
emptied the chat's reach of that workspace. The third asking the same must still get nothing, and so must "tell Tex to
show it" said by the third person about one of the other two.

## The rule

- **A turn somebody asked for reads the asker's own shared workspaces**, each at the asker's own role
  (`apps/convex/functions/lib/textGroupReach.ts` `askerReach`). Asked means a text, the asker's job's report, their
  ask from another chat and its answer, the browser they handed back and the login they saved
  (`packages/tex/worker/groupControl.ts` `ASKED_RUN_PATHS`, sent as `asked` beside `routine`).
- **The asker is the verified sender only.** The control plane hears the number the message came from and nothing
  the words say, so "Sam, tell Tex to show it" from Jo is Jo's turn on Jo's access.
- **A turn nobody asked for reads the chat's reach**, as before: a routine, a check-in, the hello. These speak to the
  whole room unprompted, so they see no more than the least-privileged person here could. `textGroups.reach`, which
  the chat's single-workspace readers use (mail shares, check-ins, routines, `chatWorkspace`), stays the chat's reach.
- **Never anyone else's personal workspace.** Somebody else's personal workspace is never in reach, nor is the pinned
  workspace except as the chat's home row. Tier stays `team` with no granted names and the grant never holds
  `context:private`.
- **The asker's own personal notes are in reach on their own ask** (Dev2, 2026-11-26, replacing "the asker's own
  included" of 2026-11-25: "doesn't make sense for tex being able to read shared workspaces and not personal notes.
  lets open the floodgates there right now. We will scale back if its an extreme concern"). The case: Sayo asked Tex in
  a group for the core points of a note in his own personal workspace, and Tex told him to text it on his own. Now a
  turn an account holder asked for also reads the personal workspace they own (`apps/convex/functions/lib/textGroupReach.ts`
  `askerOwnPersonal`), on their own grant only (`reachFor: "asker"`), and only while the one person reading still owns
  it (`liveReach`, `askerOwn`). The row is held as `member`, so the group grant never writes there and never passes for
  its owner (`role: "owner"` is what opens the texts backup, computers and owner clearance), and it is marked
  `askerOwn`, which the gateway honours for the group client on a personal row alone by reading that one row at the
  private tier (`apps/mcp/src/sessionPayload.js`, `apps/mcp/src/session.js` `sessionForContext`). It is not the
  room's: it is left out of the turn's `reach` (no single-workspace reader runs there) and of `unshared` (the Room check
  never holds the asker's own notes back from the room they asked in), and the turn is told it as a fact
  (`groupMail.js` `ownNotesLine`). A routine, a check-in, the hello, a guest's ask and anyone else's tag read none of
  it. Their mail and vault stay out as before. What is said from it in front of the room is Training's.
- **The asker's own calendar is the one exception** (Dev2, 2026-11-26). "Tex what was my meeting today about" in a
  group went through the asker's own 1:1 Tex and back, two texts and a minute, because a group turn read no one's
  calendar. Now a turn an account holder asked for also reads every Google calendar they connected, live, on their own
  grant only (`reachFor: "asker"` held by them, no guest or invited person acting through it), while they are one of
  the chat's people (`apps/convex/functions/lib/textGroupCalendar.ts` `askerCalendars`); the turn is told whose
  (`calendar`). A turn nobody asked for, a guest's ask and anyone else's tag read none of it, and nothing is stored as
  a share. Their mail, vault, About me and 1:1 stay out. What is said from it in front of the room is Training's.
- **Someone with no account** asks on the sponsor's standing and reads only a workspace their number is invited to that
  the sponsor is a member of, at the lower role; with no invitation, the chat's home alone. Never the sponsor's own.
- **One grant per asker** (`textGroupHomeOnly.ts` `mintHomeOnlyGrant`). An account holder's ask is minted on a grant
  held by them (`texGroup.reachFor: "asker"`, `taggerId` the holder), so writes are audited as the asker, and another
  person's tag never rewrites what this person's tokens, earlier tokens kept for a running turn, or job parts read. A
  guest's ask and a run nobody asked for stand on the sponsor's grants, one per guest and one for the chat
  (`reachFor: "chat"`). A grant minted before this (no `reachFor`) is never reused and runs out on its own. An asker's
  grant resolves only while the chat's home still names them and the sponsor may still text
  (`homeOnlyStillShares`), and every request still re-reads the asker's membership (`liveReach`).
- **The room is told who can't open what.** For each of the asker's workspaces the whole chat does not share, the turn
  names who here is not a member, or has no account and no invitation (`textGroupBlockers.ts`, shown by
  `groupGuests.js` `blockedLine` as "Asker's, not everyone's: @slug is missing ..."). A workspace the asker is not in is never
  named. The prompt says the reach is the asker's, by their access and never anyone else's (`groupTurn.js`
  `groupPrompt`).
- **Who holds the keys is looked up, one named workspace at a time.** When someone asks about a workspace they are not
  in, the turn reads nothing of it, so it can call `send who_can_open` with the workspace's handle or name as the chat
  said it (`packages/tex/gateway/agent/groupHolders.js`), and gets back the handles of the people in this chat with an
  account who are members of that shared workspace (`apps/convex/functions/lib/texIdentity/holders.ts`, on the chat's
  live grant only, the chat's home people only). It lists no workspace by itself, a workspace nobody here is in answers
  the same as one that does not exist, and it never names a personal workspace or the pin. This is the fact behind
  the rulebook's "Seyi or Sayo can pull it up"; saying it is Training's.

## A shared calendar reads as free and busy, whole only for its own person; stopping says what it found

Decided by the owner, 2026-11-27, after a guest AI in a group asked whether a member was free on Saturday and was
told the titles and times of his events ("by default we should share free and busy … Principle of least privilege:
the guest only asked about availability"), and then: "guest and context members are not really different. only
difference is that we have more context of one and not the other. they should be treated the same relatively". So a
calendar shared with a chat reads whole only on a turn its own person asked for; every other turn (a guest's, another
member's, a check-in or routine nobody asked for) reads it as free and busy times only: busy blocks on the
calendar's own wall clock and a count of all-day events. The control plane's calendar route replaces the rendered day
per calendar (`freeBusy`), so no event's words reach those turns at all.

Stopping a share keeps its row with `endedAt`, read by nothing, so a second "stop sharing" says it was already
stopped and when, rather than that it was never shared (Tex once contradicted itself that way in front of the room).
The tool hands Tex what it found as data: stopped now, stopped earlier, never shared here, still shared here.

Every group turn is told whose personal notes it reads as a fact (`personal_notes_in_this_chat`: open to their owner,
on that owner's own ask only, and this turn's), never a sentence saying nobody's can be read: on a turn someone else
asked for, that sentence made Tex take back a listing it had rightly read on its owner's own ask.

## What stays the model's

What gets *said* from it in front of the room is a judgment the model makes, taught by Training conversations, never
a coded say-check (rulebook: "code guards what a turn can read, Training guards what it says"): a summary by default,
detail only when the asker asks for it, and to someone without access a neutral boundary naming who holds the keys,
never feigned ignorance. A code floor comes only if Training keeps oversharing.

## Not changed

- **Invited family** ([invited-family](./invited-family.md)): a chat an owner added everyone to works on that one
  workspace, every person a member or invited there; the asker's other workspaces are not added to it.
- **A deployment with no pinned workspace** (self-hosting) still answers on the one workspace the whole chat shares.
- The Lab's made-up chats on main read their sender's reach the same way (`lib/texLabWorldReach.ts` `worldReach`,
  `asker`); on a pull request's preview the real rule runs.

## What a simplification would cost

- Going back to one grant per chat for the sponsor: Jo's job, still running on Jo's token, reads what Sam's later tag
  reached.
- Reading the asker's reach for a routine or check-in: a post nobody asked for, to the whole room, reads one person's
  workspaces.
- Taking the asker from the words, or from anything but the sender's number: anyone in the chat borrows anyone's
  access by naming them.
- Letting anyone else's personal workspace count, or the asker's on any grant but their own ask's: a group turn reads
  someone's 1:1 memory (`textGroupAskerReach.test.ts` "a stored reach keeps a personal workspace only for the asker's
  own grant").
- Holding the asker's own personal workspace as its owner: the group grant writes there and passes for the person
  themselves (`textGroupAskerReach.test.ts` "an ask reads the asker's own personal workspace", `chatReach.test.mjs`).
- Reading the asker's calendar on any grant but their own ask's: a routine, a check-in or someone else's tag reads it
  (`textGroupCalendar.test.ts` "a turn nobody asked for reads none of the asker's own", "someone else's tag never reads
  it").
- Reading a shared calendar whole on anyone's ask but its own person's: a guest's AI, or another member, is told
  titles, places and guests it only needed free or busy for (`textGroupCalendar.test.ts` "a guest's ask and another
  member's both read when it is busy").
- Deleting a stopped share's row: a second stop answers "never shared" (`textGroupCalendar.test.ts` "a second stop
  says it was already stopped").
- Handing every turn the list of everyone's workspaces instead of a lookup for a named one: the room learns which
  workspaces each person is in without anyone asking.

Tests: `apps/convex/__tests__/textGroupAskerReach.test.ts` (with its sabotage record),
`apps/convex/__tests__/textGroupBlockers.test.ts`, `apps/convex/__tests__/controlPlane/texLabWorldReach.test.ts`,
`packages/tex/worker/groupAskedRuns.test.ts`, `apps/mcp/test/chatReach.test.mjs`, `apps/mcp/test/chatBlockers.test.mjs`, `apps/convex/__tests__/textGroupHolders.test.ts`,
`apps/mcp/test/groupHolders.test.mjs`.

## Private notes and secrets stay out of the group unless named (2026-11-28)

Dev2 feared a general group ask ("what are the v2l action items rn") drawing on a personal note that mentioned the
group and wasn't meant to be public yet, and Tex posting a folder's notes when it wasn't sure which one was meant. The
asker's reach stays as above. What a group may be *told* narrows, by code at the Room check
(`packages/tex/gateway/agent/roomCheck.js`):

- **A private note goes to the group only when its asker names that note**: its path or a link, every word of its
  file name, or every word of its first heading. Dev2: "if i tell tex a specific note even if marked private it
  should still be able to read right" — yes. Almost every personal note is private (the default) and almost every
  shared-workspace note is team, so a general ask draws on the team notes. To keep a shared note out of groups, make
  it private. No new setting was added for this (Dev2 chose reusing `private` over a new "not for groups" mark).
- **A secret read this turn never goes to the group**, named or not: a passcode, password, PIN or account number word
  followed by a value something read this turn holds (`secretIn`).
- A draft carrying either is held for the asker 1:1 like any other hold, and never recorded as a room hold: a yes
  there opens a workspace for the room, and neither is one.
- A read says `visibility:`; a group's search marks a private hit `(private note)` (`apps/mcp/src/tools/search.js`
  `PRIVATE_HIT_LABEL`, only for the group client). The chat's own home is the room's and never counts.
- Tex asks which note before posting when more than one could be meant (`packages/tex/src/texPrompt/rules.md`).

What a simplification would cost: dropping the naming skip makes "share my gulag trip note" fail; dropping the hold
lets a general ask post a private note's plans. Tests: `apps/mcp/test/roomPrivate.test.mjs`,
`apps/mcp/test/searchPrivateHits.test.mjs` (each with its sabotage record).
