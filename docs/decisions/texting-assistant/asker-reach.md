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
- **Never anyone's 1:1 memory.** A personal workspace (a person's mail, calendar, vault, About me and their 1:1 with
  Tex) is never in reach, the asker's own included, nor is the pinned workspace except as the chat's home row. Tier
  stays `team` with no granted names and never `context:private`.
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
- Letting a personal workspace count: a group turn reads someone's 1:1 memory, mail and calendar.

Tests: `apps/convex/__tests__/textGroupAskerReach.test.ts` (with its sabotage record),
`apps/convex/__tests__/textGroupBlockers.test.ts`, `apps/convex/__tests__/controlPlane/texLabWorldReach.test.ts`,
`packages/tex/worker/groupAskedRuns.test.ts`, `apps/mcp/test/chatReach.test.mjs`, `apps/mcp/test/chatBlockers.test.mjs`.
