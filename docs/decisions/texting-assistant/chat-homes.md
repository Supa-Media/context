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

## Still to build

The seal ships first, on its own. Next: Tex makes a chat's home and names the
chat's people on it, writes the chat's memory there (transcripts by day,
about-us, voice, routines, skills), reads every workspace everyone in the chat
shares instead of one bound workspace, and the chats that exist move in.
