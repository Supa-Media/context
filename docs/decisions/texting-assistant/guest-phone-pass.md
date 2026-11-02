# A guest in a group chat opens a shared note with a texted code, and the code makes an account (2026-10-27, 2026-10-31)

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
- **A number an account holds signs in for real** (the owner, 2026-10-27,
  after testing from a members chat: "I never get the code", "I should
  already be signed in"). A members chat is not a guest chat, so its numbers
  are never kept and the guest code went nowhere while the page said "sent".
  Now a number an account holds is texted the ordinary sign-in code from any
  chat, and the page signs in with `phone-verify`; the route then opens the
  note in the console with everything the account may see. A number paused
  by "This wasn't me" gets no sign-in code, only what a guest gets. Saying a
  number holds an account tells nobody more than the sign-in page already
  does.
- **Signed in but not a member opens it in @shared** (the owner, 2026-10-27,
  after a chat guest with an account tapped a note link from a WhatsApp guest
  chat and landed on his own workspace). The console address opens only a
  member's notes and sent anyone else to their own home with no word about the
  note. A signed-in caller now asks `noteLinks.target` first: a member goes to
  the console, someone named on the note or a folder above it (as a guest
  chat names its account holders on the chat's folder) reads it in @shared,
  someone invited there goes to the console's invitation, and anyone else is
  told the note isn't open to them, one answer whether it exists or not.
- **An account, not a pass (decided by the owner, 2026-10-31).** A code that
  checks out for a number in a live guest chat, which no account holds or
  carries, makes a light account. It is made by `newPhoneAccount`, the same
  account phone sign-in makes for a number staff let in, with the phone
  confirmed by the code. The account is then named on each chat's folder to
  edit, as an outsider is (`nameOutsider`, `lib/textGroupGuestSync.ts`). It is
  not made a member of the chat's group: a group row reaches nothing for
  someone who isn't a member (`resolveGroupMembers`), and making them a member
  is an invitation, which is the owner's. The page then signs in through
  `phone-verify` with a ten-digit code the check handed it
  (`mintPhoneSignInCode`), one use and five minutes, exactly as a number an
  account holds signs in. The account is an ordinary user: what it reads and
  edits, and what the audit names, are the normal paths'. It gets no
  workspace, no membership and no waitlist place. Membership in the chat and
  access to its notes are decided by a later PR; until then the folder naming
  keeps the reach a guest pass had. The folder's grant comes from
  `ensureChatFolderGrant` on the chat's first turn, so until that a new
  account is named on the folder with the next tag.
- **Passes made before accounts keep working.** A pass issued on 2026-10-27
  is kept in its storage and on the server only as a hash (`guestPasses`),
  lasts a year from its last use, and "Sign out" forgets it. No new one is
  made.
- **Reach of a legacy pass is worked out again on every read.** The pass names a number. Each
  read finds the guest chats that number is in now, in the workspace the
  link names, and reads with the names of the rows granted to those chats'
  groups and the rows rendered for a guest (`guestReach`): exactly what Tex
  reads for the chat. Leaving the chat, guest mode off, or the owner taking
  the note back from the group ends it at the next read.
- **Legacy passes are read only.** Edits still go through Tex in the chat.
  The read goes through the share path with `openToAnyone`, so a sealed note
  and the note's comments never reach the page. Every refusal is one answer.
  A new account reads through its own sign-in and the normal paths.
- **Artifact pages later use the account.** Anything a Tex page shows a guest
  is judged by the reach of the number's account, once the later PR that
  decides membership lands; until then, `guestReach` for the number.

## Non-negotiables

#5 already allows a guest chat's grantees to be whoever is in the chat. The
account a code makes is named on the chat's folder to edit and nothing more:
no membership, no `team` tier, no other workspace, no listing. #1 holds: no
number is kept, and the account is a user like any other, whose sign-in and
export are the ordinary ones. #4 (account safety, `account-safety.md`) holds:
a code makes an account only for a number no row carries, so a phone alone
never takes an existing account; an existing holder signs in only through
`phone-verify`, with its own sign-in code; and the ten-digit code is returned
only to the browser that has just proved the six-digit one.

**What a simplification would cost:** texting any number that asks makes the
page an SMS pump and a "who is in this chat" oracle; making an account on any
approved code lets anyone with a phone into the workspace's chats; making the
account a member of the chat's group is an invitation nobody gave; creating an
account for a number an account already carries hands that account to whoever
holds the phone; rendering the rows for a member opens every `team` note to a
guest; storing a legacy pass's reach instead of re-deriving it keeps a guest
who left reading; a plain hash of the number can be reversed by trying every
number.
`apps/convex/__tests__/guestPass.test.ts` fails if any is reversed (sabotage
record in its header).
