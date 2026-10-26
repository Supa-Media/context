### The Mac backs up Messages into the person's bucket, as records, never as notes (owner, 2026-10-26)

_Part of [Communications](../communications.md)._

The owner asked for it on 2026-10-26: the desktop app should copy the Messages
history that is already on the Mac into the person's own storage, index it
with our own index, be on by default, and let Tex answer "my sister texted me
about this". It reverses one line of
[live-not-copied](./live-not-copied.md): "iMessage for cloud AIs" was lost on
purpose there, and comes back here.

**Why this is not a contradiction of live-not-copied.** Mail, calendar and
chat have a live source an AI can ask at the moment it needs to. iMessage has
none: Apple offers no API, and the only copy a cloud AI can reach is one the
Mac sends. So the rule stays "read from the source when there is one", and
this is the case where there is not. What live-not-copied argued against still
holds: the backup is **not notes**. It never appears in the tree, in search
results for notes, on the live map or in the Inbox.

**What is kept, and where.** Records live under
`.context/messages/imessage/` in the personal workspace's bucket, the hidden
plumbing every export already includes. Four record kinds, one JSON object
per line: `message`, `reaction`, `chat` and `person`
(`packages/communications/src/backup.js` is the contract). A record is keyed
by its kind and id and a later one wins, so sending the same record twice is
harmless and an edit is just a newer record.

**The gateway keeps batches append-only.** `POST /messages/imessage/batch`
(`apps/mcp/src/communications/messagesBackup.js`) writes one object per group
a batch touches: `log/<yyyy>/<mm>/<batch>.jsonl` for messages and reactions by
the month they were sent, `log/chats/` and `log/people/`. `<batch>` starts with
the arrival time, and a reader folds by record key with the later one winning.
Nothing is read back to write, so two batches cannot race into a lost update.
Only the owner of a personal workspace on a private-tier write grant may post,
decided from the session before a store opens; an `@name` selector is refused,
so a batch can only land in the caller's own bucket. `messages` is a reserved
first segment and name for that reason (`apps/mcp/test/messagesBackup.test.mjs`).

**The index lives in the context's own search database, and AIs reach it
through `search` and `fetch`.** `communications/textsIndex.js` folds the log
into `texts_records` and a full-text table in the per-context database every
workspace already has (fast search is on for everyone), so nothing new is
provisioned and deleting the tables loses nothing. A row keeps the batch it
came from and is replaced only by a later one, so the write path, a catch-up
and a rebuild land on the same answer in any order. A batch the write path
could not index leaves a marker under `pending/` for the next read. AIs ask
with `search` `{ texts: true, with, since }` and `fetch texts:` /
`texts:<id>`: new arguments on the tools every client holds, with the three
tools behind them unlisted. The route gives them to the personal workspace's
owner on a private-tier connection only, and never to Tex answering a group
chat; every texts read marks the turn untrusted (`apps/mcp/test/texts.test.mjs`).

**On by default, and nothing is read until the person grants Full Disk
Access by hand.** A fresh install has `messagesBackup: true`; a settings file
that says false stays false. macOS never lets an app ask for Full Disk Access,
so the first time the Mac app opens, a card ("Your texts, ready for Tex") says
the backup is on, names the masked account and the Mac, shows the two steps,
opens the right pane, and offers Turn off. It stays until the permission lands
or the backup is off; closing it hides it for that visit only. Settings ›
Messages holds the switch, the progress line and who reads the texts. The
console learns all of it through the bridge's `imessage` member, which reports
the backup since the import into notes was retired: a `backup` view of counts,
two times, the masked account and the Mac's name, rebuilt field by field in
the preload (`apps/desktop/test/consoleBridge/preloadContract.test.mjs`). A
Mac app from before the backup sends no view, and the page asks for an update
rather than drawing a switch that would do nothing
(`apps/mobile/__tests__/meetingsDesktop/messagesBackupSettings.test.ts`).

**The owner's picks (2026-10-26, from the boards):**

- An open form: one JSON line per message, readable without Context.
- Pictures and documents up to 25 MB are copied; videos are off.
- All history, newest first, so a text from a minute ago never waits behind
  ten years of backfill.
- A message deleted on the Mac stays in the backup; only an *unsent* message
  is removed (its record keeps no words and no files).
- Only the owner reads it: a private grant on the personal workspace. Never
  members, never a shared workspace, never Tex answering in a group chat.

**`chat.db` is the queue.** The boards described an outbox on disk; the build
has none. The Mac keeps one small cursor file (`messages-backup-cursor.json`
in the app's data folder): the newest ROWID sent, the oldest ROWID of history
sent, and the last edit/unsend time seen, plus digests of the chats and names
last sent. A pass reads past the cursor, uploads, and moves the cursor only
after the gateway answered `ok`. A crash, a sleep or a refusal leaves the
cursor where it was, and the next pass reads the same rows again. Nothing
copied from `chat.db` sits on the Mac waiting.

**Names come from the Mac's Contacts, for people in chats only.** The address
book is read in place with the same read-only `sqlite3` as `chat.db`, at
paths `isAllowedAddressBookPath` accepts, and only the handles that appear in
a conversation get a `person` record. A handle two contacts name differently
is sent unnamed.

**No Mac path leaves the Mac.** A file record carries the transfer name,
type and size, never `~/Library/Messages/Attachments/...`.

**Pictures and documents are copied by name, not by path.** A file record
also carries an `id`, the first 32 hex characters of a SHA-256 of Apple's id
for the file, and its bytes land at
`.context/messages/imessage/files/<folder>/<id>`, where `folder` is the same
digest of the message's id (`POST /messages/imessage/file/<folder>/<id>`,
refused on exactly the batch route's terms). The same file always lands on
the same key, so a retry overwrites itself. Every file is stored as
`application/octet-stream`; its real type stays text in the record. The Mac
reads only inside `~/Library/Messages/Attachments`, after following links,
copies no videos and nothing over 25 MB (the gateway holds the size limit
too), and walks files with a cursor of its own over `attachment` rows, new
ones first, a byte budget a pass, after the texts. A new file not yet on the
Mac is waited for for half an hour; an old one (Messages in iCloud keeps many
only in the cloud) is skipped, and the Mac never asks for it to download.

**An unsend takes back what was already copied.** A batch carrying an unsent
message deletes every file under that message's folder and rewrites the
month's log objects that arrived from an hour before it was sent onwards,
dropping its earlier lines and keeping every other line. Both finish before
the batch is answered `ok`, so a failure is a refusal the Mac sends again.

**What a simplification would cost.** Writing the backup as notes puts years
of texts into note search and the tree, which is what live-not-copied removed.
Moving the cursor before the gateway answers loses messages silently on the
first failed upload. Sending the whole address book sends people who never
texted this Mac. Letting members or group-chat Tex read it hands one
person's texts to everyone in a room.

**The tests that fail if it is reversed.**
`apps/desktop/test/messagesBackup.test.mjs` (cursor only after success,
unsent keeps nothing, no stored path, new texts before history, names only for
chat members) and `messagesBackupSqlite.test.mjs` (real SQLite, old and new
schemas, Full Disk Access first); `packages/communications/test/backup.test.mjs`
(the record contract); `apps/mcp/test/messagesBackupFiles.test.mjs` (who may
post a file, the size limit, an unsend taking back words and files) and the
`files:` checks in `messagesBackup.test.mjs` (no videos, no path outside
Attachments, waiting only for new files, the byte budget).
