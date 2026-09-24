# Communications — Calendar

## Calendar

The owner's ask was plain: "a sync for a calendar," so the person's context
knows their meetings. It is built the same way mail is — not a calendar app
with its own account, but a day of somebody's schedule becoming plain
Markdown in the bucket they own, read by whatever AI client is already
connected. `packages/communications/src/calendar` is the prototype, the same
role `src/` plays for the channel-day contract above; this section is the
argument behind it.

### A calendar day defaults to `0-inbox/calendar/YYYY-MM-DD.md`, with no account level

Email nests under `0-inbox/email/<mailbox-slug>/` because a person has
several mailboxes they think of as separate things, and `privacy.md` needs a
folder per one to say "this mailbox, forever." A calendar does not have that
shape: a person has several *accounts* that can each contribute events, but
they think of the result as one thing — "my calendar," not "my work
calendar's folder and my personal calendar's folder, merged by me." Google
Calendar itself agrees: a single view already merges every calendar a person
has access to.

So every connected account's events are merged into one folder,
`0-inbox/calendar/`, one file per day, and which account an event came from is
recorded on the event itself (`account`) and rolled up into the day's
`accounts` frontmatter list — never made a folder boundary. The alternative,
`0-inbox/calendar/<account>/YYYY-MM-DD.md`, was rejected for the cost it would
add and buy nothing with: a person asking "what's on my calendar Tuesday"
would get two files to check instead of one, `set_folder_visibility` would
have nothing sensible to scope (a calendar's privacy is a property of a
*day* — who is a meeting with — not of which account created the invite), and
a day with events from two accounts would need a virtual merge at read time
regardless, which is the thing the single-folder layout gives for free by
already storing the merge. There is no `YYYY/MM/` nesting either, for the
same reason a channel day has none: a flat folder sorted by name already
gives the ordering a date tree would, and nobody reaches a day of their
calendar by scrolling a folder — they reach it from `list_meetings`-style
tooling, a search hit, or the meeting-link half below. The default-path check is
`every default calendar path begins with 0-inbox/calendar/, with no account segment`.

The folder is a default, not a prison: Settings already lets the owner choose
a different Calendar destination, and the sync engine now passes that choice
through `calendarDayNotePath` instead of continuing to write the default while
the console displayed the custom path. The override changes only the folder;
the file remains one flat `YYYY-MM-DD.md`, with no account or tenant segment,
and the same validated customer root still wraps it.

**Choosing the folder is what ends "a path this sync writes is a path only
this sync writes", so the pass now asks whose note it is holding.** While the
destination was fixed at `0-inbox/calendar/`, every key a pass touched was one
it had written, and a full pass may delete: it walks all fourteen horizon days
and removes the note at every date with no events. A chosen destination breaks
that assumption in the most ordinary way available — the control plane accepts
`2-areas/communications/daily`, its own test picks exactly that, and
`YYYY-MM-DD.md` is how the owner's Obsidian daily notes in such a folder are
already named, in a bucket this product syncs to Obsidian on purpose. So
`isCalendarDayNote` reads the frontmatter `type` the renderer always emits, and
a note that is not one is neither overwritten nor deleted. It is deliberately
false for anything unreadable as a calendar day, which makes ciphertext skip
too — `sealNoteContent`'s rule (a note this request cannot open is a note it
cannot write) arriving through the call graph rather than a second check. The
checks are `a note this sync did not write is never deleted from a chosen
destination` and `an owner's note with frontmatter of its own is not mistaken
for this sync's`; the second exists because a guard that only asked "does this
open with `---`" would pass the first.

**And a destination that normalizes away is refused rather than filed at the
bucket root.** `normalizeRoot` answers `""` for input that is only separators
(`"/"`, `"///"`), which built `/2026-09-07.md` — no folder at all — and
`<root>//2026-09-07.md` under a customer root. `channelDestinationFolder`
already answers `null` for the same input so its caller refuses; the calendar
copy had restated it without that line. Two implementations of "is this a
folder we will file into" is how one of them ends up the weaker one. The
control plane refuses an empty destination too, so this is the second lock on
a door rather than the only one — and it is the lock a self-hoster calling
`calendarDayNotePath` directly reaches first. The check is `a destination that
normalizes away is refused, never turned into a rootless key`.

That shared file makes **account aggregation a write-time invariant**, not a
presentation detail. A scheduled pass updates one account's private event
cache and renders the day from every contribution assigned to that destination.
Writing the just-synced account alone would make the last account polled erase
the others. `mergeEventCaches` is the fail-closed join: account-qualified event
keys can be unioned without collision and duplicate contributions are rejected.
The control-plane runner now selects the contributors, keeps a disconnected
account only when it has history to preserve, and ignores a disconnected
account that never completed a sync. Each connection atomically replaces one
hash-addressed cache object under
`.context/communications/calendar/contributions/`; the loader refuses a
missing, corrupt, duplicated, re-bound, or concurrently changed source before
the join. Provider event content remains in the customer's bucket, never
Convex.

**Shared contribution storage requires an observed conditional-write
capability.** A stalled pass can be overtaken after the scheduler's safety
window, so “the scheduler normally serializes this source” is not an atomicity
guarantee. R2 and stores whose connection probe proved `If-Match` may use this
path. A provider that ignores preconditions is refused rather than allowed to
turn a manifest into last-writer-wins state. The same gate applies to Chat.

### An event anchor is `evt-` plus the same FNV-1a 64 a message anchor uses

Every event heading carries `{#evt-<16 hex>}`, computed from
`fnv1a64(account \0 calendarId \0 eventId)`. The reasons are the ones
`anchors.js` already argues for a message: the provider's id is a sibling
field on a resource an inviter partly controls, it means something to Google
and nothing to the customer, and FNV-1a is synchronous where
`crypto.subtle.digest` is not. Nothing new is decided here — this is the
existing anchor scheme applied to a second kind of thing, on purpose, so a
calendar link and a mail link are one mechanism rather than two. `eventId` is
the provider's *per-occurrence* id, which Google already hands out once a
request asks for `singleEvents=true` — this package never expands a
recurrence rule itself, and does not need to: each occurrence of a recurring
series arrives as its own object with its own stable id, so it gets its own
anchor exactly like a standalone event.

