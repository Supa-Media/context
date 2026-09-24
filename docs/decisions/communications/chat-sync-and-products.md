# Communications — chat sync and products

### Chat sync is built against an injected client, and now attaches to the one shared row

The account that authorizes Chat calls — one OAuth grant per Google account,
sealed refresh token, per-product scopes, sync cursors — is the control
plane's, and it is one shared row across Gmail, Calendar and Chat, never
three parallel connection tables (`docs/decisions/storage-and-credentials.md`
already argues why credentials get one seal and one owner, not three). The
Chat sync module in `apps/mcp` is written *against that shape* without
importing it: every function that needs a token, a cursor, or a per-space
setting takes it as a parameter or an injected `{listSpaces, listMessages}`
client, so the whole transform-and-render path is tested end to end on
fixtures, independent of how the control plane happens to store the
credential that will eventually be handed to it.

**A scheduled Chat pass stamps each regenerated day from the newest message
in that day, never from the pass clock.** The fixture suite originally proved
idempotence by running the same pass twice with the same injected `now`, which
did not prove what a scheduler needs: the next pass runs five or fifteen
minutes later. Passing that later wall clock into `updated` made an unchanged
day byte-different and would have rewritten it on every poll. A day containing
messages now uses its latest `sentAt`, matching Gmail's forward loop; an
unavailable-only notice uses that day's midnight. The regression runs the same
provider state at two different pass times and requires byte-identical output.

**Neither Chat page walk trusts the provider to converge.** Both `spaces.list`
and each space's `messages.list` remember every continuation
token they have followed and stop with the fixed `PAGINATION_STALLED` code if
one repeats; a thousand-page ceiling covers a provider that returns fresh junk
forever. A stalled spaces walk fails the account pass for normal scheduler
backoff. A stalled messages walk fails only that space, leaves its cursor
untouched, and lets the other spaces finish. The fixture deliberately repeats
one token and throws if a third request is made, so an unbounded loop fails
quickly instead of hanging the suite.

**A contact's key is chosen by whoever wrote to the owner, so the note already
there is not necessarily ours.** `contactPathForDraft` derives the key from an
identifier a *sender* supplied, and the scheduled Gmail pass writes to it —
`0-inbox/contacts/email-<them>.md` exists because they emailed. `parseContactView`
reads anything without complaining, by design, so merging straight into whatever
is at that key turned "merge into the page that is there" into "replace whatever
is there": a note the owner keeps by hand in that folder was rewritten as a
generated contact page, and an **encrypted** note was replaced with plaintext —
stripping the owner's lock and taking the ciphertext under it with the write,
which is exactly the "it would look like a successful write" `sealNoteContent`
refuses in the gateway. So `isContactNote` reads the frontmatter `type` the
renderer always emits, `mergeContactNote` answers `null` for anything else, and
every caller already treats `null` as *leave the key alone*. The checks are
`a hand-written note at a contact's key is left alone, not replaced by a
generated page` and `an owner's note with frontmatter of its own is not mistaken
for a contact page` — the second because a guard that only asked "does this open
with `---`" would pass the first. `CONTACT_TYPE` is now a named constant the
reader and the renderer share, so the two cannot drift.

**A Chat pass now exposes a JSON-safe account contribution before anything
writes the shared day.** `syncGoogleChat` still returns its legacy single-account
notes for callers that already use them, but also returns the exact day slices
the live runner must persist per account. `renderSharedGoogleChat` takes all
active contributions, groups them by configured destination, and renders one
shared day from their union with a workspace-level nonce seed. Account polling
order cannot change the bytes; updating one contribution cannot erase another;
destinations never bleed together; and two copies of the same normalized
account at one destination fail closed.

**Those account contributions now have a customer-storage commit boundary.**
Each connection owns a hash-addressed manifest and bounded day objects under
`.context/communications/google-chat/contributions/`; message content still
never enters Convex. A pass writes day objects first and conditionally commits
the manifest last. The shared runner must load every active connection's
manifest and every referenced day before rendering anything, and a missing,
corrupt, duplicated, re-bound, or concurrently changed contribution aborts the
join rather than letting the last account erase a sibling. The manifest keeps
the newest 366 days and removes older plumbing only after its replacement is
committed. A store whose connection probe found that it cannot enforce
conditional writes is refused rather than given a false concurrency
guarantee.

