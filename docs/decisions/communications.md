# Communications

_See `docs/decisions/README.md` for the index._

Context records a person's communications the way it records their meetings:
not as a separate product with its own account and its own export button, but
as **plain Markdown in a bucket they own, readable through the endpoint every
AI client they have is already connected to**. A mail archive that held your
mail would be a competitor to us as much as to anyone else.

The scope this argues is `1-projects/context-lc-personal-communications-inbox`
in the company workspace, dictated by the owner on 2026-09-07: several personal
mailboxes, Google Chat and iMessage, one Inbox and one Contacts graph, **person
owned**. Workspace inboxes, support intake and team-owned communications are
explicitly a later product and nothing here should make them harder.

The on-bucket layout is a stable format, not an internal detail
([non-negotiable 3](../../CLAUDE.md)) — the same bucket is somebody's Obsidian
vault, and changing where a year of their mail lives is a migration they did
not ask for. So it is decided once, here, before anything writes a file.

The prototype of this layout is `packages/communications` — pure functions,
no dependencies, fixtures and tests, exactly like `packages/meetings`. That
package is the contract; this file is the argument behind it.

### A channel lands in `0-inbox`, and there is no second inbox root

The scoping note draws the tree under a top-level `inbox/`:

```text
inbox/
├── meetings/
├── name@example.com/2026/09/2026-09-07.md
├── google-chat/2026/09/2026-09-07.md
└── contacts/person-slug.md
```

**`inbox/` is not built, and `0-inbox/` is where every one of those goes.**
The note was written about the shape of the hierarchy — Inbox at the root,
channels as its direct children, nothing interposed — and that shape survives
intact. What does not survive is the folder's *name*, for three reasons:

- **The bucket already has an inbox, and it is `0-inbox/`.** PARA numbering is
  the layout every existing brain was scaffolded with and the one `privacy.md`
  carries folder rules for. A second inbox root beside the first is two
  inboxes: two places an unfiled thing can be, two folder rules to keep in
  step, and a `0-inbox` that quietly means "everything except mail".
- **The meeting-capture decision of 2026-09-07 already settled what goes in
  it.** *"`0-inbox` is where unfiled things arrive and what arrives there is
  sorted by what it is — `0-inbox/meetings`, `0-inbox/sessions`, mail beside
  them"* ([meetings](./meetings.md), *A meeting lands at an ordinary path*).
  A day of somebody's mail is an unfiled thing sorted by what it is. It is the
  same rule, not a new one.
- **Meetings are already there.** The note's tree has `inbox/meetings/`, and
  meetings are written to `0-inbox/meetings/` today by a shipped gateway, a
  shipped phone and a shipped Mac app. Honouring the note's name literally
  would move every existing meeting note in every connected bucket — the exact
  zero-migration guarantee non-negotiable 2 exists to make.

So the layout is:

```text
0-inbox/
├── meetings/2026-09-05-quarterly-review-8h9jkmnp.md   (unchanged)
├── sessions/…                                          (unchanged)
├── email/
│   ├── 9f2c1d7a4b6e8035ac91d2f4.md                     (unchanged: forwarded captures)
│   ├── name-at-example-com/2026-09-07.md               (new: a connected mailbox)
│   └── another-at-example-com/2026-09-07.md
├── google-chat/2026-09-07.md
├── imessage/2026-09-07.md
└── contacts/adam-okonkwo.md
```

**The forwarded-capture folder is untouched, and the mailboxes go inside it.**
`0-inbox/email/<fingerprint>.md` is where the email worker has been writing
one-note-per-message captures from the ingestion alias since before this
project existed, and those keys do not move. A connected mailbox is a *folder*
in the same place, so "where is my mail" has one answer, and the two shapes
cannot collide: a capture is 24 hex characters and a `.md`, a mailbox is a
folder whose name contains `-at-`.

Reversing this — a top-level `inbox/` after all — costs a rename of every
meeting note in every bucket plus a `privacy.md` rule nobody's manifest has,
and buys a folder name one character shorter. The check is
`every communications path this package writes begins with 0-inbox/`.

### There are no `YYYY/MM/` folders, and the date is the filename

The scoping note nests `2026/09/2026-09-07.md`. **That tree was built here
once, used, and removed as unusable**, and the argument against it is already
written down ([meetings](./meetings.md), same section): two directory levels
per note, most of them holding one file, in front of a filename that already
opens with the same date, so reaching a note is two folders deep and a listing
of the year shows twelve folders instead of the notes. A flat folder sorted by
name is the ordering the tree was drawn to give, one level up.

