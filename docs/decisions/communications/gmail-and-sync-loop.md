# Communications — Gmail and the sync loop

### The Gmail connection: control plane, sync algorithm, and what phase 1 actually wires up

Built 2026-09-07, behind `MAIL_CONNECT_ENABLED` (unset means disabled, on every
deployment including this project's own, until Google's verification lands —
see the section above). The pieces:

**`googleConnections`, keyed by `workspaceId`, never `userId`** — same rule
as `storageBindings`, same reason. `functions/googleConnect.ts` mirrors
`dropboxConnect.ts`'s PKCE-attempt-then-scheduled-exchange shape exactly,
including the security argument for why the callback needs no session: the
workspace and the actor come from the parked attempt, never from the caller,
so an interceptor of the callback URL can complete or burn the victim's own
connect and nothing else. Only a `kind: "personal"` workspace's owner may
start one — checked in one query, `requirePersonalOwner`, so a shared context
can never be told apart from "not the owner" by which error code comes back.

**One Google account is one row, one OAuth grant, and a `products` set —
generalized the same day it was built**, before Gmail was even the only
consumer of it. The owner's ask: Calendar and Chat sync land on this same
account connection, not a second one, because a person connecting their
Google account once should not re-consent per product. So the row carries
the account identity and the one refresh/access token pair at the top level
— **never nested under a product**, because it is one grant covering
whichever products are enabled, and nesting it would either duplicate one
secret three ways or make the rotation walk hunt through per-product objects
for a column that is the same secret in each — plus a `products: ("gmail" |
"calendar" | "chat")[]` array and one nested settings-and-cursor object per
enabled product (`gmail`, `calendar`, `chat` on the row). Only `gmail` is
populated by anything that runs today; `calendar` and `chat` are declared,
not built, the same "decided here, built next" phasing `docs/decisions/search.md`
already uses for its own index — a sibling agent building Calendar or Chat
sync extends this row rather than inventing a second table, and
`lib/googleOAuth.ts`'s `scopesForProducts` / `grantedScopesFor` already
generalize the scope handling both would need.

**A product's `scopes` is a view of the account's one grant, recomputed on
every connect, never carried forward — and adding a product later is a
UNION, which is the one thing that shape does not do for free.** Two halves,
found by adversarial review before Calendar or Chat existed to trip over
them. The first is now closed: a Gmail-only reconnect replaces the row's
top-level `scopes` with whatever Google granted this time, and it recomputes
every present product's slice from that same list rather than copying the
old `calendar.scopes` across — otherwise the row asserts a Calendar consent
out of a grant that may no longer carry one, and a health screen reports a
product as connected on the strength of a record of a consent that has been
replaced. The settings and the cursor on each product object are its own and
survive; only the scopes are derived. The check is `a reconnect recomputes
every product's scope slice from the one verbatim grant`.

The second half is closed twice over, once by each sibling that actually adds
a product to an existing row: Chat's reconciliation (2026-09-07) — see
"Adding a product must not silently drop another one" below for the two-part
fix — and Calendar's own connect flow, which requests the **union** of every
product on the one unambiguous existing `googleConnections` row for the
workspace plus Calendar, not Calendar alone, when exactly one such row exists.
("Exactly one" matters: two Google accounts on one workspace is a real,
supported shape, and a Calendar connect does not guess which one a person
means to extend — `include_granted_scopes` is what still protects that
ambiguous case, at Google's end. Chat's flow takes a `connectionId` from a
console screen that does know, which is the same fix reached from the other
direction.) Proven and sabotaged in `calendarConnect.test.ts` and
`googleOAuth.test.ts`: dropping the request-side union fails 2 Calendar-connect
tests; removing `include_granted_scopes` fails 2 tests spread across both
files; reverting `applyCalendarConnectionBinding`'s Gmail-slice recompute back
to a bare carry-forward (the same "two views of one fact" rule as the reconnect
paragraph above, now proved in the Calendar-onto-Gmail direction too) fails 3 —
each sabotage isolated to exactly the tests naming it, with every other test in
the affected files staying green.