**The account-level forward loop now runs that Chat boundary** (2026-09-12).
The same five-minute sweep that drives Gmail selects the least-recently-synced
product on the shared Google row, opens the customer's store through the one
credential barrier, persists this account's contribution, loads every current
and disconnected contributor, writes the shared day and organic Contacts, and
only then advances the per-space cursors. A missing sibling contribution is a
quiet warm-up skip rather than an outage; its cursor stays put until the sibling
has completed a pass. Chat-bearing account rows are serialized per workspace
so two account passes cannot race a stale aggregate over a newer one. Gmail-only
rows retain the sweep's bounded parallelism because their destination folders
are per-account and never overlap.

**Two rules that join has to keep, because the first draft of it kept
neither.** A *destination* is the folder a key lands in, not the string a
settings field holds, so contributions are grouped by
`channelDestinationFolder`'s answer — the same function `channelDayNotePath`
resolves the path with. Grouping on the raw string made
`0-inbox/google-chat` and `0-inbox/google-chat/` two destinations that then
rendered the same path twice, one note per account, and whichever the runner
persisted last erased the other: the exact erasure the join exists to prevent,
reachable by a trailing slash. And the *notice order* inside a day is
codepoint order, never `localeCompare`, for the reason `chronological` in
`packages/communications/src/note.js` already states — a comparator decides
which bytes land in the note, so a default-locale collation makes the day a
property of the machine that rendered it. A collation additionally treats
U+0000 as ignorable, which quietly voided the NUL joining a notice's label to
its reason and let two different notices compare equal, leaving their order to
whichever account was polled first — byte churn on a shared note, every pass,
which is what "Keep scheduled Chat notes byte-stable" was merged to end. The
checks are `two spellings of one destination folder are one destination, not
two notes at one path` and `notices whose label and reason run together under a
collation still order the same either way`.

**On the control-plane side, `functions/chatProduct.ts` attaches Chat to the
same `googleConnections` row Gmail already writes** (2026-09-07) — no second
table. A first draft of this file built exactly that: `chatConnections` and
`chatConnectAttempts`, a full parallel copy of `googleConnect.ts`'s PKCE
shape, on the reasoning that Chat's connect flow could not wait for the
shared-row generalization Gmail's own review was still arguing out. Once that
generalization landed — the schema already stating `products`, one token pair
at the row's top level, one nested settings object per enabled product — the
duplicate tables were dropped rather than migrated (nothing had synced through
them yet) and `chatProduct.ts` was rewritten as thin sibling of
`googleConnect.ts`: it reuses `disconnectGoogleConnection`,
`revokeGoogleGrant`, `mintGoogleAccessToken` and the rotation walk verbatim
(all already product-agnostic, operating only on the row's top-level token
fields), and adds only what Chat actually needs beyond Gmail's own connect
flow — `startChatConnect`/`completeChatConnect` requesting Chat's scopes,
`applyChatConnectionBinding` writing the nested `chat` object
(`spaceSettings`, `cursors`, `nonceSeed`), and the two mutations a console
needs afterward, `setChatSpaceState` and `recordChatCursors`, which have no
Gmail or Calendar analogue because neither product has a per-item sync policy
the way Chat's per-space include/exclude/pause is. Building a second,
competing connection table to unblock testing sooner was the wrong call even
temporarily — two tables that both claim to own "the Google account's grant"
is the exact drift the shared-row decision exists to prevent — and the
correction is recorded here rather than only in the diff that made it, so a
future reader who finds an old branch or a stale comment referencing
`chatConnections` knows it was superseded, not merely renamed.

### Adding a product must not silently drop another one

The gap named above ("The second half is not closed here") when the shared
`googleConnections` row was first generalized: Google's OAuth grants exactly
what one authorization request asks for, so an "add Chat" request naming only
Chat's scopes, sent to an account that already has Gmail connected, gets back
a refresh token that no longer covers Gmail — and the row's own rule that a
product's scope slice is *recomputed* from the verbatim grant on every
connect, never carried forward (the previous section), means that narrower
token then correctly, and disastrously, reports Gmail as having no scopes at
all. Closed by Chat's own reconciliation (2026-09-07), two mechanisms
together rather than either alone:

1. **`googleAuthorizeUrl` always sets `include_granted_scopes=true`.** This is
   Google's own mechanism for incremental authorization: the token a call gets
   back carries every scope this OAuth client already held for the
   account, unioned with whatever this request newly adds — regardless of
   which existing connection, if any, the caller knew about when it built the
   request. That "regardless" is what makes it the mechanism of record: an
   ordinary connect screen does not know in advance which Google account the
   person is about to pick in the browser, so it cannot always supply a
   `connectionId` to union against.
