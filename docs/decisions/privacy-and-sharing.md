# Privacy, visibility, and sharing

_Moved out of `CLAUDE.md` verbatim. See `docs/decisions/README.md` for the index._

### Link previews reveal nothing about a context

A crawler is unauthenticated, and Context has no public tier. Every
name-bearing path renders one frozen object — same title, description and
image, canonical pointing at the root rather than the requested URL. Nine
variants are asserted equal by whole response body.

A "nicer" preview showing an owner or a note count would hand anyone in a Slack
channel an existence oracle for usernames, undoing what the control plane's
byte-identical errors exist for.

### A share link's preview may carry a title; nothing else's may

`Link previews reveal nothing about a context`, above, is unchanged for every
path it was written about, and its nine-variant byte-equality test still passes.
This is a second rule beside it, not a hole in it, and the difference is one
word: **guessable**.

`/@seyi` is guessable, so a nicer card there is an existence oracle for
usernames — which is what the control plane's byte-identical errors exist to
deny. A share link is `/s/<64 hex>`: 32 bytes from `crypto.getRandomValues` the
owner deliberately handed to one person. The premise the frozen card protects —
"the requester may not have been meant to have this URL" — does not hold, and
the product need it was blocking is real. A link that unfurls as bare branding
does not get clicked, and a share nobody opens is a share that did not happen.

The cost is real too, was accepted deliberately by the owner, and should not be
rediscovered as a bug: **anyone holding the URL learns the title without signing
in** — everyone in the channel it was pasted into, everyone on the forwarded
thread, the corporate link scanner. Content still needs authentication and a
live grant.

Five things carry it, and each fails a test if removed:

- **The title is never read from the note.** It is owner-chosen or derived from
  the filename (`functions/lib/shareTitle.ts`). A title taken from the body
  would mean an anonymous crawler triggering a GET against the *customer's*
  bucket on every unfurl, and would put note content in the control plane, which
  non-negotiable #1 forbids. A path is metadata; this is derived from one.
  `sharePreview.test.ts` proves a preview resolves with no storage connected at
  all, so this cannot regress quietly.
- **Every absence is one absence.** Unknown token, revoked, expired, title
  switched off, title that normalised to nothing — all `{ title: null }`, and
  `previewForShare(null)` renders GENERIC_PREVIEW byte for byte. That is what
  keeps revocation invisible: a crawler cannot tell a share that was taken back
  from one that never existed.
- **The shape is checked at the edge, before any lookup.** `shareTokenFrom`
  accepts 64 lowercase hex characters and nothing else, so `/s/<garbage>` never
  reaches the control plane and the obvious probe never gets a round trip to
  time.
- **One field, bounded twice.** The route returns `title` alone; the bound is
  applied in the control plane *and* again in the router, because an edge that
  trusts its upstream to have been careful has no bound at all.
- **`noindex` survives.** `X-Robots-Tag` on the response and the meta tag in the
  body. A card with a title is still not search-engine material.

**A published card cannot be taken back, and an earlier version of this section
implied otherwise.** It said revoking "makes the card frozen again", which is
true only of *future* crawls. What was verified afterwards: Discord and WhatsApp
copy the image onto their own CDNs, so a 404 at our origin leaves their copy
intact; iMessage bakes `LPLinkMetadata` into the sent message client-side with
no re-fetch path and no cache to bust; Facebook states outright that "images are
cached based on the URL and won't be updated unless the URL changes"; X caches
for seven days.

So the honest rule is: **treat anything that reaches a card as permanently
public.** Revocation is enforced at the destination page, where it works
immediately and completely; it is not, and cannot be, enforced on a card that
has already been unfurled somewhere. That is a reason to keep the card's
contents minimal — a title and nothing else — rather than a reason not to have
one.

`POST /share/preview` is therefore a route in `http.ts` that requires no secret.
`UNAUTHENTICATED_HTTP_ROUTES` in `__tests__/structure.test.ts` enumerates them,
pins the list by name and order, and asserts the handler returns nothing but the
title. It held exactly one when this section was written and holds three now;
each entry needed the whole argument above made again, on its own terms, and a
fourth still does.

**The third entry is the only one whose argument is guessable, and that costs it
the folder.** `shareNotePreview` answers `/@name/<path>` — an address anybody
can type — so the guessability hinge does not do for it what it does for
`/s/<64 hex>`. What keeps it inside the rule is that it answers only for a path
the owner explicitly team-linked, which bounds the probe to the set they already
chose to publish. That bound is only as good as the space being probed, and
**the product writes a lot of that space itself.** `scaffoldFiles` lays down
`privacy.md`, `index.md` and a `README.md` in each of the five PARA folders, the
five folder names are documented in this file, and the connected-client house
rules put a `todo.md` at the root. So a fresh brain arrives with roughly a dozen
addresses anybody can guess without knowing a thing about its owner, and a
handful of guesses per handle is an exhaustible space.

Every one of those is refused and unfurls as the generic card. A name the
**owner** chose is not guessable and may carry a title, which is the whole
feature. `createTeamShare` still takes any of them and the link still works —
describing one to an anonymous crawler is the separate question.

**And it is no longer only what a fresh brain arrives with.** The gateway names
folders *after* creation: where `save_context` files a session
(`4-archive/chat-history` or `0-inbox/sessions`, chosen by whether the manifest
declares a `4-archive` rule), and where a capture with an `external_id` lands —
`0-inbox/<slug of its source>`, which is ours for the hook's three client ids,
for `POST /inbox`'s default, for the Granola webhook, and for the fallback
`safeSlug` uses when a source has no Latin alphanumerics at all. Plus the one
path the single-tenant calendar cron hardcodes. Every one of those was
previewable at some point, each found after a fix that read as complete.

