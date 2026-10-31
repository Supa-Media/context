# Group Tex keeps each chat's home in @context-lc, sealed from the people who run it (2026-10-31)

A group chat's memory was one note, `tex/groups/chat-<id>.md`, in whichever
shared workspace the chat was bound to ([groups](./groups.md)), and a guest
chat's was a folder under `tex/chats/` ([group-guests](./group-guests.md)).
A person's own Tex has a whole set of folders (about-me, transcripts,
routines, skills, dreams and the rest); a chat had one growing note. The Tex
Devs meeting of 2026-10-30 asked for chats to "have their own character, their
own history, their own dreaming", in one place for every group chat, reading
the workspaces everyone in the chat already shares.

The owner decided on 2026-10-31: "just put it in context-lc but put special
rules for the tex-groups folder in there", and, asked whether the owners of
`@context-lc` should be able to open a customer's chat, chose **sealed: only
the chat's people**.

## The rule

- **Every chat's home is `tex/groups/<words>/` in the pinned workspace**
  (`CHAT_HOMES_FOLDER` in `packages/shared/src/pinnedContext.ts`), named with
  three words, holding the same folders a person's Tex keeps.
- **The folder is sealed.** What is under it is seen only through a row token
  a person was named on. No role opens it: not a member's `team`, not an
  editor's, and not an owner's `private` scope, which opens every other path
  in every workspace. `canSee` asks `sealedCovers` before it asks scope, in
  both engines (`apps/convex/functions/lib/privacy.ts`,
  `apps/mcp/src/privacy/engine.js`), so every read, write, listing, search,
  move and trash that already asks `canSee` is closed to a role by that one
  line.
- **The control plane draws the seal, by the workspace's name**
  (`apps/convex/functions/lib/nodes/sealedChats.ts` `withSealedChats`). In
  `@context-lc`, `tex/groups` is rendered as the `SEALED` rule for every
  audience, replacing any setting somebody gave that folder. A workspace that
  merely holds the name is sealed too, which only narrows.
- **Only a person opens a home.** Beneath the folder a grant reaches a person,
  by account or by email, and nothing else: `members`, `accounts` (All Context
  users) and a group are each a role in the pinned workspace by another name,
  and are dropped. A row beneath the seal whose own base is `team` or
  `private` opens to nobody; a note there answers only to tokens.
- **Only Tex changes it.** Setting access at or beneath the folder is refused
  to everyone but the chat homes' own client (`CHAT_HOMES_CLIENT_ID`,
  `setAccessRow`). Moving, renaming or trashing `tex`, `tex/groups` or a
  whole home is refused to everyone (`chatHomesMoveRefused` in
  `applyRowMove`), so the folder's path never changes and the seal needs no
  flag on a row. A note inside one home may move inside it, and be trashed and
  restored, by whoever may see it; the trash keeps its rule.

## What else had an owner's shortcut, and now asks

Places that answered "an owner sees everything" without asking `canSee`:

- the Trash page and "this note is in the trash" (`trash.ts`,
  `trashedNotes.ts`) now judge an owner by the rules too;
- the tree's change feed (`nodes/log.ts` `toldOf`) and the audiences a change
  is announced to (`treeAudiences.ts`): a sealed path has no audience a role is
  in, so its people converge on the periodic walk, late and never disclosed;
- the folder listing (`fileOps/listing.ts` `folderVisibleAtScope`);
- the audit trail (`audit.ts`): in the pinned workspace a row about a chat home
  is its actor's alone, paths and actor both, since the actor names a customer;
- `list_changes` (`activity/changes.js`) drops a record about a sealed path;
- `activity.md` never gets a line about `tex/groups/`, in any workspace
  (`packages/shared/src/activity.cjs` `isQuietPath`): it is a note an owner
  reads whole.

Known and accepted: note counts that feed the chaos score count a chat's notes
for an owner (a number, no names); the bucket itself is Context's, as every
managed bucket is.

## What a simplification would cost

- Treating the seal as an ordinary private folder: every owner of
  `@context-lc`, which is Context's own team, reads every customer's group
  chat.
- Letting `members`, `accounts` or a group grant through beneath the seal:
  one share-dialog click opens a chat to the whole team or to every account.
- Allowing `tex` or `tex/groups` to move: the rule is a path, and a renamed
  folder leaves the homes outside it.
- Dropping any one shortcut above: a chat's name, its people or its existence
  reaches an owner through that one door.

