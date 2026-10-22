# Communications — read live, never copied

### Mail, calendar, chat, contacts and iMessage are read from their source, not copied into notes

Decided by the owner on 2026-10-21. After an analysis of what the copies were
for, they wrote: "I feel like if we removed all of this the quality of
peoples searches and use of context will go up not go down because there is
less noise - they expect it just to have their notes but have access to the
other things. i'm leaning toward removing everything, and adding them back as
needed." They approved the boards (`remove-copies` b0–b2) with "go".

This reverses [the sync keeps the notes](./reading-mail.md#the-sync-keeps-the-notes-gmail-answers-searches)
(owner, 2026-10-18) and the parts of [communications](../communications.md)
that describe a channel-day note as something Context writes. The layout and
renderers stay documented because old copies still exist in people's
workspaces, and because a kind may be added back on purpose.

**What reads the source now:**

- `calendar:` asks every connected Google calendar at that moment, through
  `/gateway/calendar/days` (`functions/lib/gatewayRoutes/personCalendar.ts`).
  It has the same clearance as a live mail read: the owner of a personal
  workspace, on a grant with `context:private`.
- `search_email` and `read_email` were already live (2026-10-20).
- A check-in asks Gmail for inbox mail that arrived since it last looked
  (`apps/mcp/src/agent/newMail.js`). That mail is a stranger's words, so a
  check-in that was shown any saves its exchange tainted, and the memory nudge
  never distils it into `tex/about-me.md`.
- A first dream writes the about-me note from the person's own notes only.

**What stopped:**

- No job starts a Google sync pass. The five-minute cron is gone, and a push
  notification is recorded without scheduling anything
  (`functions/lib/googlePush/pending.ts`). Without a pass there are no Gmail,
  Calendar or Chat day notes, no attachments, no first-connect import of fifty
  messages, and no contact page made for every sender. The pass itself
  (`googleSync.sweepDueGoogleSyncs` and the `googleForwardSync` operation) is
  kept unscheduled so a kind can be added back.
  `apps/convex/__tests__/copiesStopped.test.ts` fails if anything schedules it
  again. That includes a reported pass queueing the next one: that drain
  (`lib/googleSync/drain.ts`) kept the passes already running at the stop
  starting each other, still writing mail under the Inbox a day later
  (2026-10-22), so it is gone too.
- The Mac app's iMessage import is off, and a settings file that turned it on
  reads as off (`apps/desktop/src/core/settings.ts`). The tray item is gone.
- Mail health has one state that needs the person, `needs_reconnect`. With no
  pass there is no `stale` and no `store_full`, and the rows those states read
  are left as the last pass wrote them. A grant Google refuses is still found
  the moment anything asks Google.
- Settings says "Connected" where it said "Up to date · 3:57 PM", and the card
  says: "Your AI reads mail, calendar and chat from Google when you ask.
  Nothing is copied into your notes."

**What is lost on purpose:** meaning search over mail, and iMessage for cloud
AIs. The owner accepted both: "we shouldn't have to do meaning search for
email often". Either comes back if people miss it.

**Old copies are never deleted for the person.** They are hidden from the
tree, search and AI, kept in Download as folders, and the person may delete
them from Settings (`functions/oldCopies.ts`, `lib/oldCopies/`):

- First, and at once, the Inbox's channel folders go whole: `calendar`,
  `contacts`, `email`, `google-chat` and `imessage`, each one row move of the
  folder (a big one in pages, as a big folder goes to the Trash), everything
  in them included (`lib/oldCopies/folders.ts`). Only the passes wrote there,
  and the owner said so (2026-10-22: "isn't the first step just to hide it?
  Hiding it is an instant thing"; "there's no handwritten things in
  contacts or iMessage or email"). A note-by-note first version opened each
  note to judge it and left the owner's copies showing for hours. The
  folders are looked for under the folder doing the Inbox job and under a
  root `inbox` or `0-inbox` too, because a rename of the Inbox that stopped
  part way leaves what it could not carry under the old name. A copy written
  before its workspace was keyed still reads at its path (no `storageKey`),
  and a row move refuses it; so each such row is pinned first, its key set
  to the path its bytes are at, which the cleanup counts as read and never
  removes, and a refused move takes the pins back. The second version of the
  folder step (`FOLDERS_VERSION` in `oldCopies.ts`) runs again for a
  workspace the first version already marked done, since that one passed
  these copies over without saying so.
- After that, a copy anywhere else is what says it is one: a note whose front matter `origin` is one
  of the passes' (`gmail-sync`, `calendar-sync`, `google-chat-sync`,
  `desktop-imessage-sync`, `communications-sync`), a contact page the
  renderer made (`type: contact`, an `## Activity` section) with nothing
  under `## Notes`, and a file in a mailbox's `attachments/`. Anything else
  is the person's: a note of theirs outside those folders stays, and so does
  a contact page outside them they wrote on. Its facts decide where they were
  read at the note's version; otherwise its text is read.
- Hiding is a row move to `.context/old-copies/<its path>`, as a trash is
  (`trash: true` in `rowMove.ts`, allowed for either root by
  `underHiddenRoot`): nothing is copied or erased, the note keeps its id and
  bytes, and the name is plumbing, so every listing, search and AI read
  drops it. A look every ten minutes (`oldCopies.catchUp`) starts each keyed
  personal workspace not yet looked through; each run is one page, and hands
  on to the next at once, so a workspace is done in minutes and no run nears
  an action's time limit (a first version made up to 60 passes in one hourly
  run, too slow for a large workspace). It counts what it hid for the
  Settings page. A workspace not yet keyed waits until it is; one another
  move is still carrying waits too, and the Settings row says which.
- Download as folders, for the owner of the whole workspace, adds an
  `Old copies/` folder holding each hidden note under its old name
  (`listForExport`, `readForExport`), read at each row's key past the id
  layer, so a pinned copy reads too. Nobody else is told they exist.
- No timer erases them. The trash's emptying reads only `.context/trash`.
  Delete the copies is the owner's own press, allowed once every copy was
  hidden, so what goes is what the page counted; the rows go first, then the
  bytes and editing history through the trash's bucket half
  (`trashErasures`), and the audit names the owner.

`apps/convex/__tests__/oldCopies/oldCopiesBarrier.test.ts` fails if the
channel folders are not hidden whole through the real job, or a blocked one
does not say why; `oldCopies.test.ts` fails if a person's own note outside
them or a contact page they wrote on is hidden, if a member can list or read
the hidden copies, or if anything but the owner's Delete erases them.

The cost of a "simplification" that turns a pass back on: the noise the owner
removed comes back into every search and every AI's reading, and Tex has a
folder to look in the wrong place for again (PR #2048).