Three residuals are named rather than argued away. The platform folder beneath a
session folder (`<folder>/<platform>`) is ours too, and is **not** refused: the
segment is caller-supplied and the set unbounded, so it cannot be enumerated,
and `save_context` takes a `destination` that puts it under owner-chosen names
anyway. The guards that tie the list to its writers read one input each — the
hook roster, not the `hook:` prefix; one literal `store.put` form, not a
template literal — so a *computed* new path is caught by nothing. And
`0-inbox/inbox`, `0-inbox/granola` and `0-inbox/capture` have no writer-driven
check at all; they are pinned only by the router mirror, which reports that the
two copies disagree and never that both are short.

An earlier version of this paragraph said the space was "five" and that "a note
filename is not" guessable. Both were wrong, and wrong in the way this file
warns about: counted once, for folders, and never recounted when the rule was
written down as a general one. `isProductMandatedPath` is the list, and its test
drives `scaffoldFiles` rather than restating it, so a new scaffolded file cannot
quietly become a new guess. `infra/router/src/preview.ts` keeps a second copy
because it is a separate deployment and cannot import the first; a test reads
that file and asserts the two agree, rather than a comment saying they do.

One entry is not on the product's own authority and is labelled that way.
`todo.md` is a name the owner chose — `apps/mcp/src/index.js` deliberately
removed the `todo.md` and agent-ledger conventions from the server instructions
as "one customer's house rules" — and it is refused on the weaker ground that it
is a guess anybody would make. That argument is unbounded (`notes.md`,
`journal.md`), so the list stops at one entry and the residual is stated rather
than papered over: a generic filename the owner picked is still previewable.
The `custom` scaffold template is out of scope for the same reason in reverse —
its folder names are the owner's, so nothing about them is guessable.

The rule is enforced in `previewForNote` (the control plane, where it counts)
and restated in `infra/router/src/preview.ts` (which only saves the round trip).
Two copies of a rule are held here the way two copies are always held: by
running both against the same shapes, not by trusting the comment between them.

### A folder link may also name two or three things inside it

The section above is unchanged, including the sentence that costs
`shareNotePreview` the folder: a name the product wrote is refused, contents and
all. This is a third rule beside it, and it is about a different field.

`/console/@seyi?note=1-projects/transition` unfurled with one word — the
folder's own name — and a card that says one word is barely better than the bare
branding it replaced. A folder link now carries a folder mark and up to three of
the **team-visible** notes and subfolders inside it. That is the most sensitive
string this product publishes: the names of somebody's notes, to an anonymous
crawler, at an address anybody can type. Seven things hold it, and each fails a
test if removed.

- **Only a folder the owner explicitly team-linked carries anything.** This is
  not a new bound, it is the one `previewForNote` already ran on: a live
  `members` row is required, so a folder nobody linked is byte-identical to one
  that does not exist. Pressing Copy link is what writes the row.
- **The names come from the privacy engine, not from a predicate written here.**
  `snapshotChildren` calls `listFolder` at **`team`** scope — the same engine
  the console and the gateway read through — so `canSee` and
  `folderVisibleAtScope` have dropped every private note and every private
  subfolder before `previewChildrenFrom` is called at all. A second filter would
  be a second place for a visibility bug, which is the rule the two search
  dialects already follow. Sabotage that one word to `private` and the wiring
  test fails; the derivation tests do not, because they name the scope
  themselves, and that gap is why the wiring test drives a real bucket end to
  end.
- **Nothing counts what was dropped.** Three names and no `+N more`. A total
  over the *visible* set is safe; a total over the folder is an existence oracle
  by subtraction — exactly what the console's note census is owner-only to
  prevent, and what search computes its own totals from the visible list to
  avoid. The temptation here is obvious and the answer is no: if a count is ever
  wanted it comes from the same filtered array the names come from and from
  nowhere else.
- **An unfurl still reads no bucket.** The listing is taken once, when the owner
  makes or refreshes the link, and stored on the row beside the title.
  `previewForNote` is a `query` and therefore *cannot* reach storage, which is
  the structural version of the argument `lib/shareTitle.ts` makes for the
  title: a crawler is anonymous, uncontrolled and endlessly retrying, and making
  one spend a request against the customer's own bucket on their quota is not a
  cost they agreed to. `sharePreview.test.ts` proves a preview resolves with no
  storage connected at all, so this cannot regress quietly.
- **It is a listing and never a body.** Keys are metadata the way a path is;
  note content in the control plane is what non-negotiable #1 forbids.
- **Every absence is one absence.** Unknown, revoked, expired, title switched
  off, never linked, a note, an empty folder, and a folder whose contents are
  all private are the same `{ title: null, cardToken: null, children: [] }`, and
  `previewForNote(null, null, [...])` at the edge renders GENERIC_PREVIEW byte
  for byte. Contents arriving without a title publish nothing: the title is what
  licenses a card to say anything, and that is the shape a compromised or
  newer-than-this-deployment upstream would take.
- **Bounded three times, and `noindex` survives.** Bounded where the list is
  written, again where the row is read, and again at the edge — because an edge
  that trusts its upstream to have been careful has no bound at all. A filename
  is a key out of a bucket we do not own (Obsidian, rclone and the provider's
  console all write keys directly), so control characters are stripped where the
  value is taken rather than escaped where it is read: `escapeHtml` handles `<`
  correctly and has nothing to escape a newline in an `og:description` *to*.

**What this costs, stated rather than left to be rediscovered.** The contents
are frozen at link time exactly as the title is, so a child that was `team` when
the owner pressed Copy link stays on the card after they make it private.
Re-linking re-takes the snapshot and revoking takes the card back — for *future*
crawls only, because a card already unfurled cannot be retracted at all. Live
re-checking would mean an anonymous crawler triggering a LIST against the
customer's bucket on every unfurl, which is the cost the previous point refuses;
that trade was made in that direction deliberately.