### The horizon rolls forward on a clock, not on a token

The owner's default is 14 days of future calendar, regenerated as it
changes — but *how* a sync keeps a *rolling* 14-day window fresh, on top of
Google's own incremental-sync mechanism, is the one part of this feature that
does not have a well-known answer, and it is worth stating why the obvious
design fails.

The obvious design: mint one `syncToken` from a request bounded to
`[today, today+14)`, and poll with just that token afterward — small,
efficient, and Google's own docs sound like they invite it. It breaks because
a **syncToken is scoped to the request that minted it, and does not follow a
moving `timeMax`.** A window minted on Monday stays a window ending 14 days
after Monday; on Wednesday, "today+14" has moved but the token has not, so an
event created for what is now the newly-in-range 14th day out was never
inside the window the token remembers and Google has no obligation to report
it on any later incremental call. Combining a `syncToken` with `timeMin`/
`timeMax` on the same request is not even accepted — the two are mutually
exclusive parameters — so there is no "just widen the window each poll"
patch, either.

So the sync this package's `planSyncRequest` describes does two things,
deliberately kept apart: a **full request**, bounded to `[today, today+14)`
with no token, run once whenever the owner's own calendar date has moved past
the day the last full request was anchored to (`lastFullSyncDate !== today`)
— which is what actually rolls the window forward, at most once per day per
connection; and a plain **incremental request**, token only, no window at
all, for everything in between — which is what keeps the common case (a day
with nothing rescheduled) to one cheap call rather than a full backfill every
time. A `410 Gone` — Google's own signal that a token no longer resolves —
folds into the same full-request path with no separate code of its own: it is
just one more reason `lastFullSyncDate` should be treated as stale.

**Ground truth on a full sync, cache-and-project on an incremental one.**
Because Google's incremental sync carries no window at all, a changed event
can, in principle, arrive dated anywhere — including well outside this
connection's own horizon, which must be absorbed into bookkeeping and never
written as a note (`calendarSync.test.mjs`, "a change dated ten months past
the horizon never becomes a note"). And because rendering a day needs its
*complete* current event list, not the delta that just arrived, incremental
sync keeps a small local cache — everything currently known to be in
play — folds each incoming change into it (`applyIncremental`), and
regenerates only the day(s) a change actually touched
(`docs/decisions/communications.md`'s own "per-day regeneration" test, and
the reason: a channel-day note never needed this, because a mailbox's inbox
is already a complete list with nothing to project). A **cancelled** instance
is removed from the cache outright — there is no "cancelled" state stored,
because a cache entry existing at all already means "render this," and a
full sync's ground truth needs no separate deletion list for the same reason:
an event absent from a full listing is absent from the calendar, full stop.

The residual, stated rather than hidden: a **standalone** (non-recurring)
event's cancellation notice can arrive with no date information at all —
Google's documented shape for that case is `{id, status: "cancelled"}`,
nothing else — and the only way to know which day to regenerate is the
cache's own memory of where that event used to be. A cache that had never
seen the event (a connection reconnecting mid-flight, say) cannot regenerate
that day; it is left as it was, which is the same "leave it as it was rather
than guess" rule the horizon boundary already follows. Checks:
`applyIncremental resolves a bare cancellation from its own previous record`
and `an event that moves days regenerates both the day it left and the day it landed on`.

### Idempotent regeneration is two separate properties, and both are tested

"The same day rendered twice is the same bytes" is `renderCalendarDay`'s own
determinism (chronological order, anchor as the tiebreak, exactly the
discipline `renderChannelDayNote` already has). "Running the same sync twice
makes no writes" is a second, gateway-level property:
`syncCalendarAccount` compares a candidate day's freshly rendered text against
what the store already holds and skips the write when they match — a
no-op incremental poll costs a handful of cheap reads and exactly zero
writes, exactly zero conditional-write retries, and zero entries in a
customer's object-version history. The check is `re-running an unchanged sync makes no writes at all, and every byte matches the prior run`.

### Timezone: `Intl.DateTimeFormat` only, and a DST fixture pinned to real dates

Every start/end, every day-of-week decision, and every zone label
(`EST`/`EDT`, not a fixed offset) is computed with `Intl.DateTimeFormat`
against the connection's own IANA timezone — never a hand-rolled offset table.
Workers and Node both ship the full tz database behind `Intl`, so this adds no
dependency and no data file to keep current as governments change their DST
rules, which they periodically do.

**Tested against real transition instants, not an assumption about how DST
behaves**: America/New_York's actual 2026 transitions (spring forward March
8, fall back November 1) are hard-coded fixture instants either side of each
transition, and the check asserts both the clock *and* the zone abbreviation
change correctly. This matters because the failure mode that broke it in
sabotage was not "the time is wrong" — the clock stayed right — it was "the
event says EST when it happened during EDT," a class of bug that reads as
correct to anyone not doing the arithmetic by hand and is exactly the kind of
thing a note a person actually reads would show them being lied to by an
hour's label without the time itself moving. The check:
`before spring-forward, EST; past the transition, EDT — same zone, same day, different instant`.

### Contacts: attendees feed the same merge rules email does, through a draft shape

`docs/decisions/communications.md`'s contacts section (above) already decided
how two people become one contact: exact identifier equality auto-merges,
everything weaker is a suggestion, and a person's own edit always wins. None
of that is redecided here. `contactDraftsFromEvent` turns one calendar
event's attendees (and its organizer, if not already listed as one) into the
same `Contact`-shaped object `canAutoMerge`/`mergeContacts` already consume —
one identifier, one activity entry pointing at the event's own anchor and day
— so folding a calendar attendee into an existing email-derived contact is
the existing merge machinery, unmodified, fed a second kind of source. A
cancelled event drafts nobody: crediting activity to a meeting that did not
happen is the failure `docs/decisions/communications.md`'s own merge argument
exists to avoid one level up. The check is
`a calendar draft auto-merges with an existing contact sharing the address, and a cancelled event drafts nothing`.

