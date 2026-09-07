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
amended in the same commit as the code. Phase 1 ships the rendering, the
anchors and the recognisers, and does not touch the index. The check that will
matter is `a term in the last message of a large day is found`.

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

### Retention: raw MIME is off by default, and attachments are metadata-only

- **Raw MIME is not stored.** The normalized text is what every reader — the
  person, the index, the model — actually uses, and the storage estimate puts
  raw at several times the normalized size for fidelity nobody has asked for.
  It is a per-connection opt-in, quota-bound and off, with the bytes going to
  a plumbing prefix rather than beside the notes if it is ever switched on.
- **Attachments are described, not copied.** Filename, content type and size
  are rendered under the message; nothing is fetched. Storing them is opt-in
  and reuses the mechanism that already exists rather than inventing a second
  one: `.images/<sha256>.<ext>`, keyed by the digest of the bytes and nothing
  else, so the same file arriving twice is one object and there is no place in
  the key for a sender-chosen string. Types the gateway cannot serve back are
  never written — bytes with no way out of the bucket are somebody else's
  files on the customer's storage bill.
- **Deleting a mailbox deletes its folder.** One prefix, one delete, and the
  control-plane sync state goes with it. Because the mailbox is a folder
  (above), this is a real operation rather than a filtered scan — and because
  the notes are the customer's, the offer is "disconnect and keep" as well as
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
4. **Raw MIME and attachment retention defaults** — **the owner's call.**
   Recommendation: raw MIME **off**, attachments **metadata-only**, both
   per-connection opt-in and quota-bound, as argued above. This is the one
   with a legal dimension as well as a storage one — a full mail mirror in a
   bucket changes what a subpoena reaches — and it is not ours to default on.
5. **Do user-created contacts override later Google People changes?** —
   *recommended and taken*: **yes, the person's edit wins, and the conflict is
   shown rather than resolved.** A field the person typed is never overwritten
   by a later import; the import adds what is missing and records a
   "People says X" line next to a field where they disagree. Silently
   overwriting a preferred name because a directory somebody else administers
   changed is the failure that makes people stop trusting the page.

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
`isReactionRow` always answer `false` — 6 checks fail, none of them about
tapbacks specifically, because the folded rows fall back to being read as
ordinary (empty) messages and are dropped by the no-content rule instead,
which is itself a second finding worth naming: a broken fold degrades to
silently losing the reaction rather than corrupting a note.

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