2. **`startChatConnect` additionally accepts an optional `connectionId`** and,
   given one, folds that connection's own `products` into the scope request
   before asking Google for anything — belt and suspenders for the one case
   where the caller genuinely does know in advance which account it is
   extending (a console screen showing "person@example.invalid (Gmail) — Add
   Chat" next to a specific row), so the request itself already asks for the
   union rather than relying solely on Google's behavior.

`googleOAuth.test.ts` pins the first mechanism directly on the authorize-URL
builder; `chatProduct.test.ts` pins the second at the call site, and proves
the consequence at the row level twice — once showing that a grant built the
way `include_granted_scopes=true` would produce (both products' scopes
together) leaves Gmail's recorded scopes intact, and once, named as a
sabotage case in the test itself, showing the grant Google would have
returned *without* either fix — Chat's scopes alone — correctly and visibly
empties `gmail.scopes`. The second test exists so a regression that
reintroduces the bug is a known, named test going red, not a support ticket
about mail sync stopping for no visible reason.

Two things review found on top of that pair, both of which are the *same*
question asked one step further out — "what does the row do when the grant it
was handed is not the grant it asked for?" — and neither of which either
mechanism above answers on its own.

**A grant narrower than the row's own products is reported, not merely
recorded.** Both fixes can be in place and Google can still hand back less
than was asked for: the person unticks a product on the consent screen, or a
Workspace admin policy refuses a restricted scope outright. The row is then
exactly as honest as it was designed to be — `gmail.scopes: []` beside a
`products` still listing `gmail` — and until this, **nothing anywhere read
that empty slice.** `applyChatConnectionBinding` went on to write
`health: "backfilling"`, `mintGoogleAccessToken` mints from the refresh token
without consulting a product's scopes at all, and the first thing that would
have noticed was a 403 from Google inside a Gmail sync that is not built yet.
So the binding now compares the recomputed slice of **every product on the
live row** against the grant it just wrote, and a product left with no scopes
puts the row into `health: "reconnect_required"` with
`errorCode: "SCOPES_INCOMPLETE"` and a message naming the products, built from
this file's own literals and never from a provider string. The recomputation
rule is unchanged and the record is as honest as before; what changed is that
somebody is told. The check is `adding chat with a grant that dropped gmail
marks the row reconnect_required`.

**A disconnect is not undone by adding a different product.** `products` is
deliberately left behind by `disconnectGoogleConnection` as a record of what
the connection *used to* sync (above, "Disconnecting ends every product"), and
that record is a trap for anything that reads it as intent. Unfixed, a console
offering "Add Chat" against a disconnected row folds `["gmail"]` into the
scope request — so the person who explicitly ended our access to their mail is
shown a Google consent screen asking for `gmail.readonly` again, and the row
comes back with Gmail enabled, **because they added Chat**. That is a
restricted scope being re-requested on the strength of a revocation, which is
the wrong direction for a revocation to point. Two halves, matching the two
above: `productsForConnection` contributes nothing for a connection whose
`disconnectedAt` is set, so the *request* never asks; and
`applyChatConnectionBinding`, reviving a disconnected row, enables the product
being connected and no other, so the *row* never re-lists one. What survives
is each product's settings object — a `gmail.mailboxSlug` is a folder
somebody's mail is already sitting in, and renaming it later is a migration
nobody asked for — so a deliberate Gmail reconnect afterwards lands exactly
where it did before. The checks are `a disconnected connection's products are
never folded into a new scope request` and `reviving a disconnected row for
chat enables chat alone`.

**The mirror of that second rule, on Gmail's own binding, is now built** — by
the Calendar review, the change that next touched that function, exactly as
this paragraph predicted. `applyGmailConnectionBinding` revived a disconnected
row the same way, so reconnecting Gmail on an account that used to sync Chat
or Calendar put that product back on `products` with an empty scope slice: the
lighter half of the same bug (Gmail's connect flow requests only `["gmail"]`,
so nothing re-requested a restricted scope; what it produced was a dead
product entry rather than a revived consent) and now closed with the same two
lines. **All three bindings state the rule identically**, which is the point:
a console reading a connection should not have to know which product's flow
last wrote it. The checks are `reconnecting GMAIL on a disconnected account
does not revive Calendar or Chat`, `a Calendar connect on a disconnected
account never re-requests the mail scope`, and `binding Calendar onto it
revives Calendar and nothing else`.

**And the starved-scope report is on all three too.** Chat's binding marks a
connection `reconnect_required` / `SCOPES_INCOMPLETE` when the grant just
written does not cover every product still on the live set; Calendar's and
Gmail's now do the same, spelled the same way and reaching the same error
code, because the failure is a property of the row rather than of whichever
flow noticed it. Gmail's own case is real and was open: a Gmail reconnect
whose consent screen has Calendar unchecked leaves `calendar.scopes: []`
beside a live `calendar` product, and before this the row went on reporting
`backfilling`. The check is `a Gmail reconnect whose grant drops Calendar's
scope while Calendar is still live says so`.

**And `nonceSeed` is stored in the clear, deliberately, which is not what the
sync module's comment claimed.** `sync.js` described the seed as "sealed
alongside the connection's refresh token"; it is not, and the schema says so
in the opposite direction. The seed is not a credential — it opens no account
and reaches no message, and `defangFence` strips the fence marker out of every
sender-written body regardless, so the fence survives a seed a sender somehow
learned. What the seed buys is that the nonce is not derivable from the
account handle and the date, both of which a sender can simply guess. The
comment is corrected rather than the storage, and the paragraph to reverse if
the seed ever becomes the only thing between a sender and a closed fence is
that one.

**A space key is bounded before it becomes a field name.**
`setChatSpaceState`'s `spaceKey` is written as a key inside a `v.record`, which
makes a caller-chosen string into a field name on a stored document: unbounded
length is a row an owner can grow toward the document size limit one call at a
time, a `$`-prefixed key or one carrying a control character is refused by
Convex's own validation as an unhandled write failure with no error code, and
`_` is the prefix Convex reserves for its own system fields — which the
in-memory store the suite runs against does **not** enforce, so it is checked
in our code rather than left to production to catch. Only the owner of the
connection can reach any of it, which is why this is a bound and not an alarm.
It is deliberately a bound rather than Chat's resource-name grammar: pinning
`spaces/[A-Za-z0-9_-]+` would be this repository asserting a format Google owns
and can extend, and what that buys is a space somebody can see in their console
and cannot exclude.

### The five open decisions, and who settles them

The scoping note lists five. Three are recommended and taken here; **two are
the owner's** and are marked as such — they are product judgements about
somebody's money and somebody's mail, not engineering choices.

1. **Split threshold** — *recommended and taken*: 512 KB of rendered UTF-8, a
   greedy chronological fill, `-part-N` from 2. Argued above.
2. **Is the Inbox landing page virtual or a written note?** — *recommended and
   taken*: **virtual**. A written daily rollup is a second canonical copy of
   content that already exists, doubles the note count (the storage estimate
   says so explicitly), and goes stale the moment a day is regenerated. The
   aggregation is a gateway listing built from paths, exactly like
   `list_meetings` — no index, no second list to drift.
3. **Default Gmail backfill window and included folders** — **the owner's
   call.** Recommendation: **90 days, Inbox and Sent, excluding Spam and
   Trash**, with the estimator showing the note count and byte range for 90
   days / 1 year / all mail before anything is fetched. The reasoning is that
   the first backfill is the first thing a person waits for and the first bill
   they see; 90 days is enough for the product to feel populated and small
   enough to finish. All-mail should be a deliberate second action, not a
   default somebody accepts.
4. **Raw MIME and attachment retention defaults** — **the owner's call, and
   partly taken (2026-09-07).** Raw MIME stays off, per-connection opt-in and
   quota-bound, as argued above — this half is unchanged and still carries
   the legal dimension named here: a full mail mirror in a bucket changes
   what a subpoena reaches, and it is not ours to default on. **Attachments
   reversed**: the working default is now `store`, not `metadata-only` —
   see "Retention" above for the fetch-and-retain mechanism this shipped
   with — with a 90-day retention window, itself overridable per connection
   down to `metadata-only` or up to `"forever"`. This piece carries no legal
   dimension the metadata-only answer did not already carry equally, so it
   is recorded as taken rather than left pending; the backfill window in
   item 3 above is the one still awaiting the owner's explicit confirmation.
5. **Do user-created contacts override later Google People changes?** —
   *recommended and taken*: **yes, the person's edit wins, and the conflict is
   shown rather than resolved.** A field the person typed is never overwritten
   by a later import; the import adds what is missing and records a
   "People says X" line next to a field where they disagree. Silently
   overwriting a preferred name because a directory somebody else administers
   changed is the failure that makes people stop trusting the page.