### The link lives in a frontmatter key, not a new section

A captured meeting note that matches a calendar event by time window and
title gains a link to the event's anchor — the scoping note's request, and
the desktop's own detection is explicitly left to consult the resulting day
note on its own; this package builds only the matching and the write.

**The match**: a candidate calendar event must overlap the meeting's own
recorded time window (with a 15-minute tolerance either side, because a
recorder starts when a person joins a call, not when the calendar says a
meeting begins) — that is the gate, and with exactly one overlapping
candidate it is also the whole answer, because a meeting recorded during
exactly one calendar event is that event whatever either happened to be
titled. Only when there is a genuine *choice* between two or more overlapping
candidates does title similarity (a dependency-free word-set Jaccard score)
break the tie, and a choice with no title resemblance to either candidate
resolves to no match rather than a guess — the same "absence over a wrong
answer" instinct the rest of this file argues throughout. Check:
`a single overlapping candidate matches on the time window alone; two candidates need title agreement, and no agreement is no match`.

**The write is a text patch, not `renderMeetingNote(session)` run again.**
`packages/meetings` gained one new, optional frontmatter key — `event`,
empty until a match exists — for exactly this. The obvious way to set it
("load the session, set `.event`, render again") is wrong for the reason
`## My notes` is never rewritten: by the time a calendar sync runs, the
session that produced the note may not exist anywhere any more, and three
surfaces write a meeting note today (phone, desktop, gateway) with a fourth
"soon" — a re-render pipeline would have to agree with all of them on a
session shape it does not need to know about at all. So `attachEventLink`
is a **patch**: find the closing `---` of an existing frontmatter block,
insert or replace one `event:` line, leave every other byte untouched —
including a transcript nobody wants re-parsed to add a link. It works on a
note this package never rendered (a hand-written fixture using the same YAML
convention is a check by name:
`a note this package did not render is patched the same way`), and setting the
same link twice is byte-identical, which is what keeps a repeated match from
ever producing a no-op write. The cost of the frontmatter-key approach over a
new section: none measured — `parseMeetingNote` already reads every key it
finds rather than a fixed list, so an older client reading a linked note
simply sees one more frontmatter line it does not use, and a client
constructing a `MeetingSession` with no `.event` at all renders exactly the
note it always has, `event: ""` and all.

### Calendar-day notes join the recency exclusion as their own kind, not folded into mail

`docs/decisions/communications.md`'s "A firehose is not attention" already
collapses a connected mailbox's daily notes to one line in `orient`'s recency
list, because a note written every active day forever would otherwise drown
every hand-edited note within days. A calendar day is written on exactly the
same cadence and would cause exactly the same flood, so `classifyCaptureKind`
gained a fourth answer, `calendar-day`, recognised the same way every other
kind is — by path alone, `0-inbox/calendar/<date>.md` and nothing else,
because there is still no writer-identity signal anywhere in this stack that
could do better.

**Its own kind, not `channel-day`**, even though both are "automated capture"
in the same sense: "what came in" (mail) and "what's on my calendar" are
different questions, and folding the two into one collapsed line would answer
neither — a caller asking `orient` for their day would see "40 automated
notes arrived" and learn nothing about the *shape* of that number. Sabotage
found the direction this actually breaks in: dropping `calendar-day` from the
*display* order (leaving classification alone) does not misclassify anything
— it makes calendar days vanish from `orient`'s answer with no summary line
at all, silently, which is exactly the "answer with a pointer, never silence"
failure the firehose decision was written to reject, reached from a different
line than the one that decision's own sabotage record found. The checks are
`calendar days collapse to their own line, never counted as mail and never shown individually`
and `dropping calendar-day from the summary order — not from classification — still answers with silence, which is the failure this collapse exists to prevent`.

### The horizon is drawn in the owner's timezone at BOTH ends, or it loses a day's edge

Found by adversarial review of the Calendar PR, and it is the failure this
whole section is otherwise careful about: silent, plausible, and written into
somebody's bucket as if it were the truth.

A horizon is a set of **calendar dates on the owner's own wall clock** — the
same dates a day note is filed under. A provider query is a pair of
**instants**. The first implementation converted one to the other by pasting
`T00:00:00.000Z` onto the date, which is the owner's own day for exactly one
timezone. At `Asia/Tokyo` the query began nine hours into the horizon's first
day, so an 08:00 local meeting was never fetched — and because a full sync is
*ground truth*, the day note was then regenerated **without** it, deleting an
event that was really there. At `America/New_York` the same arithmetic ended
the query four hours before the horizon's last day did, so that day's whole
evening — or the day's only note — never existed.

So `zonedDayStartInstant(date, timeZone)` in `calendar/timezone.js` is the one
conversion, `Intl` again rather than an offset table, two passes because the
offset depends on the instant and the instant depends on the offset (one pass
is off by exactly the hour that moved on a DST-transition day). Over-fetching
at an edge would be harmless — the cache is keyed by local date and pruned to
the local window — so the conversion is exact rather than padded, and the
padding is not what makes it safe. The checks are
`an event before 09:00 on a +09:00 owner's first horizon day is fetched, not silently dropped`,
`an evening event on a -04:00 owner's LAST horizon day is inside the window`,
and `a Tokyo day starts nine hours BEFORE UTC midnight, not nine hours after it`.
Sabotage: restoring the `${date}T00:00:00.000Z` window fails 3 checks, all
three naming the two zones by name, and every other calendar check stays green
— which is the point, because a UTC-only fixture cannot see this at all.

### An attempt is for the products it parked, and one table serves every flow