Daily bundling does not change that argument, it sharpens one half of it and
weakens the other. Sharpens: a channel-day note is *dense* — one file per
active day, at most 365 a year, named `2026-09-07.md`, which sorts
chronologically by name with no help — so the tree buys nothing at all.
Weakens: 365 files is a bigger flat folder than a meetings folder ever gets,
and past a few years it is a listing nobody scrolls. That is a real cost and
it is paid deliberately: **a listing is not how anybody reaches a day of mail**.
They reach it from a Contact page, a search hit, a thread link, or
`list_channel_days` with a date range — all of which take a path and none of
which walk a folder. Optimizing the folder listing is optimizing the one
access path that does not matter.

**And the recogniser accepts one shape, not two.** `isMeetingNotePath` reads
both the flat and the dated shape, permanently, because meetings were written
into the dated one for months and a recogniser that dropped it would silently
stop calling somebody's existing meetings meetings. **No bucket anywhere holds
a channel-day note**, so there is no legacy to accept, and accepting a shape
nothing ever wrote is an unreachable branch that will be read as a supported
format by the next person. The asymmetry between these two functions is the
argument, not an inconsistency. The check is
`a dated-tree channel path is not a channel-day note`.

### The mailbox is a folder because a folder is what `privacy.md` can name

The alternative to `0-inbox/email/<address>/2026-09-07.md` is one flat folder
with the address in the filename: `0-inbox/email/2026-09-07-name-at-example-com.md`.
It is fewer levels, and it is wrong.

`visibilityOf` is a **longest-matching-prefix** rule over `folder_defaults`,
and the exact-note overrides are exact. So a folder is the only unit of this
product's privacy engine that can say "this mailbox, and everything in it,
forever". With a per-address folder, marking a work mailbox `team` and a
personal one `private` is two lines in `privacy.md` and it covers next year's
mail too. Flat, the same intent is **one exact override per day, per address,
written every day, forever** — and the day the writer forgets one, a day of
somebody's personal mail inherits the folder default instead. A privacy model
whose correctness depends on a daily write is not a privacy model.

Two smaller consequences fall out and both are wanted: `set_folder_visibility`
already works on it with no new tool, and disconnecting a mailbox deletes one
prefix rather than filtering a folder by filename.

The check is
`two mailboxes under one folder rule each get their own visibility`.

### An address becomes a slug, and a slug is never a name anybody can claim

`name@example.com` is not a path segment. `@` and `.` survive most object
stores, and that is the problem: the failure modes are not "the write fails",
they are silent.

- **A leading dot is plumbing.** `isPlumbing` treats any dot-prefixed segment
  as plumbing and hides it from every tool at every tier, the owner's
  included. A mailbox whose local part begins with `.` would be invisible to
  the person paying for its storage.
- **A segment that is `.` or `..`, raw or percent-encoded, escapes the
  folder.** The storage adapter decodes before it compares; `normalizeRoot`
  and `normalizeMeetingFolder` already carry the rules, and this package
  reuses them rather than writing a third validator — two implementations of
  "does this string escape its bucket" is how one of them ends up weaker.
- **Case folds on Dropbox and not on R2.** `DropboxStore` treats `Foo` and
  `foo` as one file. An address-derived segment that differs only in case is
  two folders on one backend and one on another, and privacy answers are
  folded case-insensitively precisely because of it.

So the folder is `slugifyAddress("Name@Example.Com") === "name-at-example-com"`:
lowercase, ASCII, `@` → `-at-`, every other run of non-alphanumerics → `-`,
trimmed, length-bounded. It is a **display-safe derivative, and the address
itself is preserved in the note's frontmatter** (`address: "name@example.com"`),
so nothing is lost by the mapping. Two addresses that slugify to the same
string get a deterministic short hash suffix on the second — collisions are
resolved once at connect time, recorded on the connection, and never
recomputed, because a folder that renames itself when a *different* mailbox is
connected is a rename of somebody's mail.

