# Communications — search and retention

### A message anchor is a hash, and it is the only provider id in the bucket

Every message heading carries an explicit anchor id —
`{#msg-6f3a91c04b7d5e28}` — and that id is
`fnv1a64(channel \0 account \0 providerMessageId)` in 16 hex characters. It is
stable across regeneration of the day, which is what makes every link to it
survive an incremental resync, and it is what `links.js` already resolves:
`[[0-inbox/email/name-at-example-com/2026-09-07#msg-6f3a91c04b7d5e28]]` is an
ordinary wikilink and needs no new syntax.

**The raw provider id is hashed rather than written**, for three reasons that
each stand alone. A `Message-ID:` is attacker-chosen text — putting it in a
heading is the injection surface the fence exists to close, one field over. A
Gmail message id in a note is an identifier that means something to Google and
nothing to the customer, and it travels wherever the note travels, including
into an unlisted share link. And a hash is fixed-width and filename-safe, so
the id that *is* useful — "is this the same message" — is preserved exactly
while the string that is not never lands.

**FNV-1a rather than SHA-256, and the reason is synchrony rather than
strength.** `crypto.subtle.digest` is asynchronous everywhere it exists, so a
SHA-256 anchor makes rendering a day of mail an `async` function and every
caller of it async in turn — for a value that is a link target inside somebody's
own note, not a credential and not a signature. FNV-1a 64 is already this
repository's non-cryptographic hash (`fnv1a32` shards the search index), it is
one pure function over UTF-8 bytes, and at 64 bits a day of a thousand messages
collides with probability around 3 × 10⁻¹⁴. The cost is stated rather than
hidden: FNV is not collision-*resistant* against somebody trying, so a sender
who deliberately crafts a `Message-ID:` colliding with another message **in the
same day of the same mailbox** can make one link inside that note ambiguous.
That is the whole of the attack — it reaches no other note, no other mailbox,
and nothing outside the file — and it is the trade taken. If an anchor ever
becomes something a decision is made on, this is the paragraph to reverse.

**What the ingest actually needs the raw ids for lives in the control plane,
not in the bucket.** History ids, watch expiries, sync cursors and the
account's own identifiers are our sync state, they change on our schedule, and
they are worthless to a customer who revokes our credential — so they go in a
control-plane row beside the storage binding, the way every other piece of our
plumbing does. The bucket gets the content, which is what the customer keeps.
This is the scoping note's *"internal metadata ... without affecting
navigation"*, taken one step further than it asked: not merely "not a folder",
but not in their files at all.

**Provider permalinks are off by default.** A Gmail permalink embeds an
account-scoped id, is useless to anybody who is not signed into that account,
and turns any shared note into a disclosure of which mailbox it came from. It
is a per-connection setting, default off, and reversible — this is the one
paragraph here we expect somebody to want to change, and changing it changes
only what is added to future notes.

The check is
`the same message rendered twice gets the same anchor, and no raw provider id appears in the output`.

### An oversized day splits by rendered bytes, and the split is a pure function of the day

A day over a byte threshold becomes `2026-09-07.md`, `2026-09-07-part-2.md`,
`2026-09-07-part-3.md` — never `-part-1`, so the common case is the plain name
and a day that grows past the threshold *adds* files rather than renaming the
one every existing link points at.

**Rendered UTF-8 bytes, not a message count**, because the thing being bounded
is what a client has to read and what an editor has to open, and one mail with
a 200 KB quoted thread is not 1/300th of a heavy day. The split is a greedy
fill in chronological order: messages are placed in order, a part closes when
adding the next message would exceed the threshold, and a single message larger
than the threshold gets a part to itself rather than being cut. That makes it a
**pure function of the ordered event list and the threshold** — the same day
regenerated from the same messages produces the same parts, byte for byte,
which is the property incremental resync depends on. A split that depended on
arrival order would reshuffle anchors across files every time a backfill
re-ran, and every link into the day would rot.