`googleConnectAttempts` is shared by every product's connect flow, and all
three `complete*` consumers looked up an attempt by `hashedState` alone. So a
state parked by `startGmailConnect` could be answered on Calendar's callback —
attaching `calendar` to the row out of a consent screen that never mentioned a
calendar, with an empty scope slice beside it — and a Calendar attempt could be
answered on Gmail's, binding a mailbox folder and a default 90-day backfill out
of a consent screen that never mentioned mail. Neither is a cross-tenant hole
(the state is the person's own secret, and the workspace still comes from the
attempt, never from the caller), but each writes a product onto the row that
nobody consented to, which is a lie about what was agreed rather than a sync
that merely fails. **Whether a discriminator earns its cost is a question of
how many consumers there are**, and Chat's review left it open at two on
exactly that ground; at three it is a rule rather than a question, so all
three now check `attempt.products` and all three refuse with the ordinary
`CONNECT_ATTEMPT_INVALID`, which tells a caller nothing about which flow
parked what. Three lines, one per consumer, and a fourth product inherits it
by copying the file it starts from. The checks are
`a Gmail-only attempt cannot be completed as a Calendar connect`, the same for
Chat, and their mirrors; an attempt naming two products is still answerable by
either of their flows, because that is the union case the scope fix exists to
produce.

### A grant that lost a product's scope is not just recorded, it is reported

(Chat's own reconciliation reached the same conclusion independently and
landed first; the two implementations were reconciled on merge into one rule
spelled the same way in all three bindings. What follows is the argument.)

The row being *honest* about a downgraded consent — `gmail.scopes: []` beside
a `products` still listing `gmail` — is the rule this file argues twice above,
and it is not sufficient on its own: **nothing reads a scope slice.** Written
and never spoken, that fact leaves a mail sync being scheduled against a grant
that can only answer 403, while every screen shows the connection as healthy.
So a bind that leaves any product on the row without the scopes that product
needs sets `health: "reconnect_required"` with `errorCode: "SCOPES_INCOMPLETE"`
— the existing word for exactly this state (`markReconnectRequired`), with the
same remedy — and a bind that covers everything leaves the health field alone,
because a product's sync state is that product's own to manage.

The one other health case a Calendar bind does own: a connection that was
**disconnected** and is now being given a fresh grant by this very mutation.
Clearing `disconnectedAt` while leaving the `"error"` health that disconnect
set would leave a working connection permanently showing a fault, with no
error code to explain it and nothing but a Gmail reconnect to clear it. The
checks are
`a Calendar bind that loses Gmail's scope marks the connection as needing a reconnect`,
`a grant that covers both leaves the health alone`, and
`reconnecting a DISCONNECTED account through Calendar makes it healthy again`.

**A Calendar page walk must reach Google's terminal page before it can
succeed.** The terminal page is the only one that carries `nextSyncToken`, so
silently returning after a page cap leaves the caller with no safe cursor and
makes the next scheduled pass replay the same pages. `fetchAllPages` now
remembers every continuation token, refuses a repeated one, and treats its
thousand-page ceiling as the same fixed `PAGINATION_STALLED` failure rather
than a partial result. The fixture repeats one token and throws if a third
request is attempted.

### The live Calendar pass

The account-level forward loop now runs Calendar through the same credential
barrier, claim, retry ladder and owner-only status used by Gmail and Chat. A
Calendar-only connection is due immediately. On a row with several products,
the least recently synced product runs first so Gmail cannot starve Calendar.
Calendar writers are serialized per workspace because they replace shared day
notes.

The first provider response supplies the primary calendar's IANA timezone under
the existing `calendar.events.readonly` scope. Until that response arrives, the
first request over-fetches one UTC day at each edge, then prunes the cache to the
exact 14-day local horizon. Later passes use the stored contribution's timezone.
Accounts sharing one destination must use one timezone; otherwise the pass
fails with a sentence asking the owner to choose separate folders rather than
filing an event under the wrong day.

The runner writes the account contribution first, loads every contributor for
the destination, renders only the affected days, and advances `syncToken` and
`lastFullSyncDate` last. A missing sibling contribution is a warm-up skip, not
an outage. The new note's fence nonce is a stable hash of internal connection
ids and the date, so an event sender cannot derive it from the account address
printed in the note.

The remaining Calendar work is live-account proof. The fixture suite covers
timezone discovery, shared rendering, cursor ordering, missing contributors,
conditional writes and disconnect history, but a connected production account
still has to complete a pass before Settings should claim delivery.

Also not built, named so a future reader knows these were considered rather
than missed: RSVP/response writes (v1 is read-only, matching the read-only
mail decision above); a scheduling or free/busy feature; a per-calendar (as
opposed to per-account) connection; splitting an oversized calendar day into
parts (a day's worth of meetings — dozens at most — does not approach the
512 KB threshold a heavy mail day can, so the machinery `planChannelDay`
already has was not duplicated for a case that does not arise); and the
desktop's own consultation of a calendar day note as a detection signal,
which is explicitly the other project's to build against the day note this
one already writes.

### What is deliberately not built

Named so that a future reader knows these were considered rather than missed:
per-message notes (16,000–292,000 notes per person per year — the storage
estimate rejects it numerically); a cross-day thread *file*; a
communications-specific privacy tier or grant scope; a workspace or team
inbox; reply, send, archive, delete or mark-read (v1 is read-only, and the
mail client stays the mail client); a second inbox root; a search path that
does not go through `searchIndexedNotes`; and any note in this tree that is
not an ordinary note at an ordinary path. For Chat specifically: a Chat *app*
(bot identity, posting, interactive cards) — v1 reads with the person's own
user-authorized grant and configures nothing in Google's Chat app console; and
a per-Google-account Chat folder — one shared `0-inbox/google-chat/` regardless
of how many accounts sync into it, argued above.

### iMessage reads `chat.db` in place, through the one binary every Mac already has

The scoping note draws iMessage as the third channel beside mail and Google
Chat, and it is the first one this repository actually ships end to end
(`apps/desktop/src/core/imessage/`) — Gmail and Google Chat are still fixture-
only, per the decision above. Reading it needed answers to four questions
nothing else in this codebase had already answered, because nothing else here
shells out to a database somebody else's application owns.