**And the half of what was asked that was not built.** The link that started
this was `/console/@seyi?note=3-resources`, and `3-resources` still unfurls as
the generic card, contents and all. It is one of the five names `applyStructure`
writes into every brain this product creates, so `isProductMandatedPath` refuses
it — and the argument for that refusal gets *stronger* here rather than weaker.
Naming what is inside a guessable address turns a handful of guesses per handle
into a listing of somebody's notes, which is a categorically worse leak than the
existence bit the refusal was written for. A folder the **owner** named is not
guessable and carries its contents, which is the whole feature; the fix for the
link he actually pasted is to link a folder he named, not to relax the list.
Relaxing it "just for the title, not the contents" is the compromise to expect
and it is worse than either end: it re-opens the oracle the list closes and
delivers a card that says one word.

`UNAUTHENTICATED_HTTP_ROUTES` is **still three**. The contents are a field on
the route that already answers this address rather than a fourth route, so the
argument that had to be made three times has not had to be made a fourth — and
`structure.test.ts` now reads that handler back and pins its three fields by
name, refusing a spread, because the failure to expect on an unauthenticated
route is a field added upstream arriving here by a spread nobody looked at.

One implementation detail is load-bearing enough to name. The card image's key
is a hash of **everything drawn on it** (`cardSignature`), not of the title
alone, in the control plane's copy and the router's mirror alike — otherwise a
re-linked folder keeps serving a picture of the contents it used to have, since
the Workers cache is per-datacenter and a changed URL is the only invalidation
there is. An empty child list hashes *exactly* as the bare title did, so no
existing note share renames its card and re-publishes an identical picture. The
two copies are held the way two copies are always held here: by running both
against the same shapes.

### An unlisted share is the third audience, and it is one row rather than a tier

Asked for by the owner (2026-09-01) with the cost stated in front of them, and
recorded here because the shape of the answer matters more than the feature.

The ask was "three scopes: private, team and public". The thing that was
actually built is a fourth `recipientKind` on the share row that already carried
`name`, `email` and `members` — `anyone`, meaning nobody is addressed and nobody
signs in. **Not a third value in `privacy.md`**, and that is the whole design:

- The manifest is the stable on-bucket format (#3) and the gateway fails
  **closed** on a rule it cannot parse. A third word in it makes every note in
  the bucket read private for anybody on an older deployment — a rollback that
  silently takes a customer's whole context away rather than one that loses a
  feature.
- `Scope` in both privacy engines stays two-valued, so an anonymous request
  never flows through `canSee` as a clearance. What licenses the read is a token
  lookup that resolves to one row over one path; the *visibility* question is
  still asked and answered at `team`.
- Everything the existing share model already proved carries over unchanged
  rather than being re-argued: owner-only to mint, revocable, capacity-capped,
  and re-derived from the live `privacy.md` on every read — so a note made
  private is absent through an unlisted link exactly as it is through a personal
  one, and there is nothing stored on the row that could disagree.

**What it genuinely costs, stated rather than left to be rediscovered.** An
anonymous reader has no name, so revocation stops *future* reads and cannot
retrieve a copy already taken — the same honesty the share card's own section
arrives at, one step further along, because this time it is the note's text and
not its title. The owner was told this before deciding, chose it, and the answer
to somebody proposing to "fix" it by adding an expiry or a view count is that
neither un-publishes anything.

Four things hold the line, and each fails a test if removed:

- **One uniform anonymous refusal.** `readSharedNote` reads the session rather
  than requiring it and lets `authorizeShareRead` decide whether an absent
  caller is enough — which it is for exactly one kind. So an invented token, a
  personal share, a members-only link and a revoked unlisted link are one
  `NOT_AUTHENTICATED`, and a holder cannot learn whether a link ever existed or
  has been taken back. Dropping the null-caller guard in `shareStillStands` does
  not compile, which is the strongest form this file asks for.
- **`openToAnyone` is reported, never inferred.** The viewer has to withdraw a
  note when a session drops *and* keep showing one that never needed a session,
  and deriving that from "is there a session now" gets one of the two wrong
  whichever way it is written. The first of those is a property this repo
  deliberately fixed once — `note` is component state and survives the auth flip
  — and the obvious version of this change would have quietly taken it back.
- **The creation-time check is a courtesy and is proved to be one.**
  `createLinkShare` is an action so it can refuse over a note the team cannot
  read, which matters here in a way it does not for a personal share: an
  unlisted link is pasted into a channel, and one that silently resolves to "not
  available" for everybody is indistinguishable, from the owner's side, from
  having published something. Sabotage it and only its own test fails.
- **The cycle is private → team → anyone → private.** Closing revokes the link
  *before* it narrows the manifest, because a failed revoke after a successful
  narrowing leaves a private note with a live public link on it; the sequence
  stops at the first failure; and a private note draws a padlock however many
  rows point at it, because a globe over a note nobody can open is the control
  lying in the one direction that matters.

  **This paragraph used to claim the control "cannot publish in one press", and
  that was only ever true of a private note.** Measured on the real functions:
  from `team`, one press runs `[{ openLink: true }]` — a note the whole team can
  already read goes to the internet in a single tap on an unlabelled 20pt
  target whose icon beforehand is an *open padlock*, which reads as "shared with
  my team". There is no confirmation, and the undo overshoots: `nextScope`
  from `anyone` is `private`, so recovering from a mis-tap also un-shares the
  note from the team. Whether to put a confirmation on the `team → anyone` step,
  or take `anyone` out of the lock cycle now that the unlisted link has its own
  control in `ShareDialog`, is an open product decision — but the sentence
  claiming it is already safe is not the answer, and a reassurance a reviewer
  would trust is worse than none.

The icon is a globe rather than a wider-open padlock. Shut and open are two
states of one object and read as *degrees* of the same thing, which is right for
"me" versus "my team" and wrong for "and now people I have never met".

**A link says what it points at, and the readable half is decoration.**
`/s/<64 hex>` says nothing, and a URL that says nothing is one people paste
without knowing what they are sending and open without knowing what they are
opening — so a link carries the note's name in front of its token, Notion's
shape: `/s/Chapter-transition-<64 hex>`. Four things about that:

- **The token is still the whole capability and the whole entropy.** Nothing
  looks the slug up, so a renamed note does not break a link already sent, and
  two links with different slugs are the same link when their tokens match.
- **It is read off the end**, with one hyphen in front of it, in both copies of
  the rule (`shareTokenFromSegment` in the app, `shareTokenFrom` in the router).
  Anchoring rather than searching is what keeps the parse unambiguous — a slug
  is whatever somebody called their note, so it can contain hex, and a search
  would let a title decide which token was looked up. The two copies are held
  the way two copies are always held here: `shareSegment.fixtures.json` is one
  corpus both suites run.
- **A bare 64-hex path stays valid**, because every link minted before this
  existed is that shape and they are live in other people's messages.
- **`titleInPreview: false` means no slug.** Switching the card's title off is
  the owner saying they do not want this note named to somebody who has not
  opened it, and the URL is seen by *more* people than the card is — it survives
  every forward. A slug there would undo the setting through a different door.

**The card *image* still says the opposite, and fixing it has a trap.**
`CARD_SUBTITLE` in `lib/cardArt.ts` is the constant "Shared with you — sign in
to read it", and `cardElement` takes no `openToAnyone` — so the meta description
was corrected and the picture beside it was not. Whoever makes the picture
honest **must add `openToAnyone` to `cardSignature`, in the control plane's copy
and the router's mirror both**, or every already-rendered unlisted card keeps
serving the "sign in" image forever: the Workers cache is per-datacenter and a
changed URL is the only invalidation there is. It is safe to omit *today* only
because the flag changes nothing that is drawn, which is precisely the premise
that fix removes.

**And the card had to stop telling unlisted readers to sign in.** The
description read "Sign in to read it", which was true of every share there was
and is false of this one; a card that asks a stranger for an account they do not
need is the product being wrong on the first surface they see, in the way that
stops a link being opened at all. `previewTitleForToken` therefore returns
`openToAnyone` beside the title — the second field on an unauthenticated route,
and it had to earn that the way the third route did. It discloses nothing a
crawler could not learn by following the link it already holds, and it is
`false` for **every** absence, so an unknown, revoked, expired or title-less
share is one byte-identical *tuple* rather than one field that matches and one
that does not. The router defaults it to the sign-in wording, so an upstream
older or newer than the edge asks for a sign-in rather than promising access.

**A share page is read-only, structurally, and only one reader is offered a way
out.** The feature holds one Convex action and renders parsed markdown; no
mutation, no write hook, no file operation —
`apps/mobile/__tests__/shareReadOnly.test.ts` reads the files and says so, with
its own self-test, because "there is no Save button" is the kind of property
that stays true until somebody adds one to a page they were looking at anyway.
The exception is the person who *wrote* the note and opened their own link, for
whom the page is their own document behind glass: `editableInContext` names the
context, and it is decided by the server from the reader's own membership and
never by the client. `member` is deliberately not enough — the console is
read-only for that role too, so the button would lead to the same glass — and it
is resolved live, because a route offered on the strength of a role somebody
used to have is a button that leads to a refusal.

**A folder has no third position**, and that is a boundary rather than an
omission: `createLinkShare` runs the note-only `checkSharePath`, so what a
folder link would reach is a scope nobody has designed. Do not answer it by
loosening the path check.

Two things a tidy-up would get wrong. The gateway's own copy no longer claims
"there is no anonymous or internet-public visibility", because that sentence
became false the day this landed and a server contract that says something false
is worse than one that says less; what it says instead is the narrower claim
that survived intact and is what a connected client actually needs — visibility
is private or team, and *nothing on that connection* can publish past the people
the owner named. And `noteUrl` still returns a `context://` URI: an unlisted
link now exists, but this connection is not told which notes have one, and
putting a real URL there would republish somebody's deliberate hand-off into
every search result.

### `privacy.md` is generated, and the console can generate a fresh one

A bucket whose manifest is missing or unparseable fails closed — every note
reads private, `mutateManifest` refuses every write — and until now it also had
**no exit**. Every write path in the product refuses that key: `writeFile`
answers `PRIVACY_MANIFEST_READ_ONLY`, the gateway's `write_note` answers "that
path is reserved", and `set_folder_visibility` answers "privacy.md is required
before folder visibility can be changed". The console's banner nonetheless told
people to "write a valid privacy.md at the root of the bucket, or ask a
connected AI client to" — two impossible things, in the one state where nothing
else works either. The real exit was rclone or the provider's web console.

`resetPrivacyManifest` is the exit, and it is not an exception to "generated,
never typed into" so much as the floor beneath it: it takes no content, so
there is no argument to it by which a note could change hands. Four things are
what make it safe, and each fails a test if removed:

- **It refuses a manifest that parses** (`PRIVACY_MANIFEST_USABLE`). That is
  the whole safety argument — it can never be how a curated access map gets
  flattened — and the state it *does* act on is exactly the one the banner
  reports, `manifestUsable === false`.
- **Every folder is written `private`.** The bucket was already failing closed,
  so all-private is the one rewrite under which nothing changes hands.
  `renderPrivacyManifestForFolders` takes no visibility argument on purpose;
  adding one would make repairing a typo a way to publish a bucket.
- **Owner clearance only**, checked at the action (`minimum: "owner"`) and
  again in the module a test can drive without a session.
- **The unreadable file is kept** in `.context/recover/`. A manifest usually
  breaks on one line, and the other forty are the owner's record of what was
  shared. It moved out of `.history/` when snapshots stopped being written: this
  is now the only copy this product keeps of anything, and it earns that by not
  being recoverable from the notes or from the customer's own versioning. See
  [storage-and-credentials](./storage-and-credentials.md).

It declares the bucket's **real** top-level folders, not the five PARA names,
because the case this exists for is a brain that arrived with a hand-edited
manifest — `0-inbox … 4-archive` over somebody's `Journal/` and `Clients/`
hands them a file with no line to edit for any folder they have.

**And a bucket key is not a manifest rule.** That is the part that looked like
plumbing and was a hole. Nothing guarantees a key came through our own path
validation — Obsidian's sync plugin, rclone and the provider's console all
write keys directly — so a folder called `2026: notes` writes a line the parser
rejects (leaving the manifest broken with the one exit spent), and one called
`innocent\n  2-areas: team\n#` appends its own rule, which is a privilege
escalation written into a folder name. `writableAsRule` therefore **renders one
rule and parses it back with the real parser**, accepting the folder only if
exactly one rule comes out naming exactly it. Not a character blacklist: a
blacklist is a guess about a parser that has a comment stripper, a
trailing-slash tolerance and a dot-segment rule, and a colon blacklist passed
every test written before this one. A folder that fails is left out rather than
blocking the repair, so it inherits `default_visibility: private`, and
`partial` says the list is short — a short list is never printed as a complete
one, the rule `noteCountTruncated` already follows.

The gateway still cannot repair a manifest, and that is fine but should be
deliberate: `privacy.md` is `isPlumbing` there, so an AI client can neither
write it nor be tricked into rewriting one. The console — a person, signed in,
who owns the context — is the only place this happens.

### The visibility tier is displayed, never stored

A person given access to somebody else's context sees only `team` notes, and
that is enforced twice already — `visibilityTierForGrant` in the gateway and
`scopeForRole` in the control plane, both answering "team" for any role that is
not owner before consulting anything else. The console shows it and stores
nothing: a tier stored twice is a tier that can disagree with itself, and the
direction it fails is "an AI client reads more than the person allowed".

The chip lives in the frame beside the storage pill rather than in each pane
head, because the tier is a property of the context you are in rather than of
the route. It is gated on being inside a context while the storage chip is not,
and that asymmetry is deliberate: on an all-contexts route you may hold three
different roles in three contexts, and the wrong direction for one chip to be
wrong in is "you are seeing everything".

The owner's side states the rule and never a count of what is withheld. There
is a note census now (see "The note count is measured" below), and it is
**owner-only for this reason**: it counts every Markdown file in the bucket,
private ones included, so handing it to a member would let them derive exactly
how much they are not being shown — an exact private-note total for a person who
deliberately shared a subset. `getStorageBinding` withholds the three census
fields from anybody whose role is not `owner`, and the console's total treats a
context it cannot count as an unknown, which makes the sum a floor rather than
silently dropping it.

### The audit trail's `details` are allow-listed, and its `paths` are not gated at all

`listEvents` is readable by every member, deliberately: the trail exists so the
people whose notes are involved can see what touched them. That makes the shape
of the gate over `details` the whole security question, and the first two
versions of it got it wrong in the two available directions.

**The gate is an allow-list. An action nobody has classified is withheld.** The
first version withheld `details` for actions named `ingestion.*`, which is a
deny-list and publishes by default — the shape `OVERRIDABLE_STORAGE_CODES` in
the console is written inside-out to avoid, so that a code added next year is
closed rather than open. It had already missed one that existed: `share.created`
records the address or handle the owner shared a note with, somebody who need
not be a member of anything and who is owner-only through `listShares`.

Three criteria keep an action off `MEMBER_VISIBLE_DETAIL_ACTIONS`, and the
second version of the list broke two of them **with its own entries**, which is
the argument for the shape rather than against it — an entry has to be defended
on the details it actually carries, and adding one is where that happens:

- **A third party's identity.** `share.created`, `share.revoked`,
  `member.invited`, `invitation.revoked`, and the `targetUserId` on
  `member.removed` / `member.role_changed`.
- **Owner-only configuration.** `ingestion.*` and `storage.*` are owner-only
  through their own APIs; a trail that republished them would be the hole
  rather than a second copy of the rule.
- **A count taken over what a member cannot see.** `privacy.reset` reports the
  bucket's real top-level folder count, and `file.move` / `file.copy` /
  `file.duplicate` / `file.archive` report `{ files: result.paths.length }`,
  which `keysUnder` expands at the **actor's** clearance. An owner archiving a
  `team` folder holding three team notes and three private ones wrote
  `files: 6` where the member could list three: the exact subtraction the note
  census is owner-only to prevent.
- **Anything another API answers only at a higher role.** `listGrants` is
  owner-only (it was `editor`+ when this was written, and the entry held for
  the same reason at both), so `grant.created`'s `{ scopes, tier }` on the trail
  republished it a rung lower. `grant.revoked` stays — its details name no
  scope, no client and no third party.

The count is withheld rather than dropped at the call site, so the owner's
record keeps it. `workspace.structure_applied` is on the list only because its
`folderCount` equals `paths.length` exactly today; it carries a note to be
revisited in the same commit that ever withholds `paths`.

**And `paths` is an open leak that this gate does not touch.** Stated here
rather than left to be rediscovered, because a draft of the code comment
*defended* it — "the folder is one a member can list" — which is false in
general and was the most dangerous line in that change. Measured through the
real actions and the real privacy engine: a read-only member whose `listFiles`
on `1-projects` correctly returns **zero entries** gets a hidden note's full
path out of `listEvents` three times over — from `file.create`, from
`visibility.note` (labelled `visibility: "private"`, so they learn it was
withheld from them), and from `file.delete`, which records `keysUnder(...)`
expanded at the owner's clearance and therefore names every private sibling.
That is `audit.ts`'s own module-header example handed to a member.

The fix is a design decision rather than a line, which is why it is open.
`canSee` needs the privacy manifest, which lives in the customer's bucket, and
a Convex `query` structurally cannot reach storage — `runFileOperation` is the
sole member of `CREDENTIAL_BARRIERS`, and this is the same constraint that makes
`previewForNote` snapshot a folder's children at link time. So the candidates
are: make `listEvents` an action (losing reactivity, and spending a bucket read
per trail load); stamp each row's visibility at write time (which a later
visibility change makes wrong); record the actor's *scope* and withhold `paths`
on rows written at `private` (same staleness, failing towards over-withholding);
or withhold `paths` from non-owners outright, which takes the trail's subject
away from it. Whoever picks one revisits `workspace.structure_applied` in the
same commit.