The cost is stated rather than hidden: a message arriving *late* for an
earlier day (a backfill filling a gap) can move later messages into a
different part, and every link into those messages then points at the wrong
file. The anchor is unchanged, so the fix is cheap and is the reason anchors
are hashes rather than positions — a reader that misses an anchor can find it
in the sibling parts of the same day. **We do not renumber to avoid this**;
stability against the common case (append-only, same day) is what matters, and
buying stability against the rare one would mean never re-packing, which
unbounded-grows part 1.

Recommended threshold: **512 KB**. The reasoning is in the two numbers this
product already has — the search index reads a note at
`NOTE_INDEX_CHAR_CAP` (2,048 characters) and a shard is capped at 2 MB — plus
the storage estimate's 15–40 KB per normalized email, which puts a *typical*
100-message day at 1.5–4 MB and a heavy one well past that. 512 KB keeps a part
openable in any editor and any WebView, keeps a part comfortably inside a
single gateway read, and puts a typical heavy day at 5–10 parts rather than 50.
It is a constant in one place, not a shape, so it is a number to revise with
measurements rather than a decision to relitigate. The checks are
`splitting is deterministic for a fixed input` and
`a message larger than the threshold is never cut in half`.

### A channel-day note is a note, and `privacy.md` decides it with no bypass

Nothing here adds a visibility rule, a tier, or a third word. A channel-day
note is an ordinary note at an ordinary path: `canSee` decides who reads it,
`effectiveVisibility` reports it, `set_visibility` and
`set_folder_visibility` change it, and the audit trail records the read. There
is no "communications" scope on a grant and there must not be one.

Four consequences, each of which is the thing a reviewer should check for:

- **Default private, and that is the folder rule doing it, not a special
  case.** `visibilityOf` returns `private` when no rule matches, and a personal
  workspace is scaffolded all-private. A newly connected mailbox writes into a
  folder nobody has named in `privacy.md`, so it is private from the first
  byte, before any code in this package runs.
- **Never `team` by default, and a shared workspace is where that would have
  happened.** A shared workspace scaffolds its folders `team`
  ([privacy & sharing](../privacy-and-sharing.md), *A shared workspace
  scaffolds `team`*), and `0-inbox` is one of them — so a mailbox synced into a
  workspace would be readable by every member from the first message, with
  nobody having decided that. **The mailbox connection is refused in a shared
  context**, which is the same rule mail ingestion already runs under
  ([identity & access](../identity-and-access.md), *Mail lands in a personal
  context and nowhere else*) and for the same reason: writing into a space
  several people read is a different risk from writing into your own. V1 is
  person-owned, so this costs nothing today and is the line that must not be
  crossed quietly when workspace inboxes are built.
- **A team-tier caller infers nothing.** Not the existence of a mailbox, not
  its address, not how many days it has, not that one exists at all. Every
  count that leaves the gateway is computed over the caller's *visible* list
  — the existence-oracle rule search already runs under
  ([search](../search.md)) — and a folder map that shows `0-inbox/email/…` with
  a count to a connection that may not read any of it is the same subtraction
  wearing a folder icon.
- **A share link is a note, and a note here is a day.** An unlisted share is
  one row over one path ([privacy & sharing](../privacy-and-sharing.md)), so
  sharing a message means sharing the day it is in. There is no per-message
  share and there should not be one: the sharing unit is the file, and
  inventing a sub-file audience is the third visibility word non-negotiable 5
  forbids, reached from a different direction.

The checks are `a channel-day note in an unnamed folder is private`,
`a team connection cannot enumerate, count, or infer a private mailbox`, and
`connecting a mailbox to a shared context is refused`.

### Search must index messages, and today's index cannot

The scoping note says *"search indexes messages and anchors inside daily files
rather than treating each message as a note"*, and that is the right shape.
**It is not what the index does today, and this is the one place where the
design as scoped does not fit the product as built.**