**No native module, no copied database, one child process.** Electron 33 ships
no SQLite binding and this app takes no native modules, so every read is
`/usr/bin/sqlite3 -readonly -json`, run exactly the way
`platform/exec.ts` already runs `osascript` — `execFile`, never a shell, a
timeout that cannot hang the sync loop. The database is opened through a
`file:…?mode=ro` URI **in place**: WAL-mode SQLite already tolerates a second
read-only reader while Messages.app holds the file open, and a copy would be a
second, larger surface for "did we just leave a stray file with somebody's
messages in it" to go wrong on. The check is `queryChatDb` never accepts a
path other than `~/Library/Messages/chat.db`, resolved and compared before a
process is spawned — `isAllowedChatDbPath` in `core/imessage/paths.ts` — and
there is no bridge channel, IPC argument, or settings field that can name a
different one. **No page ever supplies a path**, which is the whole of what
"no path argument from the page" means: the only path in this feature is a
constant.

**Every column `sqlite3 -json` would corrupt is cast in the query, not
repaired after.** Measured against the real CLI (`sqlite3` 3.45.1, the version
this sandbox has and a recent macOS ships too): a `BLOB` column prints as a
mangled, non-hex, non-base64 escape sequence, and a 64-bit `date` — Apple's
epoch is nanoseconds since 2001-01-01, and a 2026 timestamp in that unit is
~7.9×10¹⁷, comfortably past `Number.MAX_SAFE_INTEGER` — comes back as a bare
JSON number that `JSON.parse` silently rounds, verified to turn
`757382400123456789` into `757382400123456800`. `schema.ts`'s queries select
`hex(attributedBody)` and `CAST(date AS TEXT)` (and `CAST(ROWID AS TEXT)`,
`CAST(total_bytes AS TEXT)`, for the same reason on smaller numbers), so
neither corruption ever has a value to happen to. `appleTime.ts`'s
`appleEpochNsToIso` refuses anything that is not a plain digit *string* rather
than trying to detect and repair a value that already lost precision — a
caller that forgot the cast gets `null`, not a wrong date it cannot tell is
wrong. The check is
`a JSON number is refused, not silently rounded`, proven against the exact
measured value above, and `imessageSqlite.test.mjs` proves the query itself
produces the string shape by running the real binary against a fixture
database built from Apple's documented schema — never a copy of a real one,
which this repository is public and must never carry.

**`attributedBody` is decoded by a byte-pattern heuristic, not a parser for
either archiver format it might actually be.** `text IS NULL` still has a body
whenever a message carries rich content, and macOS puts that in an archived
`NSAttributedString` — the legacy `streamtyped` `NSArchiver` format before Big
Sur, or an `NSKeyedArchiver` binary property list on every macOS this feature
will actually meet. A full parse of either is a real project: a typedstream
class-version table, or resolving a bplist's `$objects`/`UID` graph. Both
formats spell the class name `NSString` in plain ASCII immediately before a
length-prefixed run of the string's own UTF-8 bytes, and that is the one fact
`extractAttributedBodyText` depends on — it finds the **last** `NSString` in
the blob (the class table names it too, earlier), then scans a bounded window
past it for a byte that names a length actually reaching the string. The cost
is stated rather than hidden: this is not a general reader, a blob with no
recoverable string answers `null` rather than throwing, and the caller's
fallback is an empty body — losing the text of one hard-to-parse message is a
far smaller defect than losing a whole day's import to it. What "favour
scanning past a rejection over stopping at the first plausible one" cost and
bought is argued in the function's own comment, because it was tried the other
way first and measured to break real decoding — see the checks named on
`extractAttributedBodyText` and `imessageAttributedBody.test.mjs`'s sabotage
record.

