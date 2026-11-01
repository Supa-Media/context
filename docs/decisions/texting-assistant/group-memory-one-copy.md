# A group chat's history has one copy: the memory page in its home (2026-11-01)

Decided by the owner, 2026-11-01: "there should be one copy in the durable
object", and "we aren't even supposed to keep group chat data in the workspace
folder anymore, everything should be in a durable object accessible from the
context-lc workspace", then "be sure to move ALL group chats, do a complete
migration". Asked whether the chat's people should still see the memory as a
page, the owner chose "Yes, the page is the one copy".

## What went wrong

Each chat kept its history twice: a record (`agent/chatMemoryRecord.js`, in
the chat's Durable Object), and a visible memory note `tex/groups/chat-<id>.md`
in its home or its bound workspace. Every turn preferred the note whenever its
version was not the one Tex last wrote, treating it as "edited". While a note
was being carried to a new name, it read the old note's words instead. When
the note stopped taking writes, its version never moved again. So every later
turn rebuilt the history from that stale note and wrote the record back with
it. The chat forgot every reply since then. Each self-review also saw a history
it had never scored and filed the whole chat again: the Tex Devs chat was
reviewed five times on 2026-11-01. The write's refusal was thrown away
unlogged (`writeGroupNote` answered null, `chatNoteMove.js` answered `kept`).

## What it is now

- **In a chat with a home, the memory page is the history.** The page lives in
  the chat's home in @context-lc, a tree row whose text is in the chat's
  Durable Object, so the chat's people can read and change it and Download as
  folders carries it (non-negotiable #1). Tex reads it before it answers and
  adds the exchange after; a change somebody makes there is what Tex goes by
  (`agent/groupMemoryNote.js`, `agent/groupTurn.js`).
- **The page is written at the version just read.** A write that lost to
  another turn or to a person is read again and the exchange added to that, so
  neither is lost. A page Tex cannot read (its heading is gone) is never
  written over. Every refused write is logged
  (`group_memory_page_not_written`, with the refusal's leading words), so a
  page can never stop taking writes unseen again.
- **The page is read straight from the chat's object** once its key is known
  (`agent/groupDirectNotes.js`), so it costs one object read, not a note read
  through the tools.
- **A chat with no home keeps its history in its record** until it has one.
  The turns then move onto the page: the page is written first, and only then
  does the record drop its turns and take the `onPage` mark. At no time do the
  record and the page both hold turns Tex reads (`agent/groupMemoryCarry.js`).
- **Old notes are carried in once.** On a chat's first turn after the change,
  every place a memory note may be is read: its home, the workspace the grant
  defaults to, and each workspace in its reach, each under the chat's own name
  and the people's. The longest note is the base, followed by every turn it
  lacks. The record is marked `carried`, with the places carried from. A place
  that could not be read waits for a later turn, at most three. A read with no
  dispatcher (a review's) never writes anything.
- **No memory note is written in a workspace folder.** Every chat is given a
  home and the carried notes in workspace folders are trashed (restorable for
  30 days) by the `Tex group chats migration` workflow
  (`apps/convex/functions/texGroupMigration.ts`).

## Cost of reversing it

Reading a second copy as the history again brings back the forgetting: any
write that fails silently freezes one copy, and the next turn rebuilds the chat
from it. Tests: `apps/mcp/test/groupMemoryCarry.test.mjs` ("in a home the page
is the one copy", "a write another turn won is read again", "a page Tex cannot
read is never written over", "a page that will not take the move leaves the
record holding the turns", "a stale note never replaces turns the record
holds"), and `apps/mcp/test/groupDirectNotes.test.mjs`.
