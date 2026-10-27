# A group chat with people who aren't on Context reads only what is shared with the chat (2026-10-25)

Tex in a group answered only when every person in the chat was linked to an
account and all of them shared one workspace ([groups](./groups.md)). One
friend without an account, and Tex said "Text me on your own instead" and did
nothing, not even a web search. The owner wanted Tex to plan a trip with a
group of friends ("find flights and etc between us") and called the rule a
blocker. They proposed guest mode, and chose every default below on
2026-10-25 ("yes" to all five).

## How it works

- **"Tex, use @slug" from an owner or editor of that workspace turns guest
  mode on**, whoever else is in the chat. Any workspace they own or edit
  counts, a personal one included. Nobody else can turn it on: it opens part
  of their workspace to people who aren't members, so it is theirs to do.
- **The chat gets its own group in that workspace**, named with three words
  (`@<slug>-chair-blast-tiger`), and its own folder, `tex/chats/<words>/`,
  shared with that group to edit. The words are picked at random and checked
  against the global names table like any group name.
- **Everyone in the chat is a guest of the chat**, accounts or not. People
  joining and leaving the chat join and leave it with no step from anyone.
  Each tag brings the workspace in line with who is in the chat
  (`textGroupGuestSync.ts`): a workspace member in it is put in the chat's
  group (a row marked `viaChat`, taken out when they leave; a row the owner
  added is never touched), and someone with an account who isn't a member is
  named on the chat's folder row to edit, so the app shows them that folder
  and nothing else of the workspace (a group row would reach nothing for
  them, and membership is an invitation, which is the owner's). Someone with
  no account is named at the first tag after they link a phone. Only account
  ids are written on rows, never a number (a guest's number is kept only as a
  keyed hash, so they can open the chat's notes with a texted code:
  [guest-phone-pass](./guest-phone-pass.md)), and an owner who takes the folder from the
  group takes it from the chat's people too. Guest mode off takes back what
  the chat added. Since 2026-10-27 this doesn't wait for a tag (the owner:
  "automatically added/removed when they join or leave a chat"): any message
  in a guest chat whose list of people changed since the control plane last
  heard it sends the new list (`/agent-texts/group/people`,
  `apps/agent/src/groupGuestPeople.ts`), with no turn, no grant and nothing
  said in the chat. Someone who leaves is removed at the next message
  anyone sends.
- **Tex reads and writes only what is shared with the chat's group.** The
  chat's grant reads that workspace as a guest (`READS_AS_GUEST`): it holds
  the names of the rows granted to the group and nothing else, so `team`
  notes, private notes and notes shared with anyone else are absent. A note
  someone wants the chat to see is shared with the group, the same way a note
  is shared with any group. What Tex writes for the chat goes in its folder.
  A note shared with the group to view is read and never changed.
- **Never more than an editor's hand, and nothing published.** The chat's
  grant is an editor's in that workspace whoever turned it on, and a turn
  there writes and moves notes only inside what the chat reads: no
  visibility, links, sites, sharing or another context. Keystrokes from the
  chat reach live only readers who see everything; the rest get the saved
  note, since the chat's rules can't judge anyone else's reach.
- **Never anyone's mail, calendar reads, saved logins, `tex/` notes or
  personal tools**, as in any group. A saved login or card counts only when
  it is shared with the chat's group, and each payment is still its owner's
  yes.
- **Guests can ask Tex for things.** It searches, browses with the chat's own
  browser, writes notes in the chat's folder and offers emails and calendar
  changes. An email or calendar change goes only from the account of a
  workspace member in the chat, on that person's own yes (`as`): a guest's
  yes never releases anything, and a guest's tag never holds anything for
  someone else.
- **New joiners see the group's notes, never the chat before they joined.**
  The chat's memory is filed by its exact set of people, as before, and an
  answer is held when someone joins mid-turn.
- **Usage counts against whoever turned guest mode on**, whoever tags Tex.
  Guests have no account to count against. The audit names the person whose
  grant acted, and says when a guest asked.
- **A chat where everyone shares a workspace works as before**, until
  somebody says "Tex, use @slug" for guest mode. Then it stays a guest chat
  (the narrower reading) until "use" names a workspace everyone shares.

## Why a group, and why it reads as a guest

The pieces already existed: a workspace's groups, a row shared with a group,
and reading a workspace as a guest, which the pinned workspace's readers
already do ([all-context-users](../privacy-and-sharing/all-context-users.md)).
A chat's grant carries the guest marker and the tokens of the rows granted to
its group in `grantedNames`, the one list every reader of a clearance already
passes along, so a reader that never heard of guest chats still judges it as
a guest. The gateway's tools judge by the rules a store holds rather than by
names, so the rules a chat's store holds are rendered for it: a row the
group holds reads `team`, and everything else `private` (`chatRules.ts`).
A store's rules are its reader's, which is what they always were.

Until a note is written there the chat's folder has no row, and a list can't
be put on a path with no row. So the chat's binding stands in for the row:
every reader sees the folder as shared with the group from the moment guest
mode is on, and the first turn after the row exists gives the row that grant
for real, once. From then on the row is the owner's like any other: taking
the group's grant off it hides the folder from the chat for good.

## Non-negotiable #5

"Every grantee is a person with an account or an email awaiting one." A chat
group's grantees are the people in the chat, who may have neither. The owner
decided that is allowed for a Tex group chat in guest mode, bounded the same
way a share link is: the owner or an editor mints it, it reaches only rows
shared with that one group, and "Tex, stop" or "Tex, use" ends it. Nothing
here is public or indexed.

**What a simplification would cost:** reading a guest chat at the binder's
tier hands their whole workspace to whoever is in the chat; dropping the
guest marker from the grant's names lets a reader that judges by names see
`team`; letting a guest's yes count lets anybody in the chat send from the
binder's Gmail; turning guest mode on for anyone who asks lets a member open
a workspace they can't share; syncing people without the `viaChat` mark
takes away rows the owner added. `apps/convex/__tests__/textGroupGuests.test.ts`
and `apps/mcp/test/agentGroupGuests.test.mjs` fail if any is reversed.