**A tapback is folded into the message it targets, and is never a message of
its own.** `associated_message_type` `2000`–`2005` is a reaction
("loved", "liked", …); `3000`–`3005` is one undone. Neither becomes a
`CommunicationEvent` — a channel-day note's headings are exactly its messages,
and rendering a reaction as one would put a heading with no real content of
its own in somebody's note, one for every tap. Instead, an added tapback
appends one line to the *body* of the message `associated_message_guid` names
(stripped of macOS's `p:0/` / `bp:` scheme prefix), which the existing
untrusted-fence machinery in `packages/communications` then quotes exactly as
it quotes everything else a sender wrote — no new trust boundary, because
there is no new kind of content crossing it. A removed tapback is dropped
outright: representing "undone" would mean carrying state across syncs about
which reactions are still standing, and an undo that changes nothing about
what was actually said is not worth that machinery in v1. A tapback whose
target is outside the day being rendered (a reaction added later, to a
message from a previous sync) is silently dropped rather than attached to
nothing — the day is the only place this function can look. The check is `a
tapback never becomes an event of its own`, sabotaged by making
`isReactionRow` always answer `false` — 7 checks fail, none of them about
tapbacks specifically, because the folded rows fall back to being read as
ordinary (empty) messages and are dropped by the no-content rule instead,
which is itself a second finding worth naming: a broken fold degrades to
silently losing the reaction rather than corrupting a note.

**And a tapback may only annotate a message in its own conversation.** This
was found in adversarial review of the fold above, which matched on the target
GUID alone. `associated_message_guid` is bytes the *reacting* device chose,
and a `message.guid` is unique across the whole database rather than per chat
— so a reaction row filed under one conversation naming a GUID from another
was folded onto it, appending `+1555… loved this message.` to a message body
in a conversation that handle was never in. Anybody who has ever messaged this
Mac knows the GUIDs of the messages they sent, which is the whole of what the
attack needs: a line naming themselves, inside the fence, in a thread they
were not part of, in a document presented as a record of what happened there.
macOS files a tapback in the same chat as its target, always, so the fix costs
nothing real: the fold requires `target.threadId === row.chat_guid` and drops
the row otherwise, exactly as it already drops one whose target is outside the
window. The check is `A TAPBACK FROM ANOTHER CONVERSATION IS NOT FOLDED onto a
message it names by guid`; removing the comparison fails 2.

**Full Disk Access is attempted, never requested by an OS prompt — there is no
such API.** Unlike the microphone or Screen Recording
(`core/capture/permissions.ts`), macOS raises no dialog for this permission at
all; the only way to learn whether it is granted is to try the read and see
what happens. `core/imessage/permission.ts`'s `detectFullDiskAccess` is a pure
function over an injected attempt, matching the shape every other macOS-only
seam in this app already has, and it distinguishes three answers rather than
two: `"granted"`, `"denied"` (the file exists and the OS refused to open it —
this *is* the permission), and `"unknown"` (everything else, including "the
file does not exist because nobody has used Messages on this Mac", which
granting Full Disk Access would not fix). Collapsing the last two into
`"denied"` was sabotaged and measured: it fails 2 checks, both about the same
failure direction — telling somebody to go grant a permission that would not
fix their actual problem is a dead end dressed as an instruction. The notice
names the exact pane, `System Settings → Privacy & Security → Full Disk
Access`, and offers the one deep link macOS honours,
`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` —
never a sentence that could apply to the wrong permission, which is the same
rule `docs/decisions/desktop.md`'s permission-notice work already established
for capture. When an enabled import changes to `"denied"`, the Mac app now
shows that explanation in a native sheet and offers to open the exact pane;
the Chats settings card keeps the steps and button visible until a later read
succeeds, including the required quit-and-reopen step after changing TCC.
for the microphone.

**There is no `chooseMailboxSlug` for iMessage, and there never will be.**
`channelFolder("imessage", account)` already refuses an `account` argument —
`docs/decisions/communications.md`'s own asymmetry, "a person has several
mailboxes and one iMessage" — so every event this reader produces carries the
fixed constant `IMESSAGE_ACCOUNT = "imessage"` as its `account` field, used
only to seed `messageAnchor`/`threadKey`'s hash inputs and never written to a
folder path. `chat.db` merges every iMessage identity signed into Messages on
one Mac into one database with no per-identity split worth exposing, so a
folder-per-account scheme would invent a distinction the data does not carry.

**A day is regenerated whole from the source of truth, never patched.**
Incremental sync finds which UTC calendar days got new `ROWID`s since the last
cursor, then re-reads and re-renders **the whole day** for each one from
`chat.db` directly — never by appending to a stored note. That is what makes a
late-arriving row, a fixed reader bug, or a corrected reaction self-healing on
the next sync rather than needing a backfill tool of its own, and it is what
"regenerating only affected days" in the scoping note actually means: bounded
to the days that changed, not bounded to appending onto what was last
written.

**Which means a day that *shrinks* has to lose its extra parts too.** An
oversized day splits by rendered bytes (see the split decision above), so a day
that loses messages — somebody deleted them in Messages.app — can render into
fewer parts than it did last time, and the parts past the new last one are
simply never re-rendered. Left alone, `2026-09-07-part-2.md` keeps the deleted
messages in the bucket forever: the one outcome a person who deleted a message
is entitled not to get, reached through the gap between "the day is
regenerated whole" and "the day is a set of files". So `retireOrphanParts`
walks upward from the day's new last part until it finds one that is not
there, and rewrites each it does find with the same day rendered with **no
events** — `messages: 0`, `_(no messages)_`, the day's own fence nonce. The
file itself stays, because this app writes into somebody's own bucket through
`write_note` and does not remove their notes; what it guarantees is that no
message body survives in one. A `read_note` that *fails* during that walk
stops it and is reported as an error rather than read as "no more parts", so a
transport blip is never the reason a stale part is left standing. The check is
`A DELETED MESSAGE DOES NOT SURVIVE IN THE ORPHANED PART`; skipping the walk
fails 3, and the fixture deliberately gives the two messages different
timestamps so the split is deterministic — with a shared timestamp the tie
breaks on an anchor hash and the deleted message can land in part 1, where the
ordinary rewrite removes it and the check passes without exercising an orphan
at all.

**Idempotent upsert is a real property of the bytes, and two things had to be
true for it to hold.** Re-running a sync with nothing new must write nothing —
not "write the same bytes again," but make zero `write_note` calls, since a
call the gateway happens to answer identically is still a call. Two pieces
make that true together, and either alone is not enough: the fence nonce for
an existing day is **read back out of the stored note** and reused
(`existingNonce`, matched against the exact marker `renderChannelDayNote`
writes) rather than minted fresh on every render — a fresh nonce every sync
would rewrite every message's fence, forever, which is the failure a
nonce-per-note is supposed to prevent turned into the reason it never stops
happening; and the comparison that decides whether to write at all ignores
the `updated:` frontmatter timestamp (`withoutUpdatedTimestamp`), because that
field is genuinely different on every render and comparing it literally would
make every sync of an unchanged day look changed. Sabotaging the comparison to
compare literally was measured **twice**: the first attempt found nothing,
because the test fixture's own `now()` never varied between two calls, so the
scenario the guard exists for was never exercised — the fixture was the
defect, not the code, and it was fixed in the same commit as this sentence
rather than left as a guard nobody's test actually checks (`CLAUDE.md`, *a
guard nobody has checked is not a guard*). Fixed, the sabotage fails 3 checks.
The check that matters is `a day re-queried because of a new row that renders
no visible change is reported unchanged, not written` — the one scenario
where a day is re-read (a new row genuinely arrived) yet the rendered bytes
are unchanged (a removed tapback contributes nothing), which is the only case
that actually reaches the comparison this guard is about.

**The write goes through `write_note` over the machine's own MCP grant, not a
new gateway route.** The meetings protocol's four bespoke REST routes
(`docs/decisions/desktop.md`) are shaped for one thing — a session, its
segments, its notes, its finalize — and a channel-day note is not that shape:
it is an ordinary note at an ordinary path, which is exactly what `write_note`
already exists for. So `core/imessage/gatewayNotes.ts` speaks the gateway's
modern MCP envelope directly (`POST /mcp`, `MCP-Protocol-Version: 2026-07-28`,
`Authorization: Bearer <this machine's token>`) rather than growing the
gateway a fifth bespoke route for one client. **The credential and the tier
check are the same ones the meetings path uses** —
`GatewayConnection.token()` and `grantCoversMeetings(scope)` from
`sync/connection.ts`, reused rather than duplicated, because "write plus the
private tier" has nothing meeting-specific in it. A grant connected at the
team tier holds iMessage's notes exactly as the meetings path holds a meeting
recorded on the wrong tier — never sent team-visible, never dropped, waiting
for a reconnect at the tier the person meant. This is a decision to record
because the gateway itself is out of scope for this feature (`apps/mcp` has
no new route and no new test requirement here): the alternative, a bespoke
`/imessage/...` REST surface mirroring the meetings one, was rejected as a
protocol invented for one client where a protocol every MCP client already
speaks would do.