**A mailbox slug is never a claimable name, and this is where those two
namespaces are kept apart.** `functions/lib/names.ts` is a security control
because ingestion is on the apex: whoever holds `@support` receives
`support@` the company's domain ([identity & access](./identity-and-access.md),
*Ingestion is on the apex*). A folder name inside a customer's bucket is not
that namespace and must never be read back into it — and putting mailboxes one
level down, under `0-inbox/email/`, is what makes that structural rather than a
rule somebody has to remember: a mailbox folder cannot collide with
`0-inbox/meetings`, `0-inbox/sessions` or `0-inbox/contacts` because it is
never their sibling. The slug function is deliberately not `slugifyTitle` and
does not consult the reserved list: mapping a folder name through a mail-role
denylist would rename somebody's real mailbox after a word on a list they
cannot see.

The checks are `a mailbox folder never begins with a dot`,
`a mailbox folder is never "." or ".." decoded or raw`, and
`a mailbox slug is not a name the control plane would hand out`.

### A channel-day note is one file, with a fixed frontmatter, and its messages are fenced

One active day of one channel is **one note**. Frontmatter keys are a fixed
list in the renderer — never derived from a message — in a documented order, so
the written order and the documented order cannot drift:

```markdown
---
updated: "2026-09-07T18:04:11.221Z"
type: "channel-day"
channel: "email"
address: "name@example.com"
date: "2026-09-07"
messages: 14
threads: 5
part: 1
parts: 1
trust: "untrusted"
origin: "gmail-sync"
---

# 2026-09-07 · name@example.com

## Thread — Quarterly numbers

### 09:14 · Adam Okonkwo · Quarterly numbers {#msg-6f3a91c04b7d5e28}
…fenced body…
```

Three things about that are decisions rather than formatting.

**The keys are a fixed list, and every value is escaped twice.** This is the
same file-format security boundary the email worker's `note.ts` already argues
in full: a subject of `Lunch\ntrust: trusted\nvisibility: team\nx: y` writes
three extra keys into a document the rest of the system reads as
configuration. Both defences are reused verbatim — every value passes through
a control-character strip *and* is emitted as a JSON string literal, which is
also a valid YAML double-quoted scalar. Neither alone is relied on. A renderer
that emits a bare scalar because "this field is a date" is the regression.

**Every message body is fenced as untrusted, with a per-note nonce.** A
mailbox is a channel strangers write into, and a note in this bucket is read
later by the owner's AI clients *as part of their own context* — the same
channel as the notes they wrote themselves. `trust: untrusted` in the
frontmatter is for structural readers; a prose warning addressed to the reader
is for the model that never sees frontmatter; a nonce-carrying fence around
the sender's words is what makes the *extent* of the untrusted region
unambiguous. A fixed marker would be published in this repository and the
sender's first move would be to close it. This is not new policy, it is the
existing capture policy applied to the channel that will carry a thousand times
more of it. The check is
`a message body containing the fence marker cannot end the fence`.

**Thread grouping is presentation, not identity.** Messages are grouped under
`## Thread — <subject>` in first-message order, and a thread that spans days
appears in each day's note. There is no cross-day thread *file*: continuity is
a virtual view assembled from the thread key on each message, exactly as the
scoping note asks. A thread file would be a second canonical copy of the same
messages and the first thing to go stale.

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
  brain is scaffolded all-private. A newly connected mailbox writes into a
  folder nobody has named in `privacy.md`, so it is private from the first
  byte, before any code in this package runs.
- **Never `team` by default, and a shared workspace is where that would have
  happened.** A shared workspace scaffolds its folders `team`
  ([privacy & sharing](./privacy-and-sharing.md), *A shared workspace
  scaffolds `team`*), and `0-inbox` is one of them — so a mailbox synced into a
  workspace would be readable by every member from the first message, with
  nobody having decided that. **The mailbox connection is refused in a shared
  context**, which is the same rule mail ingestion already runs under
  ([identity & access](./identity-and-access.md), *Mail lands in a personal
  context and nowhere else*) and for the same reason: writing into a space
  several people read is a different risk from writing into your own. V1 is
  person-owned, so this costs nothing today and is the line that must not be
  crossed quietly when workspace inboxes are built.
- **A team-tier caller infers nothing.** Not the existence of a mailbox, not
  its address, not how many days it has, not that one exists at all. Every
  count that leaves the gateway is computed over the caller's *visible* list
  — the existence-oracle rule search already runs under
  ([search](./search.md)) — and a folder map that shows `0-inbox/email/…` with
  a count to a connection that may not read any of it is the same subtraction
  wearing a folder icon.
- **A share link is a note, and a note here is a day.** An unlisted share is
  one row over one path ([privacy & sharing](./privacy-and-sharing.md)), so
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
about this reaches a brain with no mailbox connected.

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

