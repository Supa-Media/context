# A guest in a group chat opens a shared note with a texted code (2026-10-27)

Guest mode ([group-guests](./group-guests.md)) lets people with no account
use Tex in a group chat, and Tex answers with the link to each note it reads
or writes ([note-links](./note-links.md)). For a guest that link went
nowhere: opening it is a sign-in, a phone with no account goes on the
waitlist, and the guest never saw the note Tex had just written for the
chat. The owner asked for "an easy screen for them to verify their number
and open the artifact, and keep them logged in; guests don't need accounts
or workspaces but they should be able to be authenticated by phone number",
saw the four-screen mock, and chose every default below on 2026-10-27
("Yes, all defaults").

## How it works

- **The same link.** A signed-out visitor to `/note/@slug/<path>` gets the
  guest page instead of the sign-in (`app/note/[...address].tsx`,
  `features/guest/GuestNoteScreen.tsx`): their number, a texted code, the
  note. "Have one? Sign in" stays one tap away and lands a member on the note
  in the console as before. A signed-in visitor is redirected as before.
- **The chat's numbers are kept, as keyed hashes.** Until this the chat's
  participants were never stored, so nothing could say later who was in a
  chat. Each tag in a guest chat now writes an HMAC of each participant's
  number (`chatGuestPhones`, `lib/guestPhones.ts`), under a key derived from
  the deployment's storage key, so the rows can't be walked back to numbers
  the way a plain or chat-salted hash of a ten-digit number can. People who
  left go at the next tag; guest mode off deletes them all.
- **A code goes only to a number in a live guest chat** of the workspace the
  link names, within the sign-in limits (five codes a number an hour). Every
  other number hears "sent" and is texted nothing, so the page can't text
  strangers or say whether a number is in a chat.
- **A pass, not an account.** The code gives the browser a random pass, kept
  in its storage and on the server only as a hash (`guestPasses`). It lasts a
  year from its last use, and "Sign out" forgets it. No user row, no
  workspace, no waitlist.
- **Reach is worked out again on every read.** The pass names a number. Each
  read finds the guest chats that number is in now, in the workspace the
  link names, and reads with the names of the rows granted to those chats'
  groups and the rows rendered for a guest (`guestReach`): exactly what Tex
  reads for the chat. Leaving the chat, guest mode off, or the owner taking
  the note back from the group ends it at the next read.
- **Read only.** Edits still go through Tex in the chat. The read goes
  through the share path with `openToAnyone`, so a sealed note and the
  note's comments never reach the page. Every refusal is one answer.
- **Artifact pages later use the same pass.** Anything a Tex page shows a
  guest is judged by `guestReach` for the number its pass names.

## Non-negotiables

#5 already allows a guest chat's grantees to be whoever is in the chat. This
gives each of those people a way to read what the chat reads without Tex in
between, and nothing more: no listing, no search, no other workspace, no
`team` tier. #1 holds: no number is kept, and the pass is not a credential to
anything but these reads.

**What a simplification would cost:** texting any number that asks makes the
page an SMS pump and a "who is in this chat" oracle; issuing a pass on any
approved code lets anyone with a phone read the chat's notes; rendering the
rows for a member opens every `team` note to a guest; storing a pass's reach
instead of re-deriving it keeps a guest who left reading; a plain hash of
the number can be reversed by trying every number.
`apps/convex/__tests__/guestPass.test.ts` fails if any is reversed (sabotage
record in its header).