### A privacy decision is folded, and the fold only ever narrows

Every decision in both privacy engines is keyed on an exact path — `isPlumbing`
opens `key === PRIVACY_KEY`, `effectiveVisibility` is a `Map` lookup on the
note's own path. That is sound where one string is one object, which R2 and S3
are and **Dropbox is not**: `DropboxStore`'s header records that Dropbox "treats
`Foo.md` and `foo.md` as the same file and normalises Unicode", and that it
deliberately does not re-case a caller's key, because a store that silently
rewrote one would be worse than one that returns what Dropbox actually has.

That is the right call for the adapter, and it left the question one layer up.
Paths reach both engines from outside — a connected AI client's tool call, a
console request, and the bucket's own listing, where the file's real name may
differ in case from the manifest line that governs it. So the answer could be
chosen by whoever picked the string. Two were reachable: `Privacy.md` was not
`privacy.md`, so nothing reserved it and `write_note` rewrote the access map
through the one path that answers "that path is reserved"; and a note re-cased
inside a `team` folder missed its narrowing override while the folder rule still
matched, so it scored `team` and Dropbox returned the private file. `scopes.yml`
is not dot-prefixed either and rested on the same equality.

**The fold only ever narrows, and that is the whole safety argument.** A
`private` override travels to every path folding onto it; a `team` override
travels nowhere. Folding a widening was the first version of this fix and was a
*new* hole on the majority backend: on R2 and S3 `a/Foo.md` really is a
different file from the `a/foo.md` the owner published, so a folded `team`
override published notes nobody had named. It is the same argument that keeps
folder rules unfolded — re-casing a folder makes every prefix miss and the
`private` default takes over, while folding them would let a `team` rule match
folders its author never named — and the mistake was failing to apply it to
overrides. Two entries that fold together are one file on Dropbox and a
contradiction the owner never resolved; `private` wins, rather than whichever
line came first.