`NOTE_INDEX_CHAR_CAP` is 2,048 characters. The indexer takes the first 2 KB of
a note and nothing else — a documented, user-visible loss of recall that is
fine for a note somebody wrote and fatal for a 512 KB bundle of a day's mail,
where it would index the first two or three messages and silently drop the
other eleven. Splitting does not rescue it: each part gets its own 2 KB.
A person searching for a phrase they know is in their mail would be told, in
`toolSearchNotes`'s own honest words, that it is not written down.

So the decision is: **a channel-day note is indexed as one document per
message — `path#anchor` — not as one document per file.** The note stays one
file in the bucket; the index, which is a disposable derivative and may take
any shape that serves an answer, holds a document per message with its own
cap, its own title (the subject), and the containing note's path.
`canSee` is applied to the **containing note's path**, never to a message: the
file is the privacy unit and the index must not become a second place where
that is decided.

Two guardrails, because this is a search-contract change and not a free one.
The per-message document count is real — the storage estimate's typical year
is 36,500 emails, which is 36,500 documents against a corpus that is a few
thousand notes today — so the shard budget, the manifest and `pending` all
have to be measured against a mailbox before this is switched on, and the
switch is per context. And the existing single-document path stays: a note
that is not a channel-day note is indexed exactly as it is now, so nothing
about this reaches a workspace with no mailbox connected.

This is **decided here and built in phase 2**, with `apps/mcp/src/search/CONTRACT.md`
amended in the same commit as the code. Phase 1 shipped the rendering, the
anchors and the recognisers, and did not touch the index. The check that
matters is `a term in the last message of a large day is found`.

**Phase 2 shipped.** `apps/mcp/src/search/commsIndex.js` is the split:
`subDocumentsFor(path, full)` is the sync loop's one seam, answering the
existing single-document, whole-file-capped behaviour for anything that is
not a channel-day note and one sub-document per message anchor for one that
is. Every doc entry gained three optional fields — `notePath`, `anchor`, and
`comms` (`channel`, `date`, a **rendered thread label** rather than a hashed
provider thread id, since the bucket never retains one to re-read, and
`participants`) — defaulting to "an ordinary note" so a stored shard written
before this feature parses unchanged, and `canSee` is applied to `notePath` at
every visibility check in the query path rather than to a sub-document's own
key, which is the concrete difference between correctly hiding a private
day's messages and quietly missing an exact-note `privacy.md` override that
names the note precisely (a folder-prefix rule would pass by accident; an
exact-path rule would not, which is why the test uses one). Full argument and
format: `apps/mcp/src/search/CONTRACT.md`, "Channel-day notes: one
sub-document per message". The mechanism is built and tested
(`apps/mcp/test/commsSearchIndex.test.mjs`): independent per-message capping
on a day many times `NOTE_INDEX_CHAR_CAP`, the private/team and tenant-isolation
proofs above with each visibility guard driven alone, encrypted notes teaching
the index no plaintext term, and a regeneration replacing exactly one note's
sub-documents.

**And the shard guardrail is now measured, which is the thing that gated
connecting a mailbox.** It was measured failing, and then fixed. Against a
synthetic 90-day mailbox at 200 messages a day (18,000 messages, 27.2 MB of
Markdown, beside 200 ordinary notes), on the gateway's own sync at a
subrequest budget of 600:

| | sized by note count | sized by volume |
| --- | --- | --- |
| documents in the index | **0** (18,200 built) | 18,200 |
| shards | 1 | 56 |
| shard objects written | **0** (0.00 MB) | 56 (80.84 MB, biggest 1.76 MB) |
| passes | 40, still `pending: 290` | 1, converged |
| a search for a term in the mail | `indexed: false` | 1 hit |
| a search in the 200 **ordinary notes** | `indexed: false` | 10 hits |