**And the shard guardrail is now measured, which is the thing that gates
connecting a mailbox.** Against a synthetic 90-day mailbox at 200 messages a
day (18,000 messages, 25.5 MB of Markdown, beside 200 ordinary notes), on the
gateway's own sync at a subrequest budget of 600:

| | per-note index (today) | per-message sub-documents |
| --- | --- | --- |
| documents | 290 | 18,200 |
| shards | 1 | 1 |
| shard objects written | 1 (0.36 MB) | **0** |
| passes to converge | 1 | 31, then still `pending: 290` |
| a search | 1 hit, 16ms | `indexed: false` |

**Nothing lands at all, and the loss is the whole context's rather than the
mailbox's.** `chooseShardCount` sizes the index from the **note** count in the
listing — 290 notes is one shard — so a day's messages cannot be spread across
shards, the single shard's serialized body passes `SHARD_PARSE_BYTE_CAP`, and
the write is correctly refused on every pass. That is the plateau
`docs/decisions/search.md` describes ("each pass rebuilt the same oversized
shard and had its write refused"), reached here by a mailbox rather than by a
brain of thousands of notes, and it takes the 200 ordinary notes in that
bucket down with it. The threshold is low: at 90 days the shard is 1.13 MB at
**10** messages a day and 2.14 MB — over the cap — at **20**.

So the position is unchanged and now has numbers behind it: this format is
correct, and **switching a real mailbox on needs the sizing to count
sub-documents rather than notes** (or a per-note shard split, or a smaller
per-message cap). That is a decision with its own argument and is not made
here; what is made here is that nothing writes a channel-day note today, so
the format can land and be exercised while that is settled.
`runShardBudgetChecks` in `commsSearchIndex.test.mjs` pins the mechanism at
suite speed with a small `shardByteCap`, so the plateau cannot be
rediscovered by a customer.

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
`a brain with a year of channel-day notes still surfaces its own recent notes
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

### Contacts: one page per person, and a merge never rewrites history

`0-inbox/contacts/<person-slug>.md`, one stable note per canonical person or
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

The check is `a name-only match never merges two contacts`.

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

The second half is **not** closed here and is named so the sibling work does
not discover it as a bug: **Google returns a grant covering exactly what was
requested.** An "add Calendar to my existing connection" flow that asks for
`scopesForProducts(["calendar"])` alone gets back a refresh token that no
longer covers Gmail, and — because the row's scopes are honestly recomputed
— records a `gmail.scopes` of `[]` beside a `products` still listing
`gmail`. That is the true state written down rather than hidden, which is
the point, but it is still a broken Gmail sync. The flow that adds a product
must request the **union** of every product already on the row plus the new
one (`scopesForProducts` already takes an arbitrary list, which is why this
is an extension and not a migration), or set `include_granted_scopes=true`
on the authorize URL. `googleAuthorizeUrl` does not set it today and should
not start doing so silently: which of the two mechanisms is used is a
decision for the change that first needs one.

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

**What phase 1 does NOT wire up, named so it reads as scope rather than a
gap**: `apps/mcp/src/communications/gmailSync.js` takes its Gmail socket, its
access token and its `ContextStore` as parameters and is tested end to end
against a fixture Gmail server and an in-memory store — but nothing yet calls
it from a live Worker, and nothing yet mints that access token over the
network. `functions/googleConnect.ts`'s `mintGoogleAccessToken` is a real,
tested internal action, reachable today only from a test; a live sync needs
the same two things `/gateway/ingest/binding` already is for the email worker
— an internet-facing route on the control plane the gateway can call with its
own secret, and a scheduled trigger on the gateway side to call it — and
building both is exactly the shape `docs/decisions/search.md` already uses
for its own phase boundary ("decided here and built in phase 2"). Until then
the control plane can connect a mailbox and the gateway can render one
correctly; nothing yet makes the second happen automatically for a real
person.

### What is deliberately not built

Named so that a future reader knows these were considered rather than missed:
per-message notes (16,000–292,000 notes per person per year — the storage
estimate rejects it numerically); a cross-day thread *file*; a
communications-specific privacy tier or grant scope; a workspace or team
inbox; reply, send, archive, delete or mark-read (v1 is read-only, and the
mail client stays the mail client); a second inbox root; a search path that
does not go through `searchIndexedNotes`; and any note in this tree that is
not an ordinary note at an ordinary path.

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

**Full Disk Access is attempted, never requested — there is nothing to
request.** Unlike the microphone or Screen Recording
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