**A fold reads across case; it never writes across it.** Deleting an override
stays exact. The first version folded the delete too, so publishing
`1-projects/Notes.md` stripped `1-projects/notes.md`'s narrowing — consent taken
for one file and spent on another — and creating `2-areas/Report.md` silently
un-shared `2-areas/report.md`. Nothing in either suite noticed.

**And that costs a publish, which is currently reported rather than refused.**
The two rules above meet on one path: the fold reads across case, so a note
scores `private` from a twin's narrowing; the delete writes exactly, so
publishing that note removes nothing. The manifest comes back byte-identical.
What stops that being a lie is that the answer is **re-derived from the
manifest** rather than echoed from the request — `setVisibility` reports
`private`, and the note really is unreadable at team scope. The gateway's
`set_visibility` still answers "visibility changed", which is wrong, and
`.audit/` records it.

**Refusing the write outright is the right fix and is deliberately not here.**
It was built — a `foldedTwinBlocks` probe in front of six tools, a
post-condition throw, and reordered batch-mover rollbacks — and five adversarial
reviews found a defect in it every round, twice at High severity in code the
previous round had declared finished: a team-scope existence oracle in
`move_folder`, a fail-open publish through `set_folder_visibility`'s compaction,
a torn write in the batch movers, an `archive_note` guard deleted on a premise
that was false at team scope. The fold itself survived every one of those
rounds untouched. So the engine lands on its own and the write-path apparatus
comes back as its own change with its own review budget, rather than riding in
on the back of a fix that was ready. It is kept as
`docs/deferred/folded-twin-refusals.patch` with its five-round defect record
beside it — in the tree, because `main` is squash-merged and a branch is not an
archive.

Until it returns, three things are true and none of them is disclosure:

- **Publishing a note whose case-twin is private silently does nothing through
  the gateway and says it worked.** The manifest comes back byte-identical, the
  note stays unreadable at team scope, and `.audit/` records a change that did
  not happen. The console does not lie — `setVisibility` re-derives its answer —
  but the gateway tool does.
- **A `move_note` onto a case-variant destination reports `visibility: team`
  for a note that is unreadable at team scope.** It does something (the source
  is gone) and reports the opposite of what happened, so it is not covered by
  the sentence above.
- **An ordinary `write_note` with no `visibility` argument persists a new
  `private` override** onto a note whose case-twin is private, because
  `desiredVisibility` defaults to the now-folded effective visibility. It
  matches what the note already reads as, and it is a narrowing of a note the
  owner never named, written into their manifest by an edit.