**Disconnecting ends every product on the account, because it is one
grant.** There is no "disconnect just Gmail while keeping Calendar" — Google's
revoke endpoint takes one token and ends the whole authorization, so
`disconnectGoogleConnection` revokes it once and the row's `products` array
is left as a record of what the connection used to sync rather than cleared,
matching how `disconnectedAt` already treats the row as a whole.

**`chat.messages.readonly` is a RESTRICTED scope, confirmed against Google's
own restricted-scopes list — the same class as `gmail.readonly`, not merely
assumed to be lighter because it is not mail.** This means the CASA security
assessment gating Gmail gates Chat too, the moment Chat sync ships; there is
no "Chat is only sensitive" shortcut available. `chat.spaces.readonly` — needed
alongside it to list which spaces and DMs exist before reading them — is
sensitive rather than restricted, a lighter verification bar but not zero.
Both are declared as `CHAT_SCOPES` in `lib/googleOAuth.ts` now, verified
rather than guessed, so whoever builds Chat sync inherits the correct
classification instead of re-deriving it.

**The rotation walk gained a fourth table**, and the miss it closes is written
down because it already happened once: `workspaceDataKeys.encryptedDataKey`
was invisible to `rekeyStorageBindings` for exactly the reason a Google token
would have been if this were skipped — a credential in a table the pass never
queries is not accounted for by getting its column name onto
`ROTATED_ENVELOPE_COLUMNS`, because that list proves a *name* is spoken for,
not that a *table* is visited. `listGoogleConnectionRekeyCandidates` /
`applyGoogleConnectionRekey` are their own query and mutation, wired into
`rekeyStorageBindings` the same way `workspaceDataKeys` is, and
`storage.test.ts` runs the same end-to-end rotation proof — write under key
1, rotate, re-seal, drop key 1 from the environment entirely, still opens —
that the binding and the data-key halves already had. Keeping the token at
the row's top level rather than nested under `gmail` is what keeps this
rotation code untouched by Calendar or Chat landing on the same row later:
there is still exactly one envelope pair to rekey per connection, regardless
of how many products it lists. A disconnected connection's empty-string
refresh token is deliberately never a rekey candidate: there is nothing
there to re-seal, and counting it would only ever be `unreadable` noise on
every future rotation for a credential that is intentionally gone.

**The backfill window is a closed set — 90 days, 1 year, or all mail** —
`36_500` days is the "all mail" sentinel, chosen so the field stays a plain
number rather than growing a second representation for "no bound", and
bounded generously enough that a corrupted value cannot mean "forever"
literally. The owner's defaults from the scoping note — 90 days, Inbox and
Sent, Spam and Trash excluded, raw MIME off — are live as the defaults now,
not merely recommended: `MAIL_FOLDERS` is a two-value union at the type
level, so a caller cannot ask for Spam or Trash even by trying, and
`buildDayQuery` in `apps/mcp/src/communications/gmailSync.js` writes
`-in:spam -in:trash` into every query regardless, so the exclusion is
asserted twice rather than left as something the folder list merely does not
mention. Attachments are the one default that has since moved from
"recommended" to "taken" — see "Retention" above — with a default retention
of 90 days, itself overridable per connection. **The backfill window and
folder set are still pending the owner's explicit confirmation** — see the
`SEYI:` list left in `1-projects/context-lc-personal-communications-inbox/overview.md`
in Context.LC — and reversing any of them is a one-line change in
`googleConnect.ts`'s `ALLOWED_BACKFILL_DAYS` / `MAIL_FOLDERS`, not a schema
migration.

