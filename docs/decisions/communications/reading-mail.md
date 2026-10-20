# Communications — reading mail

### The sync keeps the notes; Gmail answers searches

Decided by the owner on 2026-10-18: "for each connected mailbox we should be
1. using a webhook to update our own notes on the users mail starting from
when they connect and 2. using the connection to read emails if 1 fails or we
need to read an email from before the sync 3. Tex should first look at if we
have the emails synced and if not using the regular connector."

The sync (pushed by Google, [google-push](./google-push.md)) keeps each
mailbox's channel-day notes current from the moment it was connected, and a
first connect reads only the last fifty messages
([gmail-and-sync-loop](./gmail-and-sync-loop.md#a-first-connect-reads-the-last-fifty-messages-and-that-is-not-a-backfill)).
So the notes never hold mail from before the connection, and briefly do not
hold mail newer than the last pass. Before this, an AI asked about older mail
found nothing and said the person had no history.

**A search asks Gmail, over all of the mail (2026-10-20).** The first
version searched the synced notes first and Gmail only outside the synced
window. It could not work: note search indexes a note's opening 2,048
characters, and a channel-day note holds a whole day of mail, often 100 KB, so
a message past the first few was invisible. Asked to reply in Luciana's Lucky
Strike thread (Oct 15, 16 and 19, all inside the synced weeks), Tex found
unrelated hits in the notes and nothing in Gmail, and told Dev the thread did
not exist. So `search_email` (`apps/mcp/src/tools/emailRead.js`) is now one
call to the control plane (`/gateway/email/search`,
`functions/lib/gatewayRoutes/personMail.ts`) with `outsideSync: false`, which
uses Gmail's own search over the whole mailbox, sent mail included. The sync
still writes the notes, which remain the person's record and what every other
reader of the folder sees. Undoing this brings the miss back:
`emailRead.test.mjs`, "a search asks Gmail about all of the mail, once…".

Every connected Gmail is searched, each for an equal share of the results,
taken in turn. The first version filled the limit from the first mailbox and
stopped, so a person with three Gmails had two never searched (2026-10-20;
`personMail.test.ts`, "every connected Gmail is searched…").

**Gmail first, the notes as the fallback, and a broken sign-in named**
(asked by the owner, 2026-10-20: "searching from the Gmail API directly
first before we fall back to the notes... let people know you need to
reconnect Gmail"). The notes answer only for a mailbox Gmail could not
search: one whose Google sign-in stopped working (`health:
"reconnect_required"`), one whose call failed just now (`unanswered`), or
every one once the hour's reads are spent (`rate_limited`). Each such answer
says the notes may miss mail. A mailbox needing reconnecting is named in the
answer with the words to tell the person, because that mailbox has also
stopped syncing, and its mail would otherwise just go missing; with every
mailbox in that state the control plane refuses as `reconnect_required`
rather than `no_mailbox`, which would have told them to connect one they
already have. `emailRead.test.mjs` fails if a reconnect is not named or the
notes do not answer for it; `personMail.test.ts` fails if a broken mailbox
is folded back into "no mailbox".

A search downloads headers and a snippet only (`format=metadata`). Results
come back as `email:<address>/<id>` ids, and `fetch` of one (`read_email`)
reads that message's body, capped at 20,000 characters.

**Attachments are read, not only listed** (asked by the owner, 2026-10-19:
"Tex needs to be able to read attachments, otherwise it's not useful"). Two
routes, one converter. A synced attachment the sync stored beside its day
note is a file in the bucket, and `fetch` of its path (`read_file`,
`apps/mcp/src/tools/readFile.js`) returns its words. Any other email's
attachment is read from Gmail's own copy: `fetch` of `email:<address>/<id>`
with `args: { attachment: n }` asks the control plane for that attachment's
bytes (up to 10 MB, over the same clearance and rate limit as a read). Both
turn the bytes into Markdown with Workers AI's `toMarkdown` at request time
and keep nothing: the file is the record and its words are a derivative.
Both are `UNTRUSTED_READS`, since a file's words are its author's.

**Who may read.** Only the owner of the personal workspace the mailbox is
connected to, through a grant holding `context:private`
(`functions/personMail.ts`, one mutation with the rate limit). An editor or
member of somebody's personal workspace never reaches its mail; a shared
workspace has no mail. Both tools are private-tier only, and both are
`UNTRUSTED_READS`, so a turn that read live mail is tainted for egress like
any other outside read ([agent-egress](../privacy-and-sharing/agent-egress.md)).

**What is kept.** Nothing. A live read is not written to the bucket, the
control plane or a log line (logs carry an outcome and counts). This is what
makes it compatible with [non-negotiable 1](../../../CLAUDE.md): the control
plane relays a message body for one request and holds none.

**Bounded.** 120 live reads per person per hour, searches and opened messages
together. Gmail's own quota is per mailbox and far above that; the ceiling is
there so a looping model cannot spend the sync's share of it.

What a simplification costs: searching Gmail whole doubles every synced
message's cost and returns the same mail twice; searching Gmail first spends
quota on what the notes already answer. Tests:
`apps/convex/__tests__/personMail.test.ts` (clearance, outside-sync query,
nothing stored, attachment bytes), `apps/mcp/test/emailRead.test.mjs` (order,
tiers, taint, attachment words), `apps/mcp/test/readFile.test.mjs` (a stored
file's words, refused alike when hidden or missing).
