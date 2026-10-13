# Communications — contacts and chat

### Contacts: one page per person, and a merge never rewrites history

`0-inbox/contacts/<letter>/<page>.md` (filed A–Z since 2026-10-12, below;
older pages sit flat and keep working), one stable note per canonical person or
organization, carrying identifiers (addresses, phone numbers, chat handles)
and an activity section of **links, never content**: dated wikilinks into
channel-day notes, grouped by year and month in the *body* of the page — which
is where a `YYYY/MM` grouping genuinely belongs, because there it is a heading
somebody reads and not a directory somebody has to walk.

**A contact page is a derived index that is allowed to be edited, and the two
halves are separated in the file.** Activity links are regenerated; the
identifiers, the preferred name, the organization and anything the person
typed are theirs and are never rewritten — the same rule as `## My notes` in a
meeting note, for the same reason.

**Automatic merging happens on exact identifier equality and nothing else.**
Two events sharing a normalized email address, phone number or provider user
id are the same contact. Everything weaker — same display name, same domain,
Google People saying so — produces a *suggestion* the person confirms, and the
page records why it was linked. Google People data is evidence, not truth: it
is a directory somebody else administers, and letting it silently merge two
contacts means a colleague's address change re-attributes a year of somebody's
correspondence. **A merge never rewrites a channel-day note** — the messages
are what happened, the contact page is a view of them — so an unmerge is
deleting and regenerating one file rather than unpicking a year of edits.

**Contacts grow organically from communication sync, not from a separate
address-book import.** The normalized events already read for iMessage, Gmail
and Google Chat yield the sender and recipients, their email/phone/provider
identifiers, and a link back to the message anchor in the channel-day note.
iMessage, Gmail and Chat materialize those drafts in the same durable pass that
writes the day; a failed contact write holds the provider cursor rather than
silently losing the relationship. The owner's own email and provider
identity are filtered at the connection boundary. No macOS Contacts permission,
Google People scope, or second provider crawl is part of this path.

The check is `a name-only match never merges two contacts`.

### And they are read through two tools, because a page nobody can find is a file

For a week after the pages landed there was no way to *ask* for one. A
connected client could read a contact page if it already knew the path, which
it only ever would by having been told; "who does this person correspond with"
had no answer at all, on a surface whose whole claim is that the answer is one
call away. `list_contacts` and `read_contact` are that pair, built the same way
`list_channel_days` and `read_channel_day` are — a listing from the folder
listing and then the notes, never an index, so a page the owner moved out stops
being listed and stays a note of theirs — and they carry the
[`context-contacts` plugin](../plugins.md)'s switch.

Three things they do that the channel-day pair does not have to, all from one
fact: **a contact's key is chosen by whoever sent the user a message.**

- **`isContactNote`, not a successful parse, decides whether a page is ours.**
  `parseContactView` is lenient by design; pointed at the owner's own note at a
  contact's key — or at ciphertext — it returns a person with an empty name.
  The listing labels such a note (`(a note of your own)`, `(encrypted)`) rather
  than hiding it, and the read hands it to `read_note`, which is the tool that
  can actually open the sealed one.
- **Both print the same provenance sentence, from one constant.** The name, the
  organization and the identifiers on a page are values off inbound mail. A
  model handed them with nothing said reports them as this context's own claim
  about a person — so the listing says it where somebody chooses who to read
  about, and the read says it where they choose what to believe.
- **The activity list is cut to five** unless `activity: true` asks for it, the
  same bargain `read_channel_day` strikes with message bodies: a
  three-year correspondence is a link per message, and a tool call should not
  spend a model's context on a list nobody asked for.

Ordering is the listing's own `uploaded`, so nothing is read before the slice —
a contact page is rewritten whenever a sync adds activity, which makes
"recently written" and "recently in touch" the same answer without opening a
note to find it.

**What a simplification costs**: gating on the parse turns the owner's own note
into a person; dropping the provenance line makes a sender's self-description
indistinguishable from something this context established; sorting on the key
lists people alphabetically by the address that happened to name their file.
The checks are `apps/mcp/test/contacts.test.mjs`, with its sabotage record —
nine edits, every one caught.