**The left column is the defect: nothing landed at all, and the loss was the
whole context's rather than the mailbox's.** `chooseShardCount` sized the index
from the **note** count in the listing — 290 notes is one shard — so a day's
messages could not be spread across shards, the single shard's serialized body
passed `SHARD_PARSE_BYTE_CAP`, and the write was correctly refused on every
pass. That is the plateau `docs/decisions/search.md` describes ("each pass
rebuilt the same oversized shard and had its write refused"), reached here by a
mailbox rather than by a workspace of thousands of notes, and it took the 200
ordinary notes in that bucket down with it. The threshold was **four messages a
day**: 1.67 MB of shard at four, past the 2 MB cap at five.

**The right column is the fix**, argued in `docs/decisions/search.md`, "The
index is sized by the volume it has to hold". The count follows the volume the
listing implies rather than the objects it found, it may grow after the
manifest exists without moving a doc already placed, a bundled note is placed
in the least loaded shard rather than by hash, and a shard that still will not
fit sheds the note that made it that big instead of refusing its whole write.

**What that leaves, for the person deciding whether to connect a mailbox.** At
90 days the corpus indexes in full up to **230 messages a day** — 20,900
messages, 31.2 MB of Markdown, 64 shards, the biggest 1.99 MB against the 2 MB
cap. At 240 a day it needs a 65th shard it cannot have, and 26 of the 90 days
are reduced to one document each. Past that nothing else breaks and nothing
else is lost: measured at 365 days x 200 (73,000 messages, 110 MB — three times
what the index holds), every shard is still written, the ordinary notes still
answer, and 237 of the 365 days are reduced. **A mailbox can no longer take a
context's search down with it; a mailbox past capacity loses message-level
recall on some of its own days**, and which days is a function of their byte
sizes rather than their dates, which is a real cost and named as one.

**That cost is now told to the person it happens to, not only argued here.**
This section named it and stopped; a search over a reduced day used to answer
plainly empty, `indexIncomplete: false` included, which is the silent-wrong-
answer defect `docs/decisions/search.md`'s "A shed index must say so to the
caller it happened to" closes — `reducedRecall` / `reducedRecallNotes` on a
search answer, `orient`'s own `## Search coverage` section, and the note's own
path (which already names the channel and the day) rather than a bare count.

So the position is unchanged and now has numbers on both sides of it: this
format is correct, and the sizing it needed has been built.
`runShardSizingChecks` in `commsSearchIndex.test.mjs` pins the mechanism at
suite speed with a small `shardByteCap`, and
`apps/mcp/test/bench/shardSizing.mjs` re-measures the full-size numbers above,
so neither the plateau nor the capacity can be rediscovered by a customer.

**Filtering by `comms`'s fields is not built.** They are stored through both
serialization dialects because a caller needs them to render a result (the
date and channel beside a message hit, say) and because the decision above
names them, but nothing in the scorer narrows a query by channel, date,
thread or participant yet — that is a query-surface change with its own
argument, not a free rider on the storage format landing here.

**The console deep link opens correctly; scrolling to the anchor is not
built here.** A result's `key` is `<notePath>#<anchor>`, the same shape a
wikilink into one already uses, and `noteHref`/`noteFromQuery` in
`apps/mobile/features/console/nav.ts` already round-trip it correctly — the
anchor is split off before it ever reaches `useNoteAddress`'s note/selection
reconciliation, so a search result opens the right note rather than a literal
`path#anchor` 404. Scrolling the editor to the message once it is open would
mean extending either the frozen native `EditorCommand` bridge
(`webview/protocol.ts` says why that list is deliberately closed) or the web
CodeMirror instance a sibling change is concurrently touching for the console
Inbox views, and this change deliberately does not do either — left for a
follow-up with its own review rather than guessed at here.

**The gateway's read tools take that key too, which review found they did
not.** The console was fixed and the endpoint was not: `search_notes` prints
`<notePath>#<anchor>` and an agent's next call is `read_note` on exactly that
string, which resolved no object and answered "not found"; the ChatGPT
dialect's `fetch` refused it a line earlier still, on `endsWith(".md")`, so
`search` then `fetch` — the only two tools an ordinary ChatGPT chat can call
— could not open a message it had just found. Both now split a trailing
well-formed anchor and read the containing note (`splitMessageAnchor`,
`apps/mcp/src/search/CONTRACT.md`), which is the same unit `canSee` decided
and the same unit a share link covers. It is not a way around visibility: the
path read is the path filtered on, and a team connection handed a private
day's deep link still gets "not found".

### A firehose is not attention

`orient` ranks "Recently updated" off the bounded walk, and `list_notes`
answers a prefix in key order. A connected mailbox writes a note **every
active day, forever**, and a meeting note lands almost as often, so within
days of either being switched on every recency signal in this product is
automation's own paperwork — and the front page an agent reads first, whose
entire job is to say where the person's attention has been, says "email,
email, email" instead.

**The fix is collapse, not exclusion, and the difference is the point.** An
earlier draft of this decision excluded channel-day notes from the recency
list outright; built and tested, that answer is wrong in the other direction —
an agent asked "what came in?" would learn nothing at all, when the honest
answer is "thirty days of mail, most recently today's." So `surveyContext`
splits every visible note into **authored** (written or edited by a person, or
by an agent through an ordinary tool call on their behalf) and **automated
capture** — a channel-day note, a meeting note, a saved coding session filed
at its unrouted `0-inbox/sessions/` default, recognised by path alone in
`src/communications/paths.js`. `mostRecent` ranks the authored subset exactly
as it always has, at the same `ORIENT_RECENT_LIMIT` budget; automated capture
is reduced to **at most one line per kind** — a count and the single newest
note — appended after. A kind's line can never outrank or displace an authored
note, because the two are never in the same ranked list: automated notes are
removed before `mostRecent` runs, not sorted alongside authored ones and
truncated.

Three properties follow from that split and are each proved by a test in
`test/orientation.test.mjs`, "automated capture is not attention":

- **A person's edit does not exempt a note from collapsing.** Nothing in this
  stack distinguishes a write an ingestion worker made from a write a person
  made by hand in Obsidian — both are an ordinary `store.put`, indistinguishable
  by etag or modified time, and the audit trail only ever hears about a write
  that went through a gateway tool. So the recogniser is a **path** predicate
  and nothing else, on purpose: a channel-day note somebody has since rewritten
  by hand is, structurally, still a channel-day note, and stays collapsed. The
  alternative — trying to infer authorship from timing or content — would be
  confident and wrong in both directions.
- **The collapsed count and pointer are `canSee`-filtered like everything
  else.** A kind's summary is built from the same visibility-filtered note list
  the folder map and the authored recency list already use, so a private
  mailbox's days never inflate a team caller's count and are never the "newest"
  a team caller is pointed at — the same existence-oracle rule search already
  runs under.
- **The folder map is unchanged and still carries the true counts.** An agent
  that wants every individual note goes to `list_notes` or `search_notes` on
  the folder the collapsed line names; the collapse is a summary for the one
  view whose job is "recent," not a second, quieter exclusion of the same
  notes from the product.

The check that fails if this is reversed back to exclusion is
`toolOrient answers "what came in" with a pointer, never silence`; the check
that fails if the collapse is dropped entirely is
`a workspace with a year of channel-day notes still surfaces its own recent notes
in orient` — sabotaged by returning `null` from every branch of
`classifyCaptureKind`, which failed 13 of the 16 checks in that block,
including the ones proving a hand-edited note is not displaced.

### Retention: raw MIME is off by default; attachments are fetched into the bucket, retained on a timer

- **Raw MIME is not stored.** The normalized text is what every reader — the
  person, the index, the model — actually uses, and the storage estimate puts
  raw at several times the normalized size for fidelity nobody has asked for.
  It is a per-connection opt-in, quota-bound and off, with the bytes going to
  a plumbing prefix rather than beside the notes if it is ever switched on.
- **Attachments are fetched into the bucket, and this reverses the original
  default (owner's decision, 2026-09-07).** The first pass of this decision
  said "described, not copied" — filename, content type and size rendered
  under the message, nothing fetched. Built and used, that answer was wrong
  in the direction that matters most: *"sometimes an email says look at the
  PDF attached, and it should land somewhere referenceable in the bucket."*
  A mailbox connection's working default is now `attachmentMode: "store"`,
  and `"metadata-only"` is the opt-*out*, not the default — the reverse of
  where this section started.

  What did not reverse: the mechanism is still content-addressed and still
  reuses "the same bytes twice is one object" rather than inventing a second
  copy per message. What did change is *where*: a connected mailbox's
  attachments live under its own folder —
  `0-inbox/email/<mailbox-slug>/attachments/<YYYY-MM-DD>/<content-hash>-<sanitised-name>`
  — rather than the generic `.images/<sha256>.<ext>` store this section
  originally pointed at. That store is shared across every feature that
  writes an image (share-card previews, a note's own inline images) and has
  no retention concept; a connected mailbox needs both a per-connection
  retention window and a per-connection quota that covers exactly its own
  bytes, neither of which composes cleanly with a shared, unretentioned
  store. A folder scoped to the connection is what makes "delete this
  connection's attachments, and only this connection's" a prefix operation
  rather than a filter over everyone's images.

  **The stored content-type is always `application/octet-stream`, never the
  sender's declared MIME type.** An attachment's real type is exactly as
  untrusted as its filename, and writing it verbatim as the object's
  `content-type` would mean any of the customer's own tooling that later
  serves their bucket over HTTP could be handed `text/html` or
  `image/svg+xml` from a stranger and render it inline rather than download
  it — the same class of attack SVG's absence from the writable-type list
  already guards against, reached from the sender's side instead of the
  gateway's. `apps/mcp/src/store/index.js`'s `WRITABLE_CONTENT_TYPES` gained
  exactly one entry for this, `application/octet-stream`, and every
  attachment write uses it regardless of the real type — which is preserved
  as text in the note (`**Attachments**: name — type, size`), metadata a
  reader sees, never a header a transport trusts.

  **Each Gmail attachment part is capped at Gmail's own 25MB limit, and the
  cap is enforced on the bytes rather than on Gmail's word for them.** The
  *declared* size already present in the message resource is checked first,
  so no fetch is spent learning that an attachment is too large; that is an
  optimisation. The enforcement is the second check, on `bytes.length`,
  before the write. Adversarial review found why both are needed: Gmail
  omits `body.size` on some parts, `extractBody` maps a missing size to
  `undefined`, and `undefined` landed in the comparison as **zero** — which
  is smaller than every bound there is. A part with no declared size fetched
  and wrote 30MB into a bucket with the connection's quota at nothing at
  all, defeating the 25MB cap and the quota together with a field Google
  simply had not sent. The same applies to the quota: `remaining` is checked
  against the declared size to skip the fetch and against the real length to
  permit the write. **A bound that trusts a provider-supplied number is not
  a bound**, and the direction this now fails is "the attachment stays
  metadata-only," which costs a link and never the customer's storage bill.
  A refusal is not written to the manifest's `resolved` index either, so a
  later pass with more room tries again rather than remembering a skip
  forever. The checks are
  `an attachment with no declared size is still bound by the 25MB cap` and
  `an attachment with no declared size cannot spend quota the connection
  does not have`.
  **Retention is per-connection, 90 days by default, and "keep forever" is a
  real value, not a very large number**: `attachmentRetentionDays` is
  `number | "forever"` end to end, from the connect-time choice through the
  manifest entry a sweep reads. When the window passes, the file is deleted
  and the day's note — the next time it is regenerated — renders that
  attachment as name and size only, exactly as if it had never been fetched;
  nothing about the note's *shape* distinguishes "never stored" from
  "stored, then expired," which is the property that makes the rendering
  side of this a pure function of one boolean (`path` present or absent) and
  not three.

  **Idempotence is by content hash, tracked in a per-mailbox manifest, never
  a folder walk.** `0-inbox/email/<slug>/attachments/.manifest.json` — a
  dot-prefixed *filename*, which `isPlumbing`'s "any path segment starting
  with a dot" rule hides from every tool exactly as a dot-prefixed folder
  would, sitting beside the files it describes rather than in the control
  plane, because it is bucket bookkeeping about bucket content. It carries
  two indices: which `(messageId, attachmentId)` pairs have been resolved
  before and to which content hash, and which content hashes have an actual
  file and whether that file has since expired. A resync of a message whose
  attachment is already resolved — live or expired — never calls Gmail's
  `attachments.get` again; a retention sweep walks only the second index,
  which is what "idempotent, and never a folder walk" means concretely: an
  entry already marked expired is skipped, so sweeping twice deletes nothing
  a second time.

  **Inline images count as attachments**, deliberately not special-cased:
  Gmail gives an inline image the same `filename` + `body.attachmentId`
  shape as a "real" attachment, and this pipeline reads the shape, not a
  disposition header.

  **The sweep reads the manifest as data, never as instructions.** It is our
  bookkeeping inside a bucket the customer also syncs to Obsidian and rclone,
  so "deletes only files this sync wrote" cannot rest on the code that
  *writes* the manifest being the only thing that ever does. The sweep
  refuses any entry whose path is not under this mailbox's own
  `attachments/` prefix — another mailbox's folder in the same bucket
  included — so a manifest naming `privacy.md` deletes nothing. The check is
  `a manifest entry pointing outside the mailbox's own folder deletes
  nothing`.

  **A filename is sanitised for a storage key, which is stricter than the
  rule for prose.** `sanitizeAttachmentFilename` strips what `singleLine`
  strips — the C0/C1 range, the line separators, the bidi overrides and
  isolates — and then strips what `singleLine` deliberately leaves alone:
  the bidi *marks* (U+200E, U+200F, U+061C) and the zero-width family
  (U+200B–U+200D, U+FEFF, U+00AD). In a sentence those are at worst
  confusing; in a key they are two objects that are indistinguishable in
  every listing a person or an agent will ever read, on the customer's
  storage bill, and two different wikilink targets in the raw Markdown of
  the note. A percent-encoded traversal is closed one layer further down and
  is now pinned by a test rather than assumed: `S3Store` encodes each key
  segment with `encodeRfc3986`, so a literal `%` goes on the wire as `%25`
  and `%2f` is stored as the four characters it is, never a separator.

  **And the renderer does not trust its caller's path either.** The label
  half of `[[path|label]]` is sender-chosen and defanged; the path half is
  supposed to be ours, built from a content hash and an already-stripped
  filename. `packages/communications` is a pure package with several
  callers, so it re-checks: a path still carrying `[`, `]` or `|` renders as
  an unstored attachment instead of a link. A storage key containing `]]`
  was never a key this product wrote, so refusing it outright costs nothing
  real and closes the case where one caller's sanitiser regresses and a
  stranger gets a second wikilink inside a note the owner reads as their own.

  The check is `a hostile filename cannot escape the attachments folder or
  break the wikilink it is embedded in`, `a re-sync after expiry does not
  re-fetch`, and `sweeping twice in a row deletes nothing a second time`.
- **Deleting a mailbox deletes its folder.** One prefix, one delete, and the
  control-plane sync state goes with it. Because the mailbox is a folder
  (above), this is a real operation rather than a filtered scan, and it
  takes the attachments folder and the manifest with it — and because the
  notes are the customer's, the offer is "disconnect and keep" as well as
  "disconnect and delete", with the default being keep.