All three fail closed and all three are worse than the refusals would be, which
is the cost of holding those back.

**One thing from that work did stay, because without it the fold is a
regression rather than a fix.** `set_folder_visibility` compacts away note
overrides that have become redundant for their own path, and since the fold
that same line is the only thing narrowing every path folding onto it — a note
in a differently-cased sibling folder, which the compaction loop cannot see and
which its impact report never scans. Dropping it published a private note and
said `newly_team_visible_notes: 0`. So no `private` override is compacted away
now, however redundant it looks. The first fix for this reasoned over folder
rules instead — a twin is only widened, it said, by a `team` rule governing the
folded path but not the exact one — and that is false: `visibilityOf` is
longest-prefix and the test was any-prefix, so one plain `team` rule governing
both the note and its twin, out-ranked for the note by the longer `private` rule
the same call adds, widens the twin and passes the test, on the default
scaffolded manifest, through "make this folder private". A `team` override that
has become redundant is still compacted; only narrowings stay.

Four things hold it. The first three fail a test if removed; the fourth is a
rule about how a helper may be used, which no test can state for it:

- **Both copies changed together.** A fix in one is the divergence, not the
  repair. `__tests__/privacyEngine.test.ts` runs the gateway's *actual*
  functions beside the port, so sabotaging `foldPath` in either copy fails the
  same checks.
- **No override is read by name without the helpers**, and that is enforced by
  reading the files rather than by discipline. Reverting all five `fileOps.ts`
  call sites to raw `Map` access passes 1430 behavioural checks and 167 fileOps
  checks — the twin only differs on a Dropbox-backed context, which no suite
  stands up — so `__tests__/privacyAccessors.test.ts` is structural, strips
  comments before matching, and carries its own self-test. It is line-, name-
  and dot-scoped, and that reach is stated in its own header rather than
  overclaimed: it catches a call site reverted to what it used to say, including
  the `overrides?.has(` form that type-checks and passes every behavioural
  suite, and it does not see an alias, a subscript, or a file not on its list.
- **`PrivacyOverrides` accelerates and never decides.** The scan it replaces was
  per-note on the search path: measured over 8,000 documents with 200 private
  overrides, `canSee` went 6.1ms → 214.1ms, handing back a large slice of the
  1,439ms → 670ms banked in "A search is paced". The folded set is built once
  and dropped on any write — rebuilt on read rather than maintained by
  arithmetic, since an index kept in step by counting can drift, and it would
  drift towards a narrowing that stops being found. `overrideFor` falls back to
  the scan for a plain `Map`, so the answer never depends on the container; a
  container that changed the answer is exactly what shipped in this fix's first
  version and had to be taken back out. The index holds only `private` folds, so
  the accelerated path cannot widen even if the scan were broken to — which is
  why sabotaging the scan alone leaves the gateway suite green, and why the
  differential test, which passes plain maps, is where that direction is pinned.
- **`hasOverride` is not a visibility answer.** It folds both directions
  because its callers are move and write *guards* that refuse when an override
  exists, so a folded twin only ever refuses more. Using it to decide what a
  caller may see would reintroduce the widening.

### A shared workspace scaffolds `team`, and that is not a widening

`renderPrivacyManifest` wrote every folder `private` for every context, and the
reasoning it carried is right for exactly one of the two kinds: `team` is not
public, but a brain created five seconds ago has granted nobody anything, so
there is no correct set of folders to open up, and a `team` default would grant
nothing today and then quietly open a folder the first time somebody was
invited.

A workspace inverts every clause of that. It is created *because* several people
are in it, the invitations are usually sent in the same sitting, and the person
creating it is not writing their own notes into it — they are laying down a
place for other people's. Scaffolded all-private it is worse than thin: it is
broken. `clampScopes` lets only an `owner` hand a client the `context:private`
scope, so an `editor` or a `member` invited into a fresh workspace could not read
one note in it **by any grant they were able to issue**. Every invitation landed
somebody in an empty context, and the repair was a file they had to know existed.

So `workspaces.kind` travels from the row, through `applyStructure`, into
`scaffoldContext`, and decides one thing: what `startingVisibility` returns.

**It widens nothing, and the argument is the membership rather than the word.**
`team` still means exactly "the named people in this workspace". At the moment
the layout is written that set has one member, the owner who just created it, so
the scaffold discloses nothing to anybody. What it changes is that the *next*
invitation means what the person sending it thinks it means. Nothing about the
manifest's semantics moved: there is no third value, `Scope` is still
two-valued, and `canSee` is untouched.

Three things hold the edges, and each fails a test if removed:

- **`default_visibility` stays `private`**, fixed in `renderPrivacyRulesBlock`.
  Only the folders the scaffolder itself created are opened. A folder somebody
  adds later — `payroll/`, say — is private until a line names it, which is what
  keeps this a starting layout rather than a switch on the bucket.
- **`kind` is read off the workspace row inside the mutation**, never taken as
  an argument from a client. A client that could name it could scaffold somebody
  else's brain open to everyone they later invite.
- **The repair path keeps the old default.** `resetPrivacyManifest` →
  `renderPrivacyManifestForFolders` defaults to `personal` and must never be
  given a `kind`. It rewrites a manifest that was *failing closed*, against a
  bucket that already has members and content — neither property a fresh
  workspace has — so all-private stays the only rewrite under which nothing
  changes hands. Passing `"shared"` there would make fixing a typo a way to
  publish a bucket. A call site that adds the argument is the bug.

The manifest and `index.md` also now say what the two words mean in a workspace,
because `private` there means **owners**, not "whoever wrote it". That is the
one thing a member cannot work out from the rules, and it is the thing somebody
otherwise learns by marking a folder private and locking out their co-lead.