### A contact page is found by who it is, and filed A–Z (owner, 2026-10-12)

The owner wants `0-inbox/contacts/` kept tidy by the app as mail and iMessages
keep arriving: `<letter>/<page>.md`, lowercase single `a`–`z` folders, and
`other/` for a page whose name has no letter or is only an address or a
number. Pages will be renamed to `first-last.md` and merged, one page holding a
person's email *and* phone. Every sync used to recompute a page's key from an
identifier and read and write there, so the first tidy broke it: a moved or
renamed page went stale and a duplicate reappeared at the old address, and
`mergeContactNote` re-chose the key from the merged set, so a hand-merged page
could still spawn a second one.

**So a page is found by the identifiers written on it, and routing lives in one
place** — `upsertContactDraft` in `packages/communications/src/contactLookup.js`,
which the Gmail, Google Chat and desktop iMessage writers all run. A page may
sit one folder deep, in either format (`type: contact` with `## Identifiers`,
or the imported `role: communication-contact` with `## Identities`). The draft
is merged into the page carrying **any** of its identifiers, at that page's
path; only when none does is a page created, at `<letter>/<slug>.md` (the slug
unchanged, renaming is a later migration). A flat page from before is found
the same way and updated in place — no migration. An imported page is found
and never rewritten, so it is never shadowed either. Frontmatter the renderer
does not own (`review:`, tags, anything added) is carried through every merge.

**The lookup is a disposable derivative, keyed by the listing.** One prefix
listing of the contacts folder (and its archive mirror, below) per run, each
page read only when its listed version moved, the result kept at
`.context/communications/contacts/identifiers.json` (on the desktop, in memory
between passes, versioned by the size `list_notes` reports). Deleting it costs
one rebuild; a stale entry is caught because a found page is re-read and must
still carry the identifier before anything is written. The tree and props
tables were the alternative and were not used: they hold keys and front
matter, not the identifiers in a page's body, and the sync writers run where
the bucket is, not the search database. A listing that fails holds the cursor
rather than reading as "nobody has a page".

**Dormant pages come back.** A page with no activity for a year is filed at the
mirror path `4-archive/0-inbox/contacts/<letter>/<page>.md` (the sweep that
files it is the next section). The lookup searches the mirror too; a message
for that person moves the page back to its live path with the gateway's own
`move_note` — links follow, visibility never widens — and then merges.

**What a simplification costs**: recomputing the key from an identifier brings
back a duplicate after every tidy, and the test that fails is `a page the owner
moved and renamed receives the next sync`; dropping the version check reads
every contact page on every Gmail day; dropping the re-read before writing
merges a stranger into whatever a stale index named.

### A contact nobody has written to in a year is archived by the sync that would revive it (owner, 2026-10-12)

The owner wants the live contacts folder to be the people they are in touch
with: a page whose **newest dated activity entry is more than 365 days before
now** moves to its archive mirror, `4-archive/0-inbox/contacts/<same relative
path>`, which the chaos score never reads. The next message for that person
brings it back (above), so the archive is a resting place, not a deletion.

**Where it runs: at the end of every sync pass that already holds the contact
lookup, not on a clock of its own.** That is the Gmail forward pass
(`runIncrementalSync`, when it touched a day), the Google Chat forward pass
(`runGoogleChatForwardSync`), and the desktop iMessage pass (`syncImessage`) —
the three writers `upsertContactDraft` serves. The lookup already lists both
folders each pass and re-reads only the pages whose version moved; it now also
remembers each page's newest activity date and whether it waits on a review
(snapshot version 2, so a version-1 snapshot costs one rebuild), so finding
candidates costs no extra read and no extra listing. A new cron was the
alternative and was not used: it would list and read the folder a second time
on its own schedule, need its own store and credential barrier, and — because
`crons.ts` already admits one job that writes into a customer's bucket — be a
fourth such job owing its own argument for something the sync passes can do
for free. Running last in the pass is deliberate: a message in this pass counts
as activity before anything is judged dormant, and a page archived now cannot
be needed by a revival later in the same pass. All three writers run it, so a
workspace with only iMessage, or only Chat, is swept too; two passes racing on
one page is harmless (the second move finds no source, or a destination, and
is refused). A Gmail pass with no new mail opens no lookup and sweeps nothing,
which is fine at a one-year granularity.