**The estimator is `min(messageCount, windowDays)`**, in
`packages/communications/src/estimate.js`. The only two numbers a connect
screen can have before fetching a single message are a count (Gmail's
`messages.list` `resultSizeEstimate` for a date-bounded query) and the window
length in days, and a channel-day note needs at least one message — so the
tightest true bound on "how many notes" without walking per-message dates is
the smaller of the two. It is reported as a bound, not dressed up as a point
estimate: a mailbox that gets one message a day for 90 days and one that gets
90 messages on a single day produce the same count and the same honest
answer, "at most 90." The byte range multiplies the count by the 15–40KB
per-message range this file already measured for the split threshold — a
range, because the true answer depends on how heavy this particular
mailbox's mail is, which nothing knows before fetching it.

**The sync algorithm regenerates one calendar day at a time, always from a
live, complete query for that day — never from a page.** A channel-day note
is `planChannelDay`'s pure function of a day's *complete* event list, and
Gmail's `messages.list` pages are not day-aligned; grouping by page and
writing whatever a page happens to hold would sometimes assemble a day from a
partial set, which is silently correct until the day it is not. So
`apps/mcp/src/communications/gmailSync.js`'s unit of work is `syncDayFromGmail`:
list every message Gmail has for that date (scoped to the connection's
folders, Spam and Trash always excluded), fetch each in full, render, write.
Backfill calls it once per day in the window; incremental sync calls
`history.list` only to learn *which* days changed and then calls it for
those days — in both cases the day itself is always rebuilt from Gmail's
current state, which is what makes rerunning any page **idempotent by
construction** rather than by deduplication logic that has to be kept
correct separately.

A gap — `history.list` answering 404 because `startHistoryId` expired — comes
back as a typed `gapDetected: true` rather than a thrown error, and the
documented recovery is calling `runBackfill` over the connection's window
again: since a day is always rebuilt from live state, redoing the whole
window is a correct reconcile, not merely a plausible-looking one.

**And a 404 is a gap only from `history.list`.** The first implementation
promoted *every* 404 the Gmail client saw into `GmailHistoryExpiredError`,
in the one shared `fetch` wrapper. That is wrong in the most ordinary case
there is: a message deleted between being listed and being fetched — the
owner archiving something mid-sync, a filter moving one to Trash — makes
`messages.get` answer 404, and the sync then either died or, for a caller
reacting to the type the way the class name tells it to, reran a 90-day
reconcile. Once per deletion. Forever. So the promotion now happens at
`listHistoryPage`'s own call site and nowhere else; a message Gmail no
longer has is skipped and the day is written from what Gmail still holds,
which is precisely what "the day is always the complete, current query
result" already meant, and an attachment Gmail no longer has leaves that one
attachment metadata-only rather than abandoning the note describing it. The
checks are `a message deleted between list and fetch does not abort the
day`, `a message history named and Gmail no longer has is not an expired
cursor`, and — so the narrowing cannot silently disable the real signal —
`an expired cursor is still the one 404 that means a gap`.

Deletions
are not reconciled: a message Gmail later deletes stays in the day it was
captured on, because v1 is a read-only mirror of what arrived and "a record
of what was received, not a statement by the owner" — named here as future
work rather than an oversight.

**`updated` in a synced day's frontmatter is the latest message's own
`sentAt`, not wall-clock time.** `renderChannelDayNote`'s own default
(`new Date().toISOString()`) is right for a note a person is editing right
now, and wrong for a value a scheduled job recomputes against the same
underlying mail: a wall-clock default would make every rerun of an untouched
day write a new timestamp forever, which is churn wearing the costume of
sync activity and defeats the entire point of writing conditionally on an
etag. Keying it to the newest event's timestamp instead is stable across any
number of reruns of the same mail and advances exactly when a new message
lands — the property `test/gmailSync.test.mjs`'s "re-running the same day
changes no bytes" check exists to hold.