Tests: `apps/convex/__tests__/sealedChats.test.ts` (an owner cannot read,
list, search, write, set access on, move or trash a chat, nor see it in the
trash or the audit trail; the chat's people can, through Shared with me; a
role's grant beneath the seal opens nothing), and
`apps/mcp/test/privacy/sealedChats.test.mjs` (the gateway's `canSee`, folded
spellings, `list_changes`). Both carry a sabotage record.

## How a chat gets its home, and writes there (2026-10-31)

- **Made on the chat's first turn with a session** (`apps/convex/functions/lib/textGroupHome.ts`
  `ensureChatHome`, called from `mintGroupGrant` in every mode: bound, guest
  and invited): three words under the folder, the folders stood as rows, and
  the home's row naming everyone in the chat with an account, each to edit,
  under the homes' own client. Each later turn names exactly who is in the
  chat now: somebody who leaves is taken off, somebody added is named. Only
  account ids are kept (`textGroups.homeWords`, `homeUsers`), never a number.
- **The chat's turn holds the home's token to edit, on the pin's setup row**
  (`liveGrants.ts` `groupSetupRow`), beside the names every pin reader holds
  and `READS_AS_CHAT`, at the editor role, with `chatHome` naming the folder.
  Read as a chat reads (`lib/nodes/chatFolders.ts` `chatRules`), the rules it
  gets open the home as `team`, list everything else it holds (the guides
  every account reads, Tex's setup) as read only, and close the rest. The row
  stays setup-only: no tool, URL or listing addresses it.
- **Only the turn's own memory is written there.** The gateway opens the home
  through a door of its own (`apps/mcp/src/http/pinnedDoors.js`,
  `session.js` `sessionForChatHome`), which exists only for the group client's
  setup row, a folder under `tex/groups/`, the chat marker and a grant that
  may write. `agent/chatHome.js` hands the group turn a dispatcher on it, and
  the chat's memory note (`chat-<id>.md`, named by the chat's key alone, see
  "One memory per chat" below) is read and written there instead of in the
  bound workspace. A model's tool call never reaches the home.
- A chat bound to `@context-lc` itself gets no door (its setup is read where
  it is bound), and keeps its memory in the plumbing copy alone.

Tests: `apps/convex/__tests__/textGroupHome.test.ts`,
`apps/mcp/test/chatHome.test.mjs`, each with a sabotage record.

## The chat's own notes, kept by the model (2026-10-31)

Dev2 asked that every chat have the folders a person's Tex has. The first of
them that work today:

- **about-us.md** in the home: who the people are and what the chat is for,
  kept by the model the way a person's Tex keeps `tex/about-me.md`, shown to
  each turn bounded (`agent/chatHome.js` `readAboutUs`, `homePrompt`).
- **The voice note** (`chatVoice.js`) moves into the home beside the memory
  note.
- **The model reaches the home by naming `@context-lc`** on a tool call
  (`addressHome`). A chat's grant never addressed the pin, so the name meant
  nothing in a group turn before; now it opens the home's session, whose rules
  let it change the home and only read what every account reads. Every other
  name is routed as it was.

## One memory per chat, shared with whoever is added (2026-10-31)

The owner decided on 2026-10-31 that a chat keeps ONE memory, and somebody
added later shares it. This reverses the 2026-10-23 rule that filed the
memory by the exact set of people in the chat, so a newcomer started a new
note and was never replayed what came before.

- **Named by the chat's key alone.** The memory note is `chat-<id>.md` and
  the voice note `voice-<id>.md`, where `<id>` is the first twelve hex digits
  of the SHA-256 of the chat's key (`groupMemoryNote.js` `groupNotePath`,
  `chatVoice.js` `groupVoicePath`). The record kept in the bound workspace is
  named the same way (`groupMemoryPath`); in a chat's Durable Object the
  record was already one per chat. The chat's members are no longer in any
  memory name. They are still used where they were before: the browser the
  chat signs in with (`browserJar.js`, `browserProfile.js`), and the people
  Tex is told are in the chat (`group.people`).
- **A chat with a home** keeps both notes in the home. Once the home holds
  them, the bound workspace is never written again. On the first turn after
  the change, a note the chat kept under the people's name is carried over
  (`agent/chatNoteMove.js`): its words are copied under the chat's name, read
  back and compared, and only a read-back that matches goes on. Only then is
  the old note retracted, with `archive_note` at the etag it was copied from.
  An old note changed meanwhile is refused, and copied again within the same
  turn. A move that cannot finish leaves the old note where it is, and the
  next turn tries again.
- **A chat without a home** keeps its notes in its bound workspace (or its
  guest folder), under the same key-named names. Its old people-named note is
  carried over the same way, and retracted in that workspace, except in a
  guest chat: its folder is the chat's guests' alone and an archive is
  team-visible, so that copy is left where it is.
