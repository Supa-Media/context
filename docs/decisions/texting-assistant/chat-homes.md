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
  the chat's memory note (`chat-<id>.md`, named by the people in the chat as
  before, so somebody added is never replayed what came before them) is read
  and written there instead of in the bound workspace. A model's tool call
  never reaches the home.
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

## Still to build

Routines, dreams and a heartbeat for a chat need their jobs moved too: a
chat's routines are still written in its bound workspace's `tex/routines/`
with `chat:` in their front matter, its check-in is a timer on the chat's
row, and chats have no dreams yet. Empty folders for them are not made until
something runs from them. The workspace's playbook stays the workspace's.
Then: the chat reads every workspace everyone in it shares instead of one
bound workspace, and the chats that exist move in (old notes archived, never
deleted).