**It holds no decision; it re-asks at the moment it acts** (`crons.ts`'s rule
for anything that writes into a bucket on a clock). The lookup's remembered
date only nominates. Each candidate is re-read immediately before its move and
judged again from its own bytes against the clock passed in then: still
`type: "contact"` (`isContactNote`), no non-empty `review:`, dated activity,
none of it since the cutoff. The move is the gateway's ordinary `move_note`
(on the desktop, the gateway's tool), so links into the page follow it,
forwarding is recorded, `privacy.md` is read again for the move and the result
is the narrower of the two folders' visibility — never wider. The tool takes no
expected etag here, for the same reason revival passes none; a message landing
in the milliseconds between the re-read and the move leaves a page archived
with fresh activity, which that person's next message revives. A round trip
can only ever **narrow**: where `4-archive/` is narrower than the contacts
folder, the page keeps the narrower visibility when it comes back (the move
records it as the page's own), and the owner widens it again by hand — the
privacy engine's rule, unchanged here.

**What is never swept**: imported pages (`role: communication-contact`) and
anything hand-written in the folder — only pages this package renders, the
same rule revival uses; a page with a non-empty `review:`, because it is
waiting on the owner and the archive would hide the question; a page with no
dated activity, because there is nothing to measure. **A page whose `## Notes`
holds the owner's own words is swept** like any other: those words travel
with the page into the archive, stay searchable there, and come back with it
on revival, so archiving costs them nothing, while exempting them would keep
every page the owner ever annotated in the live folder forever.

**Bounded and quiet.** At most 25 pages are considered per pass, oldest
activity first, so a first run over a large folder drains over several passes.
A page whose move is refused (an older copy already sits at the mirror path)
is held back for a week — remembered on the lookup entry until the page
changes — so it cannot take a place in every batch. A bucket that cannot move
a note safely (no conditional create) is not swept at all rather than refused
25 times a pass. A failure ends the sweep, never the sync: it does not hold a
cursor, fail a pass or change what the pass reports.

**The contacts plugin switch does not stop it.** The switch governs reading —
`list_contacts` and `read_contact` — and the syncs keep writing and reviving
pages with it off ([manifest-and-switches](../plugins/manifest-and-switches.md)).
The sweep is the same writer's housekeeping of the same pages, and the archive
is reversible, so it follows the writer: with contacts off the folder still
fills, and a switch that stopped the tidying but not the filling would leave
the owner a growing, unsorted folder the moment they turned contacts back on.

**What reverting costs**: without the sweep, every person the owner ever
replied to stays in the live folder forever, the chaos the A–Z folders were
built to end. Moving the decision into the lookup — archiving from the
remembered date without the re-read — archives a page that gained a message
or a review since it was listed; the checks that fail are `a page that gained
activity between listing and move is kept` and `a review: added between
listing and move keeps the page too`. Dropping the `isContactNote` gate
archives an owner's own note that happens to have dated lines; dropping the
bound turns a first sweep into thousands of moves inside one pass (`one pass
archives no more than its batch`). The tests are in
`packages/communications/test/contactDormancy.test.mjs`,
`apps/mcp/test/gmailSync/contacts.test.mjs`, the Chat pass in
`apps/convex/__tests__/googleSyncLoop/endToEnd.test.ts` and the iMessage pass
in `apps/desktop/test/imessageSync.test.mjs`.

### A contact page is created only for somebody the owner has written to (owner, 2026-10-12)

`shouldCreateContactPage` decides, for all three writers: a **new** page only
for a recipient of a message the owner sent (their address in From, iMessage
`is_from_me`, their Chat identity as sender), and never for an automated
address (`noreply`, `donotreply`, `notifications`, `newsletter`,
`mailer-daemon`, `postmaster`, `bounce`…) or a message carrying
`List-Unsubscribe` or `Precedence: bulk|list`. An inbound sender with no page
gets none — their messages still land in the day — and one who already has a
page is updated as before, so a reply after an inbound message is what starts
the page. Sync never deletes an existing page. Chat events name no recipients,
so Chat updates pages and does not start them.

**What reversing it costs**: every newsletter, receipt and one-off sender
becomes a page, which is the chaos the A–Z folders exist to end; the checks
that fail are `an inbound-only stranger gets no page` and `an automated
address never gets a page, even written to`.

### The Gmail restricted scope is Google's decision, so v1 runs on fixtures

Reading message bodies needs `gmail.readonly`, which is a **restricted** scope:
server-side storage of that data requires Google's verification and an
independent security assessment, and until it is granted the OAuth consent
screen serves at most a hundred test users. That is a calendar dependency on a
third party, and building the whole feature behind it would mean months of
work that cannot be run end to end.

So phase 1 is built against **fixtures**: a `CommunicationEvent` is a plain
object, every function from event to rendered note is pure, and the tests feed
it hand-written messages. Nothing in `packages/communications` imports a
provider SDK, knows what Gmail is, or performs I/O — which is the same shape
`packages/meetings` has and the reason its logic is testable offline in
milliseconds. **The Gmail connect flow is behind a flag, off**, until
verification lands; the flag gates the connection, not the rendering, so
everything downstream of "here is a list of messages" ships and is exercised
before a single real mailbox is attached.

There is no IMAP fallback in v1, and it is worth saying why rather than
leaving it as an omission: IMAP means holding a password or an app-specific
credential for somebody's mail, which is a credential class this product does
not have and does not want on the way to a scope it will get anyway.

### Google Chat groups spaces, then threads, then messages

The scoping note says a Google Chat day is *"grouped by space, direct message,
and thread"*. Email and iMessage group messages into threads and nothing
above that; Chat needs one more level, because a person's Chat activity spans
several rooms and DMs in a single day and a flat list of threads across all of
them reads as noise. So a Chat day note is `## <space>` → `### Thread — ` →
`#### <message>` — one heading level deeper at every rung than the shape every
other channel uses — selected by `day.channel === "google-chat"` alone, so an
email or iMessage day is unaffected byte-for-byte whether or not this code
path exists. `groupIntoSpaces` in `note.js` does the grouping; `spaceKey` in
`anchors.js` is the hash it is keyed by, the same NUL-joined,
hash-not-write construction `threadKey` and `messageAnchor` already use, for
the same three reasons: a space's resource name (`spaces/AAAA1111`) means
something to Google and nothing to the customer, and a folder-listing test in
this suite proves it never reaches the file. A space with no display name
(every direct message, always) is still labelled — `Direct message`, or
`Direct message — <name>` when Chat gives one — because a room with no
heading reads as a bug, not as "nothing to report."

**Frontmatter stays a fixed list across every channel.** `FRONTMATTER_KEYS` is
not extended with a chat-only field: the fixed list is deliberately uniform,
and forking it per channel is the first step toward a schema that drifts by
channel and a renderer that has to remember which fields which channel gets.
History-unavailable, below, is recorded in the body for the same reason.

The check is `an email or iMessage day never gains a space heading, whatever
data would trigger one for Chat`.

### An honest gap: history unavailable is written down, not smoothed over

The scoping note is explicit: *"Never claim complete history where Workspace
policy, membership, or disabled history prevents it."* Two situations make a
space's history genuinely unreadable — Chat's own per-space history setting is
off (`spaceHistoryState !== "HISTORY_ON"`), or this connection has lost access
to list the space's messages at all (membership changed, or the grant is too
narrow) — and both are facts about the *provider*, never a caller's string, so
`renderChannelDayNote`'s `unavailableSpaces` takes a fixed two-value `reason`
(`"history-off"` | `"no-access"`) and prints one of two fixed sentences,
exactly the same "enum in, fixed prose out" shape the trust warning already
uses. A silently-omitted space looks identical to "nothing happened here
today," which is the false claim the scoping note forbids; the marker is
`## <space> (history unavailable)` plus a `[!warning]` line, written once on
part 1 of the day (a part is a byte-packing artifact of one day, not a place
this fact needs repeating) and never in place of real messages that did
arrive — a space with both real activity and an unavailable gap (history
turned on partway through the day) renders both.

The check is `a day with zero events but an unavailable space is still a
well-formed note, never "(no messages)"`, and the sabotage that mattered here
was in the test suite, not the code: a check that chains a `.find()` straight
into a property access with nothing to catch `undefined` can crash the whole
process, which looks exactly like the zero-failures a passing suite reports.
Every check in `chat.test.mjs` that could fail that way now can't — a check
nobody sees fail is not a check.

### Chat's account field is per-message, not per-day

Email gets a folder per mailbox because `privacy.md` rules are folder rules
(above); Chat does not, because the scoping note draws one `0-inbox/google-chat/`
regardless of how many Google accounts a person connects, and a per-account
Chat folder was never asked for. So `channelFolder("google-chat", account)`
refuses a truthy `account` exactly as it always has — but a `CommunicationEvent`
still carries its own `account`, because `messageAnchor`, `threadKey` and
`spaceKey` all need it: two Google accounts could otherwise sync a message
into the same file with colliding hashes. The two are deliberately different
fields at different levels — `day.account`/`day.address` decide the folder and
the frontmatter's human label; `event.account` decides identity — and a Chat
day is built by omitting the day-level `account` while every event keeps its
own. Getting this backwards throws immediately (`channelDayNotePath` refuses a
non-`email` channel with an account), which is the loud failure a silent
folder collision would not have been.

### Disconnecting Chat clears settings and cursors; the folder itself follows the mailbox rule

"Deleting a mailbox deletes its folder" (above) assumes one folder per
account, which Chat does not have — `0-inbox/google-chat/` is shared across
however many Google accounts sync into it. So a Chat disconnect is two
things, not one: the *connection's* per-space settings and cursors are
always cleared (there is nothing left to resume), and what happens to
`0-inbox/google-chat/` itself follows the same "disconnect and keep" /
"disconnect and delete" choice email already offers, defaulting to keep, for
the same reason — the notes are the customer's regardless of which
connection wrote them. **Deleting the folder when a second Google account is
still connected and included would delete that account's history along with
the disconnected one's**, which is the one case this rule has to get right:
the delete path checks whether any other Chat connection still has spaces
included before it deletes anything, not merely whether the caller asked.

### The Chat scopes, and where they sit on Google's own restricted list

`google-verification-steps.md` records the classification and it is repeated
here because it changes what phase 1 can promise: reading Chat messages needs
`chat.messages.readonly`, which Google's own restricted-scopes list places in
the **same class as `gmail.readonly`** — restricted, not merely sensitive —
confirmed against
[Google's restricted scopes list](https://support.google.com/cloud/answer/13464325)
on 2026-09-07. `chat.spaces.readonly` (listing spaces and DMs to read from) is
**sensitive**, one tier down, and is not on that restricted list as of the same
check. Both are **user-authorized** scopes read against the connecting
person's own account, and Google's Chat API configuration docs say directly
that read-only user-authorized calls need no Chat app configuration (name,
avatar, interactive features) at all — that page is for a bot that posts into
spaces, which this product does not do and will not.

Restricted means the same CASA security-assessment gate `docs/decisions/communications.md`
already states for Gmail applies to Chat too — it is not a Gmail-only line
item, and a plan that budgets CASA against Gmail alone under-budgets it. So
**the Chat connect flow sits behind the same flag as Gmail's**, off until that
verification lands, for the same reason: v1 runs on fixtures precisely because
a restricted scope cannot reach real user data before Google grants it.

## A folder move the sync writes into still finishes (2026-10-12)

The contact sync writes a page at its physical key and does not read the
logical-move overlay, so a message arriving while `0-inbox/contacts/` was being
moved changed a pinned source and paused the move for good, refusing every
later write under the folder. The materializer now adopts such a change for a
page the sync renders (contact path, `type: "contact"`): before its copy it
moves the newest version; after its copy it refreshes the copy only when the
copy is still exactly what the move wrote (`copied_etag`). A person's own note
that changes under a move still pauses it. Tests: `apps/mcp/test/moveSyncOwnedChecks.mjs`.