**Quota is enforced per write, not per pass.** `syncOneDay` checks the
remaining budget before every part it is about to write and stops the moment
the next one would exceed it, so a quota that runs out mid-backfill leaves
whatever was written intact rather than discarding a partially-written day —
the day it stopped on is picked up again once the connection's usage has room,
by the next scheduled pass.

**What phase 1 did NOT wire up — closed 2026-09-10 by the forward sync loop
below, and left here rather than deleted because the gap it describes was real
and the shape of the fix is the argument.** `apps/mcp/src/communications/gmailSync.js`
takes its Gmail socket, its access token and its `ContextStore` as parameters
and is tested end to end against a fixture Gmail server and an in-memory store
— but for a while nothing called it at all: the historical backfill that used
to (#388) was removed, and the reference count went to zero without anybody
noticing, because a module nothing imports still passes its own tests. What was
missing was never a pipeline. It was a trigger.

The route it was assumed to need was not needed either. `mintGoogleAccessToken`
and the storage binding both already live in the control plane, and
`runFileOperation` is already the one function allowed to open a bucket
credential — so the loop runs *there*, exactly as the removed backfill did,
rather than as an internet-facing route the gateway calls with its own secret.
A second credential-bearing route is a real cost (`__tests__/structure.test.ts`,
`CREDENTIAL_HTTP_ROUTES`), and this needed none.

### The forward sync loop: a pull, on a floor of five minutes

**Nothing in this section has ever contacted Google.** Every operational claim
below — the cursor invariant, how long a `historyId` survives, what a rate
limit looks like, what `history.list` returns on page fifty — is read from
Google's documentation and exercised against a fixture, and the whole loop is
proved end to end against a fake Gmail and an in-memory bucket. That is enough
to hold the *shape* of the thing; it is not evidence about Google's actual
behaviour, and the first real mailbox may contradict a sentence here. Whoever
runs it against one should correct this section rather than work around it.

Built 2026-09-10 (`functions/googleSync.ts`, `crons.ts`), because a person
could connect Gmail, see a healthy-looking connection, and receive nothing,
forever. The grant was stored, the `historyId` baseline was recorded, and
**nothing advanced it**: no cron, no webhook, and the gateway's `scheduled()`
handler has no `[triggers]` block configured and reaches only the single-tenant
legacy path when it does fire.

**Why a pull, and not Google's push.** Gmail can push — `users.watch` posts
change notifications to a Cloud Pub/Sub topic, and Calendar has watch channels.
Both are rejected for now, and not because they are hard:

- A push path needs a Pub/Sub topic in **our** Google Cloud project, an
  internet-facing endpoint verified with Google, and per-mailbox
  re-registration every seven days (`users.watch` expires). That is a second
  externally-triggered ingress, a second thing to authenticate, and a second
  thing to rotate — against a control plane whose whole discipline is that
  exactly one HTTP route may reach a customer credential.
- It does not remove the poll. A watch that expires, a notification that is
  dropped, a topic whose subscription lapsed: each is only ever *noticed* by
  something that polls. Every mature push integration has a reconciliation
  loop underneath it, so the loop is the part that has to exist first.
- The notification carries no mail. It says "this mailbox changed"; the client
  still calls `history.list` and `messages.get`. Push buys latency, not work
  avoided — and latency is what the interval is for.

So: a pull now, and push later as an *accelerator* that pokes the same pass
rather than as a second path into the bucket. What that costs is honest and
worth stating: mail is late by up to one interval. It is never lost, because
every pass rebuilds each touched day from Gmail's live state.

**Why the floor is five minutes.** The cron ticks at five and the sweep starts
a pass only where `now >= lastSyncAt + interval`, so one fixed tick serves
every per-connection frequency; an interval below the tick could not be
honoured anyway. Five is also where the cost stops being negligible: every pass
mints or reuses an access token, calls `history.list`, and re-lists and
re-renders every day a changed message landed on — against Google's quota and
a Convex action budget, per connection. `apps/desktop/src/main/imessage.ts`,
the one sync loop in this codebase that has always worked, settled on the same
five minutes against a *local* SQLite file; this one crosses a network. The
floor is enforced in the mutation, not the picker: four minutes is refused from
a console, a script, and a client that has never seen the UI.

**Why the default is fifteen and not the floor.** Mail is not a chat. Three
passes an hour keeps a workspace within a quarter of an hour of the mailbox at a
third of the floor's cost, and somebody who wants the floor can choose it.

**What a person loses by choosing a longer interval**, in the order it starts
to matter:

1. **Freshness, linearly.** An hourly connection's workspace can be an hour behind.
   Nothing else changes: the same bytes are written, later.
2. **Nothing else, until a day.** A day's note is regenerated from the complete
   current query for that date, so a slow poll writes the same file a fast one
   would.
3. **At the far end, actual mail.** Google documents a `historyId` as usable
   for "typically at least a week", and adds "in rare circumstances only a few
   hours". The tail matters more than the typical case: it means **even a
   one-day interval can gap**, so the maximum is a bound on how *often* that
   happens rather than a promise it cannot. Under a forward-only policy an
   expired cursor cannot be recovered by a reconcile — there is no backfill to
   run — so the mail that arrived in the gap is never captured, which is why an
   expired cursor is written onto the row as a failure a person can read rather
   than silently re-baselined.

**Forward-only, and what a gap therefore means.** #388's decision stands: a
pass advances `historyId` from wherever it is, and a connection with no cursor
takes one from `users.getProfile` and starts *there* — the mail from before
that moment is not this loop's to collect. The recovery this file documented
for `gapDetected` ("call `runBackfill` over the connection's window again") no
longer exists, so the gap is re-baselined forward and recorded as
`GOOGLE_SYNC_GAP` on the connection, alongside a healthy `active` state,
because both are true.

**The cursor never advances past mail that was not written.** A quota ceiling
reached mid-pass, or anything thrown, leaves `historyId` exactly where it was
and the next pass asks Gmail the same question again. Advancing it would be the
one defect in this design that loses somebody's mail with nothing to show for
it, so it has its own check.

**A history walk that runs out of pages resumes from the last record it read,
and stays due — it does not store the mailbox head.** This is the same failure
as the paragraph above wearing a much better disguise, and it was found in
adversarial review of the first implementation rather than by writing it
correctly. `history.list` returns the **mailbox's current** `historyId` on
*every* page, not a per-page cursor. So a bounded walk (fifty pages) that
stopped early and stored that value would report "caught up" while holding only
the first pages — and every change behind them would be skipped **forever**,
with no `gapDetected`, on a row reading `active`. It fires hardest on exactly
the case this loop exists for: the first pass against a connection whose
baseline is weeks old.

Three ways out were available, and the third is taken:

1. *Raise the page limit.* Moves the cliff without removing it, and makes one
   pass unboundedly long against a Convex action deadline.
2. *Leave the cursor where it is and re-run.* Safe, and it never finishes: the
   next pass re-reads the same first fifty pages and stops in the same place.
   Correct, and permanently stuck one page-limit from the front.
3. *Advance to the last history record actually walked.* A history record's own
   `id` is a valid `startHistoryId`, and it covers precisely the records this
   pass collected and regenerated. The cursor moves, nothing is skipped, and
   the next pass starts where this one stopped.

**That third option rests on one assumption, and it is the sentence in this
file most worth checking against a real mailbox first**: that Google accepts a
`History.id` where it accepts a `historyId`. Google's own documentation says
`startHistoryId` "should be obtained from the historyId of a message, thread,
or previous list response", and a history record's id is that same mailbox
sequence value — but nothing here has asked Google. If it is wrong, the symptom
is a 404 on the next pass, which this code already reads as an expired cursor
and handles as a gap: wrong in the safe direction, and visible on the row
rather than silent.

Which is why `listAllHistory` reports `truncated` and carries `lastRecordId`,
why `runIncrementalSync` hands back the record boundary rather than the head
when truncated, and why the pass then sets `syncCatchUp` on the row. That flag
makes the connection **due on the next tick regardless of its interval**: the
interval is how often to ask *whether anything changed*, and a connection
draining a backlog is not asking — it has already seen the edge of one. Each
pass makes real progress, so the loop terminates, and the flag is cleared by
the first pass that reaches the end. The console says "catching up on older
mail" rather than naming a next due time it does not mean.

There are two cases where that urgent flag must not survive. Gmail can return
many pages whose `history` arrays are empty after applying the requested
`messageAdded` filter; if the bounded walk sees a next page token but no
history-record id, it has no safe cursor to persist. That pass fails visibly
with `GOOGLE_SYNC_NO_RESUME_CURSOR` and honors the retry ladder instead of
re-reading the same fifty pages on every sweep. Likewise, any failed or
skipped catch-up pass clears `syncCatchUp`, so its recorded backoff or retry
time is authoritative. Both cases were found by comparing the merged loop
against its saved adversarial review, and both have end-to-end regression
checks.

**A failed pass counts the bytes it wrote, and a refused grant stays refused.**
Both were also review findings, and both are the same shape — a branch that
patched a row *nearly* correctly. Byte accounting that skipped the failure path
froze `bytesAlreadyUsed` below the ceiling on the one path that reaches it (the
quota stop, which writes whole days before stopping), leaving a quota that
could never be crossed and a day rewritten forever. And a failure that
overwrote `health: "reconnect_required"` with a plain `error` erased the state
the pass's own skip gate keys on, so a grant Google had revoked was offered
back to Google's token endpoint on every backoff, forever, while the console
never showed the one state the owner could act on.

**A failure backs off on a ladder, not a flat wait.** Fifteen minutes, doubling
to a six-hour ceiling, plus a spread derived from the connection's own id so a
deployment's connections do not all wake in the same minute when an outage
ends. Flat retries meant a `dailyLimitExceeded` — which by definition will not
clear today — was retried about ninety-six times before it could.

**Idempotence had to become true on the backends that cannot do a conditional
write.** `writeDayPart` used to `put` unconditionally when
`capabilities.conditionalWrite` was false, which made "re-syncing an unchanged
day writes nothing" a property of R2 and S3 rather than of this code — and on
B2 and Wasabi (which CLAUDE.md already names) a loop running every few minutes
would rewrite every touched day forever and re-count the bytes each time. It
now does the same read-compare there; what those backends still cannot give is
the *atomicity* that turns a race into a retry, and that remains the honest
degradation.

**The pass passes no `now`, which is not a detail.** `renderDay` keys a day's
`updated` to the newest message's own `sentAt` precisely so that re-rendering an
unchanged day is byte-identical — and `syncOneDay` forwards whatever `now` a
caller hands it straight through, overriding that. The removed backfill passed a
wall clock, which a one-shot import survives; a pass that runs every few minutes
would rewrite every touched day forever, which is churn wearing the costume of
sync activity. The check that holds it is "re-running the same pass writes no
new bytes".

**The fence nonce is the connection's own id, and that answers a question
`calendar-sync.js` left for exactly this work.** That file's comment names the
nonce as "a cross-cutting, not-yet-wired question for whoever builds the live
sync trigger for either channel": Calendar derives it from account and date,
both of which are printed in the note, so an inviter who knows which account
they wrote to and which day their invite landed on can compute it and forge a
fence marker. Gmail's is `gmail:<connectionId>` — the same value the removed
backfill used, kept so a day rewritten by either path keeps its message anchors
— and it does not have that weakness: a sender cannot derive a Convex row id
from anything they can see, and they never see the note. It is stable across
every pass by construction, which is the other property the fence needs.

It is not the strongest available shape, and the stronger one is already in the
schema next door: Chat's `nonceSeed`, a random value minted at connect time and
stored on the row (not a credential — leaking it weakens one connection's fence
and nothing else). Gmail has no such field, and adding one now would rename the
fence markers in every day already written. Calendar moved first: its live
runner hashes the internal contributor ids with the date. That value is stable
across account polling order and cannot be derived from the address printed in
the note. Gmail still needs a migration that reads and reuses the existing
note's nonce, then mints a random value only for a new day.

**The cron holds no decision**, which is the rule `crons.ts` opens with and the
one a job that *starts* work has to argue rather than assume. Whether a
connection may sync at all — still connected, personal context, a product this
engine can advance, a deployment permitted to read a restricted scope — is the
connection's own state, re-asked by `googleForwardSyncJob` inside the pass,
before a credential is opened. The sweep decides only when to look. It also
claims each row it starts (`syncStartedAt`) and skips anything claimed less than
fifteen minutes ago, so a pass still running is never overtaken — the same
heartbeat, and the same fifteen minutes, as `sweepStalledBackfills`.

**A pass that establishes a cursor is not a pass that synced mail**, and the
card has to be able to say so. Forward-only makes the two genuinely different:
a first baseline, and a re-baseline after a gap, both read *nothing* by design.
Counting them as a sync would have shown every freshly connected mailbox as
current before a single message had been read — the same confusion the card was
rewritten to end, arriving one state later. So `gmail.lastSyncedAt` moves only
when mail was actually read, `cursorReady` is what a baseline makes true, and
the console has three sentences where it used to have two: never synced,
watching with nothing read yet, and syncing.

**Every pass that writes leaves an audit row, and the actor is `boundBy`.**
This loop is the first writer in the codebase with nobody present, and
non-negotiable #4 says the audit records the acting identity rather than the
scope. The identity is the person who connected the account, on whose grant
every one of these writes is made; naming them is more honest than an empty
actor and is the name an owner needs. Only passes that wrote something are
recorded — a poll that found nothing is not an event, and 288 of those a day
per connection would bury the rows that matter — and the row carries counts
only: no address, no subject, no path.

**A connection that has never synced must not look like one syncing fine.**
That state is exactly what shipped, so the row now carries `lastSyncAt` (when a
pass last *finished*, successfully or not — making it mean "last success" would
leave a permanently failing connection due on every tick), `nextSyncAt`, and a
`lastSyncFailure*` triple that is **not** cleared by a later success, because
"did this break overnight?" is a different question from "is it broken now".
The console reads all of it.

**One account, one schedule — which is what makes Calendar and Chat cheap.**
The loop's unit is the `googleConnections` row, not a product: one claim, one
credential mint, one report, and `ENGINE_PRODUCTS` says which products a pass
walks. Adding Calendar means adding it to that list and giving it a pass beside
Gmail's in `functions/files.ts`; it needs no second cron, no second claim, and
no second set of status fields. What each of the two still needs before that is
true:

- **Calendar** has a sync module (`apps/mcp/src/communications/calendar-sync.js`)
  whose own comment names this same gap, and a `calendar.syncToken` cursor
  already declared on the row. What it lacks is an incremental entry point
  shaped like `runIncrementalSync` — one that takes a `syncToken`, returns the
  new one, and reports a `410 GONE` (Calendar's equivalent of an expired
  `historyId`) as a typed gap rather than an error. Its horizon also rolls on a
  clock rather than on a token, so a pass has a second job Gmail's does not:
  extending the window forward even when nothing changed.
- **Chat** pages `spaces.messages.list` by `create_time` **per space**, so its
  cursor is a map rather than a value. The engine does not care — the cursor
  lives on the product's own object — but `recordGoogleForwardSyncPass` writes
  `gmail` specifically today and would need the same per-product branch its
  reader has. Chat also needs one space's failure not to stall another's, which
  is a property of its pass rather than of this loop.

Neither is half-built here. Gmail is built properly and the two are named.
