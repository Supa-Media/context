# Communications — Google push

### Push makes a pass due sooner; the loop still does everything

Built 2026-10-15 at the owner's request ("make it use webhooks to get any new
changes"), for all three products: Gmail, Chat and Calendar. It is the
*accelerator* [the forward sync loop](./gmail-and-sync-loop.md#the-forward-sync-loop-a-pull-on-a-floor-of-five-minutes)
promised, and it keeps that section's terms: a notification pokes the same
pass, it is never a second path into the bucket, and polling stays underneath
it unchanged.

**How each product is told.**

- **Gmail**: `users.watch` on the mailbox's own folders (`INBOX`, `SENT`),
  publishing to one Cloud Pub/Sub topic in our Google Cloud project. Google
  asks for the watch to be renewed daily; calling `watch` again extends it.
- **Chat**: one Workspace Events subscription per account, on
  `//chat.googleapis.com/spaces/-` (every space the person is in, user
  authorized) for `google.workspace.chat.message.v1.created`, without
  resource data, so it lives seven days. It publishes to the same topic.
  Google sends lifecycle events before it expires or when it is suspended;
  those force a renewal on the next Chat pass.
- **Calendar**: an `events.watch` channel on the primary calendar, posting
  straight to `/google/push/calendar` on this deployment. It needs nothing in
  Google Cloud, so it is on wherever the deployment has an HTTPS site URL.

No new OAuth scope. `gmail.readonly`, `chat.messages.readonly` and
`calendar.events.readonly` already cover watching what they read, which
matters while Google's verification of those scopes is in progress.

**What a notification may do: mark one product pending, nothing else.** It is
not read for mail and nothing in it is written anywhere. `pokeFromPubsub` and
`acceptCalendarNotification` find the connection by the name the pass
registered (a lowercased mailbox address, a subscription name, a channel id),
set `push.pending[product]`, and bring `nextSyncAt` forward to no sooner than
30 seconds after the last pass (`PUSH_MIN_GAP_MS`), so a burst of mail is one
pass. The ordinary sweep claims it behind every gate it already has; the job
runs the pushed product first; the pass clears a mark only if it arrived
before the pass was claimed, so a message landing mid-pass gets its own pass.
A failing connection keeps its backoff, and a disconnected or
reconnect-required one is never poked.

**Each door has a key that is not a shared secret we hand out.**

- `/google/push/pubsub` (`pubsubPushRoute`) accepts only an RS256 OIDC token
  Google signed, for exactly this endpoint's audience, naming exactly our
  push service account with a verified email. Anybody can get Google to sign
  *a* token; only our subscription's names our account. The algorithm is
  pinned, never read from the token.
- `/google/push/calendar` (`calendarChannelRoute`) accepts only a channel id
  we opened with the 32-byte random token we gave Google for it. The row
  stores the token's SHA-256, never the token, so a database read cannot forge
  a notification. A wrong token and an unknown channel are one refusal.

Both factories are enumerated in `__tests__/structure/httpRoutes.test.ts`, and
`__tests__/googlePush/` proves the refusals, the tenant isolation and the loop
behaviour; remove a check and the test naming it fails.

**Registration rides the pass.** After a product syncs, `ensureGooglePush`
registers or renews that product's watch with the access token the pass
already holds. Every healthy connection is synced at least daily, so this
needs no scheduler of its own, and nothing is ever registered for an account
the pass's gates refused. Gmail re-watches when under six days remain
(daily); a Calendar channel or Chat subscription is renewed with two days
left. A failed registration is written on the row and retried after an hour;
it is never the pass's failure, because push is latency and polling is the
guarantee. A renewed Calendar channel is recorded before the old one is
stopped, so there is no moment with no channel we accept. Disconnecting
clears the row's push state at once, and revoking the grant ends Google's
side.

**Configuration.** `GOOGLE_PUSH_TOPIC` (`projects/<project>/topics/<topic>`)
and `GOOGLE_PUSH_SERVICE_ACCOUNT` turn on Gmail and Chat; both or neither.
`GOOGLE_PUSH_AUDIENCE` overrides the token audience, which defaults to the
push URL. `GOOGLE_PUSH=off` stops registering anything. All four sync from
the vault like any other deploy setting. A self-hosted
deployment with none of these polls exactly as before.

**The one-time Google Cloud setup** for a deployment's project: enable the
Cloud Pub/Sub and Google Workspace Events APIs; create the topic; grant
Pub/Sub Publisher on it to `gmail-api-push@system.gserviceaccount.com` and
`chat-api-push@system.gserviceaccount.com`; create a service account with no
roles; create a push subscription to `<site URL>/google/push/pubsub` with
authentication as that account and the default audience.

**What is not proved.** As with the loop itself, nothing here has yet talked
to the real Google: it is built from Google's documentation and exercised
against fixtures. In particular the `spaces/-` Chat target, Calendar's
delivery to a `.convex.site` address without domain verification, and the
exact shape of Workspace Events' lifecycle attributes should be checked
against the first real account, and this section corrected rather than
worked around.

### A workspace's passes run back to back, and a pushed one goes first

Found on 2026-10-19: with push working, a person's new mail still took up to
an hour to land. The sweep runs one pass per workspace at a time (the
shared-writer lock that keeps two accounts' Chat and Calendar days from
racing), one product per pass, and only the five-minute cron started the next
one. A person with three accounts, each with Gmail, Calendar and Chat, had
nine product turns sharing one pass every five minutes. A notification's sweep
30 seconds later usually found the lock held and did nothing, and the next
cron tick served whichever row the index offered first, which was a routine
poll rather than the account Google had just told us about.

So (`apps/convex/functions/lib/googleSync/drain.ts`):

- **When a pass reports, its workspace's next due pass starts at once.**
  `recordGoogleForwardSyncPass` queues a sweep if any row in that workspace is
  due by the sweep's own tests: not claimed, `nextSyncAt` reached, and
  `isDue`. The chain ends when nothing is due. A row that is only draining a
  backlog (`syncCatchUp`) does not count, so a long catch-up keeps the cron's
  pace and Gmail's quota is not spent pass after pass.
- **The sweep serves pushed connections first.** A row with a pending mark on
  a product that is not backing off goes ahead of rows that are due only by
  the interval.
- **A day Google stops part-way resumes where it stopped.** When a fetch
  throws in the middle of a day (a rate limit), the messages already fetched
  are written to the day's cache before the error goes up. Without this, a day
  with more messages than one burst of quota would fail at the same message
  on every retry and never land.

What a simplification costs: dropping the queue puts the workspace back on one
pass per five minutes; dropping the ordering makes a push wait behind every
due poll in its workspace. Tests:
`apps/convex/__tests__/googleSyncLoop/workspaceDrain.test.ts`,
`apps/mcp/test/gmailSync/messageCache.test.mjs`.