**A gateway refusal's own words never reach a person, only this app's.** Also
found in adversarial review. A failed `read_note`/`write_note` used to answer
with the tool's own error text, and that string travels: `sync.ts` puts it in a
`DayOutcome`, `main/imessage.ts` puts that in `ImessageStatus.lastError`, and
the bridge pushes it to the console page and the tray. It is a string somebody
*reads*, on the one path in this app carrying a day of their messages — so a
gateway that quoted the note it refused (a validation error naming the
offending line, a proxy echoing the request body) would put a fragment of that
day on a screen through an error nobody was watching. The tool's text is now
read to **classify** — `not found` is how `toolReadNote` says a path does not
exist yet, the `conflict:` prefix is what drives the one re-read-and-retry —
and then dropped for one of four fixed sentences in `NOTES_REFUSAL`. It costs
the ability to see the gateway's exact complaint, which was never in a log
anyway (this feature writes none), and it makes true of the network path what
`exec.ts`'s `run` already makes true of the process path and `sqlite.ts` of
the database path: the same rule, in the third and last place it has to hold.
The check is `A WRITE REFUSAL THAT QUOTES THE NOTE BACK DOES NOT FORWARD A
BYTE OF IT`; forwarding the text again fails 4.

**"The read is refused when the grant is missing" means the message content
never leaves the database, not merely that it is never sent.** The Full Disk
Access probe (`attemptChatDbRead`) is an `fs.access` check with no message
content in it at all, and it always runs — a person can see *why* the toggle
is stuck, even while disconnected. The actual query that reads rows of
`chat.db` into process memory runs only after `GatewayConnection.baseUrl()`
answers non-null — this Mac is connected to some context — so a disconnected
machine never executes a single `SELECT` against anybody's messages. A
connected machine holding the wrong *tier* (team, not private) is a narrower
case this does not close the same way: `queryMessages`/`queryAttachments` for
the affected days still run before `write_note`'s own tier check refuses the
write, so the content is read into memory and discarded rather than never
read at all. That is the same shape the meetings outbox already accepts (a
recording is captured and held before its tier is known to be wrong), stated
here rather than left implicit, because it is the one place "refused when the
grant is missing" is narrower than it might sound.

**What is deliberately not built, named for the same reason the list above
is:** contact resolution (an iMessage handle is rendered as itself — a phone
number or an email address — never resolved against `0-inbox/contacts/`,
which is Gmail/Google-Chat-shaped work this feature does not need to unlock);
recovering `attributedBody` on a macOS release before Big Sur, where the
`streamtyped` format's exact byte layout may differ from what the heuristic's
fixtures cover (the heuristic degrades to `null` there, not to a wrong
answer); a console/mobile settings screen consuming
`packages/desktop-bridge`'s `imessage` member (the bridge surface and the
tray checkbox are both real and independently sufficient; a phone screen for
the same toggle is follow-up UI work); attachment bytes (metadata only,
exactly as email attachments are, per the retention decision above); and
group-chat participant names resolved against contacts (a participant is
rendered as their raw address, the same simplification as the sender).

**`readChatDbWindow`'s `selfAddresses` option exists and is not yet wired to
a real value.** `chat.db` does not reliably carry "which of these handles is
this Mac's own" — that lives in Messages' separate account configuration, not
in the tables this reader reads — so `main/imessage.ts` passes none today. The
one visible cost is cosmetic and stated rather than hidden: an unnamed group's
synthesized subject can include the owner's own address alongside everyone
else's, where a resolved identity would have excluded it. Nothing about
content, folding, or privacy depends on this value; it is read only to build
a heading string.

### The destination rule is shared, so the field can say something before Save

`normalizeDestinationFolder` lived in `apps/convex/functions/googleConnect.ts`
as a private function that threw `ConvexError`. That put the rule out of the
console's reach, and the field somebody types a sync destination into paid for
it: no completion, no validation, and no preview of what the pattern produces.
The mutation was the first thing that checked, and it refused *after* Save —
into a field narrower than the paths people put in it, so the value being
checked had already scrolled out of view.

It is `@context/communications/destination` now, and it **answers with a value
rather than throwing**: `{ ok: true, folder }` or `{ ok: false, code, message }`.
Two reasons, and only the first is obvious. A thrown message cannot be rendered
under a field while somebody is still typing. And `normalizeRoot`'s messages
quote what they refused, which is a reflection — fine for a prefix a customer
typed into their own binding, wrong for a value that reaches a settings panel
and a `ConvexError`. The control plane maps the result to its own error and
keeps the `GOOGLE_` codes its callers switch on, so **the server-side check is
still the one that matters**: a client with the check removed is still refused.

Two functions came with the move and are new capability rather than a
relocation. `resolveDestinationPattern` answers what a pattern writes on a
given day — the half the field never had, because a pattern carrying
`YYYY-MM-DD` is a template and nothing ever showed its output, so the only way
to learn you were wrong was to wait for a sync. `suggestDestinationFolders`
answers what could come next, matching on the **last segment being typed**
against folders under the same parent: a completion that matched anywhere in
the path would offer `1-projects/comms` to somebody who committed to `2-areas/`
two keystrokes ago. Neither ever offers a folder the validator would then
refuse.

Both take their inputs rather than reading the world — the date, and the folder
list — so they stay pure, and the console hands them
`loadedFolders(files.listings)`, the same source the forwarding-address card's
quick-picks already read. No second listing.

**What a "simplification" would cost**: putting the rule back behind the
mutation returns the field to guess-and-wait. Letting the console validate with
a rule of its own is worse than either — a client that allows what the server
refuses is a Save button that reports success and changes nothing.

