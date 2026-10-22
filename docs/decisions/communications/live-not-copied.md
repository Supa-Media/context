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
  again.
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
them from Settings. That is a separate change, recorded with it.

The cost of a "simplification" that turns a pass back on: the noise the owner
removed comes back into every search and every AI's reading, and Tex has a
folder to look in the wrong place for again (PR #2048).