- **A people-named note inside a home is never retracted.** The gateway's only
  retraction, `archive_note`, moves a note to the workspace's archive root,
  outside the home's seal. So a home's old copy, if one was made under the
  people's name, stays sealed and unread. The dispatcher has no delete, so
  nothing takes it out.
- **Newcomers read what the chat kept.** The note and the record are read by
  the chat's name, so whoever is added next gets the same memory and voice
  note as everyone else in the chat.

What a simplification would cost: naming the memory by the people again
starts a new memory for every newcomer, and what the chat kept is hidden from
them (fails "a newcomer reads the chat's earlier memory from its home").
Retracting the old note before its copy is read back loses the memory if the
copy does not arrive (fails "a read-back that differs keeps the old note").
Retracting a home's note with `archive_note` would move it out of the seal.

Tests: `apps/mcp/test/chatHome.test.mjs` (the carry-over copies, then
retracts; a read-back that differs keeps the old note; an old note changed
meanwhile is copied again; no carry-over with no home is still key-named; a
newcomer reads the home's memory; once the home holds it the bound workspace
gets no write), `apps/mcp/test/agentGroupTurn.test.mjs` ("the chat remembers as
one"), `apps/mcp/test/agentChatVoice.test.mjs` (one voice note per chat), and
`apps/mcp/test/chatMemoryRecord.test.mjs`.

## Still to build

Routines, dreams and a heartbeat for a chat need their jobs moved too: a
chat's routines are still written in its bound workspace's `tex/routines/`
with `chat:` in their front matter, its check-in is a timer on the chat's
row, and chats have no dreams yet. Empty folders for them are not made until
something runs from them. The workspace's playbook stays the workspace's.
Then: the chat reads every workspace everyone in it shares instead of one
bound workspace. The chats that exist move in as above, and the one copy a
home cannot retract is left sealed until a delete exists for homes.

## Chats with people who aren't all here (2026-10-31)

A chat with someone in it who has no account, or whose account isn't a member
of the workspace the chat was bound to, is answered from its home rather than
from a group in that workspace. This retires guest mode
([group-guests](./group-guests.md)).

- **The grant is the sponsor's.** The chat's sponsor (`textGroups.sponsorId`:
  the person who turned Tex on in it, else whoever bound it, else the sender)
  holds one grant on the pinned workspace for that chat, marked `homeOnly`. It
  is minted once per chat and sponsor, and it reads the chat's home alone,
  through the chat's name (`READS_AS_CHAT`) and the tokens of the notes shared
  with the chat. Nothing else in any workspace.
- **It lives only while the sponsor does.** `homeOnlyStillShares` ends the
  grant when the sponsor is no longer the one who can text Tex, when Tex is
  muted for the chat, or when the sponsor's account is paused. A grant held by
  anyone but the sponsor reads nothing.
- **Usage goes to whoever sent.** A tagger with no account is metered under
  their number (`phone:<E.164>`), and one with an account under theirs. The
  sponsor's grant pays.
- **No group, no folder.** Nobody is added to a group or named on a folder for
  being in the chat. Legacy guest groups and folders are not read. A one-off
  is to move them into homes, and it is not written yet: the move engine refuses
  to carry notes into a home (`chatHomesMoveRefused`).

## The home is where the grant lives; the reach is beside it (the owner, 2026-10-31)

Every group chat's grant is now minted on the pinned workspace for its sponsor, as a home-only grant was for a chat with people who aren't all here (above). What differs is only what sits beside the home row. When every person in the chat has an account, the grant also lists the shared workspaces they all belong to, each a row at `team` tier held at the lowest role among them (`lib/textGroupReach.ts`; [groups](./groups.md#a-chat-reaches-the-workspaces-its-people-share-the-owner-2026-10-31)). When anyone has no account, there are none, and the chat has its home alone, as before.

- **The home stays the default and the memory.** A call with no `context` reaches the home; the chat's memory, notes and voice live there whatever the chat reaches, so a person joining or leaving changes what Tex can read, not what it remembers.
- **The pin is only ever the home.** A home-only grant's row is no clearance on the pin (no website publishing, no queued job, no owner check) and may hold a note mailbox only beneath its own folder. The pinned workspace never appears in a chat's reach, even when everyone in the chat is a member of it.
- **The sponsor must share too.** Writes in a workspace are audited as the grant's account, so a workspace stays in reach only while the sponsor is a member of it as well as everyone in the chat.
- **The home may be read by people the reach does not include.** A chat's home names every account in it to edit, whatever workspaces they share; reach narrows what Tex may use beyond the home, never who may open the home.