**The sabotage row worth remembering**: swapping the local date parts for
`toISOString` in `resolveDestinationPattern` failed **zero** checks. CI runs in
UTC, where the local date and the UTC date are the same date, so the check
written to catch it was asserting a tautology. It forces `TZ` now, with a
second check asserting the forcing worked — a guard nobody has checked is not a
guard, and that included that one.

**The tests that fail if this is reversed**:
`packages/communications/test/destination.test.mjs`, the refusal guard in
`apps/convex/__tests__/googleConnect.test.ts` (which catches the import being
swapped for a pass-through, something the package's own suite cannot see), and
`apps/mobile/__tests__/googleDestination.test.ts`.

### iMessage import has never reached the gateway, and the two decisions that made it so are both in this repository

Found 2026-09-19, from a console screenshot: *"Import is on; last synced Sep
18, 10:31 PM"* with `this machine's grant was refused` under it. The sentence
is `NOTES_REFUSAL`-adjacent — `gatewayNotes.ts`'s fixed answer to an HTTP 401
or 403 — and the cause is not a revocation, an expiry, or anything a person
did. **A desktop machine grant cannot call `/mcp` at all**, and never could.

The two halves are each argued, each recorded here or in `desktop.md`, and
contradict each other:

- *The write goes through `write_note` over the machine's own MCP grant, not a
  new gateway route* (above) chose the MCP tool surface for the channel-day
  note, and closed with **"the gateway itself is out of scope for this feature
  (`apps/mcp` has no new route and no new test requirement here)"**.
- `MACHINE_GRANT_SCOPES` in `apps/convex/functions/lib/machineGrant.ts` mints a
  machine's grant as exactly `context:write context:private`, and says why
  there is no read: *"a laptop credential that could read every note its owner
  ever wrote is past what this feature is worth."*

`apps/mcp/src/index.js` gates the **whole** `/mcp` endpoint on `context:read`,
above the tool dispatch, and `effectiveScopes` in `session.js` strips the
implied read from a grant that does not carry it — a write-only grant is read
as capture-only by construction. So every `read_note` and every `write_note`
from a Mac answers `403 insufficient_scope`, decided before a store is opened
or a tool name is looked at. Measured against the real worker with the control
plane stub, at exactly `["context:write", "context:private"]`:

```
read_note  → 403 {"error":"insufficient_scope",
                  "error_description":"This connection does not hold the context:read scope."}
write_note → 403 (the same, for the same reason)
```

Meetings is unaffected and always was: `scopeForMeetingRequest` asks for
`context:write` on a POST, which the grant has. The machine credential was
designed for the meetings REST surface, and iMessage was later built on a
different surface without the scope that surface requires.

**Why no suite caught it.** `apps/desktop/test/imessageGatewayNotes.test.mjs`
drives a fake `fetch` that answers 200, using the literal string
`"context:write context:private"`; every grant in the gateway's own
`meetings.test.mjs` carries `context:read`. `autoGrant.test.mjs` does pin the
two scope literals to each other across the repository — which is exactly why
they are consistently wrong together. **Nothing pins either of them to the
surface the client actually calls**, and that is the guard this defect is
asking for, not a third copy of the string.

**Not fixed here, because the fix is a fork and both branches cost something a
person decided on purpose.** `decideMachineApproval`'s third condition is set
equality against the default, and its own comment anticipates this exact
request: *"a request that added `context:read` is a different question and gets
the screen that asks it."* So widening `DESKTOP_SCOPE` alone does not quietly
work — it brings back the approve screen that #312 and the owner's *"when
installing Granola I didn't have to 'connect' a machine"* removed. Auto-
approving the wider set instead is the other branch, and it makes a no-screen
credential one that reads every note in the context. The grant already *writes*
every note in the context, which is the argument for it; confidentiality and
integrity are still not the same loss, which is the argument against.

**What did land**: the console's own lie about it, below.

### "Last synced" means a pass that filed something, not a pass that ran

The same screenshot, second half. `ImessageStatus.lastSyncedAt` is rendered by
`ThisMachineCard` as *"Import is on; last synced &lt;time&gt;"*, and
`contract.ts` defined it in two ways in one comment — "when it last actually
wrote something" on the interface, "the last completed sync attempt" on the
field. The shell implemented the looser one: **any** pass with a written *or
errored* day stamped it, and so did the baseline pass that imports nothing by
design.

Both readings are wrong in the same direction, and the direction matters. A
gateway refusing every write still ends a pass, so the timestamp advanced every
five minutes, more reassuring each time, over an import that had never filed a
single message — on precisely the screen somebody opens to find out whether
this is working. The baseline pass is worse for being first: it is the pass a
person is most likely to be watching, and it claimed a sync a minute after they
turned the feature on.

Now a pass stamps `lastSyncedAt` only if it wrote a day. The card's other
branch already had the honest sentence for everything else — *"Import is on;
waiting for the first completed sync."*

**What a "simplification" would cost**: stamping on an attempt is one character
shorter and turns the field back into "the shell is running", which the card
already conveys by existing. The over-correction costs as much — a field that
is never stamped is as uninformative as one that always is — so the checks run
in both directions.

**The gap left open, deliberately**: `lastError` is still only rewritten by a
pass with a written or errored day, so a pass with no days at all cannot clear
a refusal that has since been fixed. It is not closed here because it is not
reachable from this suite's fixtures — a refused day holds the cursor back, so
the next pass always has that day to retry — and shipping the branch anyway
would have been a guard nobody has checked.

**The tests that fail if this is reversed**: `A PASS WHERE EVERY WRITE WAS
REFUSED NEVER CLAIMS A SYNC` and `...and having filed nothing, the baseline
pass does not claim a sync either` in
`apps/desktop/test/imessageService.test.mjs`, plus `...and a pass that threw
claims no sync either` for the catch-all — which had the same defect and was
found only by reading the diff back — with the two positive checks beside them
catching the over-correction. Sabotage counts are in that file's
header.