### `index.md` is opened by name, because no folder rule reaches the root

The change above made every scaffolded **folder** `team` for a workspace, and
stopped there. `folder_defaults` are prefix rules; `index.md` is at the root,
under no prefix, so it matched nothing, fell through to `default_visibility:
private`, and a `team`-scope read returned not found.

That shipped a workspace whose members could read every note in it and not the
page that says what it is — and `index.md` is not an ordinary note. It is the
front page every connected agent reads first, and the gateway gates its whole
orientation on `canSee("index.md", …)`, so a member's client got a bare folder
map with no statement of what the workspace was for. The repair was a line in a
file they had no reason to open. It was found in a live workspace by its owner,
not by the suite, which is the part worth remembering.

So the scaffolded manifest carries one `note_overrides` entry, `index.md: team`,
for a shared context only.

**An exact-note rule is the instrument, not a workaround.** `note_overrides` is
for precisely this: one named `.md` whose visibility differs from what its
surroundings imply. Nothing else would do — a `""` folder rule opens the whole
bucket, and lifting `default_visibility` to `team` opens every path nobody has
ruled on, including folders somebody adds next month. This opens one file, by
name, and it is a file **we wrote**: at render time `index.md` is the
scaffolder's own text about the layout it just laid down, with nothing of the
customer's in it.

**A brain gets nothing here, deliberately.** Its `index.md` is its owner's own
manifest and may describe anything; publishing it to everyone they later share a
folder with is not ours to decide. The repair path inherits that through its
`personal` default, as with the folder rule.

**The guard is over what the scaffolder writes, not over a list somebody
maintains.** `__tests__/scaffold.test.ts` walks every key `scaffoldContext`
actually put into a shared bucket and asserts `canSee(key, "team", …)` for all
of them but `privacy.md` — whose owner-only answer is hardcoded in `canSee` and
is not this manifest's choice. A root file added next year with no override
fails it. Two narrower tests sit beside it, because the walk alone would still
pass if `index.md` were made readable by widening the default instead of naming
the file: one asserts the override set is exactly `{index.md: team}` and that a
sibling root note and a later folder are both still closed, and one asserts a
brain's and a repaired manifest's roots stay shut. Sabotage in all three
directions — no override, a `team` default, an override on a brain — fails a
different set.

### Restricting a folder to *some* of a workspace is not built, and the shape it would take

The obvious next ask — "this folder has an owner and they want it seen by four of
the eleven people here" — is real and is deliberately absent. `private` in a
workspace answers a two-member version of it (owners, and nobody else) and
nothing answers the general one. Three things would have to be true before it
could be, and they are written down here so the next attempt starts from them
rather than from a `visibility: "some"`:

1. **It is not a third word in `privacy.md`.** `Scope` is two-valued in both
   engines and in every grant; a third value would have to be understood by the
   gateway's `canSee`, the search filter, the folder listing, the console's
   visibility controls, and every already-issued grant, which cannot be
   retrofitted. The precedent is the unlisted share: a *row* beside the
   manifest, never a tier inside it.
2. **The subject has to be a set the manifest can name without becoming an
   access-control list.** `privacy.md` is a file in the customer's bucket that
   they edit in Obsidian. Putting user ids in it makes it unreadable and makes it
   a directory of the workspace's membership sitting in a synced folder. A named
   *group* — a label the control plane resolves to members — is the only version
   that keeps the file legible, and groups are a control-plane object that does
   not exist yet.
3. **The scope has to reach the grant.** Tier is carried by the scope list and
   nothing else, on purpose ("The privacy tier is a scope on the grant, never an
   inference from a role"). A per-folder subset is not a tier, so it is either a
   fourth clamp dimension or it is enforced only at read time — and a read-time
   check that no grant records is the shape that eventually disagrees with what
   the console shows.

Until then the honest answer, and the one the layout step now gives, is: a
folder is readable by the workspace or held back to its owners, and a single
note can be shared with one named person through a revocable link.

### Domain-based membership is not built, and would be an invitation, never a grant

"Anybody with an `@acme.com` address is in this workspace" is one sentence and
three separate decisions, none of which the current model makes:

- **A domain is not a person, and membership is per-identity.** Every row in
  `workspaceMembers` names a `userId`, every grant is revocable per person, and
  the audit trail records the acting identity. A rule that admits a *class* has
  to resolve to those rows at some moment, and choosing that moment is the whole
  design: at sign-in (a member appears without anybody adding them) or at first
  access (the workspace's member list is not the list of people who can read it).
  The first is the only one compatible with "audit records the acting identity".
- **It has to prove the domain, not read the string after the `@`.** An email
  address on an account is evidence only if it was verified, and Context's own
  sign-in is the only thing that verifies one. A rule keyed on an unverified
  address is a rule anybody can satisfy by typing.
- **It must not become an oracle.** Today an invitation is addressed to a string
  and resolved on acceptance precisely so that inviting `@lk` and inviting
  somebody who does not exist are indistinguishable. A domain rule that reported
  how many people it matched, or that behaved differently for a domain with no
  accounts, would be the enumeration endpoint that design exists to prevent.

The shape that fits: a **standing invitation** on the workspace, addressed to a
verified domain instead of to one identity, with a role, an expiry, and a
revocation — a `workspaceInvitations` row with `inviteeKind: "domain"`, consumed
by an account whose *verified* address matches, producing an ordinary
`workspaceMembers` row with `invitedBy` set to whoever created the rule. That
keeps every downstream invariant: membership stays per-identity, the audit
records who joined and under which rule, revoking the rule stops future joins
without touching the people already in, and nothing anywhere reports who
matched. It is a row and a resolver, not a new access model — which is why it is
worth waiting to build properly rather than special-casing into the invite box.
