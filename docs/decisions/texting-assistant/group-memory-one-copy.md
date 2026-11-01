# A group chat's history has one copy, in its Durable Object (2026-11-01)

Decided by the owner, 2026-11-01: "there should be one copy in the durable
object", and "we aren't even supposed to keep group chat data in the workspace
folder anymore, everything should be in a durable object accessible from the
context-lc workspace", then "be sure to move ALL group chats, do a complete
migration".

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

- **The record is the history.** `readGroupMemory` reads the record's turns
  and nothing else. No note is ever read as the history again
  (`agent/groupMemoryCarry.js`).
- **Old notes are carried in once.** On a chat's first turn after the change,
  every place a memory note may be is read: its home, the workspace the grant
  defaults to, and each workspace in its reach, each under the chat's own name
  and the people's. The longest note is the base, followed by every record turn
  it lacks. The record is marked `carried`, with the places carried from. A
  place that could not be read waits for a later turn, at most three. A read
  with no dispatcher (a review's) never carries.
- **An exchange reads the record again just before it writes**, so two turns
  that overlap both keep theirs.
- **The home holds a printout.** After each reply, the record's turns are
  written over the memory page in the chat's home in @context-lc. The page is
  a tree row whose text lives in the chat's Durable Object, so the chat's
  people can read it and Download as folders carries it (non-negotiable #1).
  Tex never reads it back, and the page says so. A printout that cannot be
  written is logged (`group_memory_printout_not_written`, with the refusal's
  leading words).
- **No memory note is written in a workspace folder.** A chat without a home
  gets no printout until it has one.

## Cost of reversing it

Reading a note as the history again brings back the forgetting. Any write that
fails silently freezes the note, and the next turn rebuilds the chat from it.
Tests: `apps/mcp/test/groupMemoryCarry.test.mjs` ("a stale note never replaces
turns the record holds", "two turns that overlap both keep their exchange", "an
unreadable place waits"), and `apps/mcp/test/agentGroupTurn.test.mjs` ("the
chat's memory is kept with the chat").
