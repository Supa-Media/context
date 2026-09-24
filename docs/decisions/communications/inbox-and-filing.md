# Communications — inbox and filing

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
  the layout every existing workspace was scaffolded with and the one `privacy.md`
  carries folder rules for. A second inbox root beside the first is two
  inboxes: two places an unfiled thing can be, two folder rules to keep in
  step, and a `0-inbox` that quietly means "everything except mail".
- **The meeting-capture decision of 2026-09-07 already settled what goes in
  it.** *"`0-inbox` is where unfiled things arrive and what arrives there is
  sorted by what it is — `0-inbox/meetings`, `0-inbox/sessions`, mail beside
  them"* ([meetings](../meetings.md), *A meeting lands at an ordinary path*).
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

### ...and the default a connection is given is that folder, not a second string

The rule above binds the package. It did not bind the **control plane**, which
carries its own `defaultGoogleDestinationFolder` — the folder a connection
syncs into until somebody opens the destination field — and that function
spelled all three answers out longhand. Gmail's and Calendar's matched. Chat's
read `2-areas/communications/daily`, and nothing anywhere compared the two, so
**every Google Chat connection that had never had its destination changed wrote
its days outside the Inbox**: outside the folder this file decided, unrouted by
`classifyCommsPath` (the console listed the days as plain files rather than
drawing a channel), uncollapsed by `classifyCaptureKind` (so a week of
automated chat paperwork crowded out `orient`'s recency list, which is the
exact failure *A firehose is not attention* exists to prevent), and — in a
bucket where an older importer had left a generated `2-areas/communications/contacts/`
— filed beside a second contacts folder, so the product's own `0-inbox/contacts`
looked like the duplicate.

A default is not a smaller thing than the layout it defaults to. It is the
layout, for everybody who never opened the field, which is most people. So the
three branches are the package's constants now, and the checks compare each
default to **the key the package writes when a pass is handed no folder**
(`channelDayNotePath`, `calendarDayNotePath`) rather than to a constant:
two constants agreeing only proves they were typed on the same day.

**What reversing this costs**: a second spelling of a folder name whose first
spelling is in `protocol.js`, discovered by a customer reading their own
bucket, which is how this one was found.

**Changing it moves nothing already written.** A pass that ran under the old
default leaves its days where they are, exactly as changing the destination in
the console does — `updateGoogleSyncDestination` patches the row and never
touches the bucket. The notes are the customer's; relocating a folder of them
is `move_folder` and their decision, not a migration this product performs on
its own.

**The tests that fail if this is reversed**: `"the default destination folder
is the package's answer, not a second one"` in
`apps/convex/__tests__/googleConnect.test.ts`, `"a chat connection nobody has
configured files its days in the Inbox"` in `chatProduct.test.ts`, and the two
end-to-end Chat passes in `googleSyncLoop.test.ts` — five checks, confirmed by
putting the old string back.

### A day is filed under `YYYY/MM/`, and the date stays in the filename

**Reversed on 2026-09-18, by the owner, and the section it reverses is kept
below** — because the argument it made is still true and is now simply
outweighed. Read both.

What changed is not the reasoning, it is the weight: a channel day is one file
per active day and **nothing ages out**, so a mailbox synced for three years is
a folder with eleven hundred files in it, and `0-inbox/email/<mailbox>/` is a
folder the customer opens in Obsidian, in Finder, and in whatever sync client
they point at their own bucket. "A listing is not how anybody reaches a day of
mail" is right about *reaching* a day and says nothing about what that folder is
like to live with. The owner weighed the two and chose the folders. So:

    0-inbox/email/<mailbox>/2026/09/2026-09-07.md
    0-inbox/calendar/<account>/2026/09/2026-09-07.md
    0-inbox/google-chat/<account>/2026/09/2026-09-07.md
    0-inbox/imessage/2026/09/2026-09-07.md

**The filename keeps its whole date.** Not `07.md`: a note in a search result,
behind a shared link, or in somebody's Daily Notes pane has to say what it is
without its folder, and a note somebody *moves* has to keep saying it.
`isMeetingNotePath` has accepted exactly this shape since meetings were filed
this way, so the two recognisers agree rather than disagreeing in a new place.

**Meetings stay flat, and that is not an inconsistency.** The dated tree was
built for meetings, used, and removed as unusable ([meetings](../meetings.md),
same section) — a person who records twice a month got two directory levels per
note, every folder holding one file. A meetings folder grows at the rate
somebody records; a channel folder grows one file per day whether or not
anybody does anything. Different rate, different answer.

**Forward-only, so both shapes are read forever.** Nothing already written
moves: the notes are the customer's, and moving a year of them is
`move_folder`'s job and their decision. This is the branch the section below
refused, on the premise that *no bucket anywhere holds a channel-day note* —
true when it was written, false now. And it needs one more rule than "read
both", because a day is **regenerated** on every pass rather than appended to:
a day that already exists flat and is next written in the tree would not
continue, it would exist twice under one date. So a writer asks the bucket
first — `apps/mcp/src/communications/dayPlacement.js`, and `flatDayPath` in the
package — and **a day that already has a note keeps it**. The switch lands per
day, not per deploy: a bucket synced yesterday has no seam at all.

The console follows the same rule when reading: after `parseChannelDayPath`
recognizes either shape, the day view reads part 1 and every sibling part from
the selected note's actual folder. Reconstructing the newer dated path from the
date would accept a legacy flat note as a route and then ask the bucket for a
different key, falsely rendering a healthy note as unreadable.

The checks are `a day already filed flat is written flat, not moved into the
tree`, `...while a day the same bucket has NOT seen is filed under its month`,
`a date folder that disagrees with the filename is nobody's note`, and `a
legacy flat day is read from the path that was selected`.

### The account level reaches Calendar and Chat

Same date, same reason the mailbox folder exists, and it closes a real hole:
two connected Google accounts wrote **one** `0-inbox/calendar/2026-09-07.md`
between them. It read correctly — every event names its account — and it cost
the thing the folder was for. `visibilityOf` is longest-matching-prefix over
folder defaults, so a folder is the only unit that can say "this account, and
everything in it, forever". Merged, "my work calendar is team and my personal
one is private" was not expressible at all, at any number of lines in
`privacy.md`.

The slug is Gmail's when Gmail has one, so one account is one folder name
across all three products, and it is **recorded** in the connection's
`destinationFolder` at connect and never recomputed — a later connect or
disconnect cannot rename the folder somebody's calendar is already in. A
connection bound before this keeps the folder its row names, which is what
makes this forward-only too: `defaultGoogleDestinationFolder` with no slug
still answers the folder these products have always used.

The check is `calendar defaults to this account's own folder under the calendar
folder`, and its pair `...and a connection with no recorded slug keeps the
folder it has always written to`.

### There are no `YYYY/MM/` folders, and the date is the filename

**Superseded on 2026-09-18 — see the two sections above.** Kept because its
argument is the one that has to be outweighed again by anybody who wants to
reverse the reversal, and because its last paragraph is exactly the rule the
new layout had to break and says why that was expensive.


The scoping note nests `2026/09/2026-09-07.md`. **That tree was built here
once, used, and removed as unusable**, and the argument against it is already
written down ([meetings](../meetings.md), same section): two directory levels
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
`support@` the company's domain ([identity & access](../identity-and-access.md),
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
