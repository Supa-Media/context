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
(the record contract).
