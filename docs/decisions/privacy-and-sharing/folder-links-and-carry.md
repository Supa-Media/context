# Privacy and sharing — folder links and carry

### A folder link reaches a subtree, and narrows rather than widens

Asked for by the owner (2026-09-17) on an explicit comparison they made
themselves: Google Drive and Dropbox both give a folder link the whole subtree —
recipients browse into subfolders and open anything inside — and the ask was to
mirror that. **This edits non-negotiable #5**, which said "one note at a time …
is the single exception". The sentence is rewritten in the same change rather
than worked around, and the paragraph above — which said a folder has no third
position and ended "do not answer it by loosening the path check" — is answered
on its own terms: the path check was not loosened.

**What is widened is a locator, not a tier.** `Scope` is still two-valued, no
word in `privacy.md` changed, and no *setting* publishes anything. A folder link
is a share row with `entryKind: "folder"`, exactly as the unlisted note link was
a row and never a tier.

**And it narrows, which is where we are deliberately stricter than Drive.**
Drive's model is *inherit unless restricted*: everything under a shared folder is
shared by virtue of being under it. Ours is the opposite, and it costs nothing to
keep — every path is re-derived through the live `privacy.md` at `team` scope
**with no granted names** on every read. So a note held back by name, a private
subfolder, and a note pointed at a group are all absent through a folder link. It
publishes what the folder already published to the workspace, and never more.
That is a property of the read path rather than of a filter written here, which
is what keeps it true as the manifest changes under a link already pasted.

Six things hold it, and each fails a test in `__tests__/folderLink.test.ts`:

- **The bound is a prefix with a trailing slash.** A note link's traversal is
  its entry note's own links, depth one; a folder has no such natural edge, so
  the bound is the folder itself. `withinSharedFolder` is `path === folder ||
  path.startsWith(folder + "/")`, and **the slash is the whole function**:
  `startsWith(folder)` hands `1-projects/transition-old` to a link minted on
  `1-projects/transition`, a different folder whose name merely begins with the
  shared one's. That case is team-visible in the fixture on purpose, so the
  refusal can only come from the bound; sabotaging the slash fails it and
  nothing else.
- **The bound runs before any bucket byte is spent.** A path outside the folder
  costs no GET and no LIST, so it cannot be told apart by timing from one inside
  that does not exist.
- **The kind is declared and then proved.** A folder and an extensionless file
  are the same string — `checkTeamSharePath` already recorded that "note or
  folder" was never implementable from a path — so the caller says which it
  means and `mintFolderLink` probes with the listing the reader will actually
  get, at `team` scope. A folder that lists nothing at `team` is refused, which
  covers a private folder, a folder whose every note is held back, a note wearing
  a folder's argument, and a path that is not there. One refusal, because at
  `team` scope those are genuinely indistinguishable.
- **Every refusal is one refusal.** A sibling, a parent, a prefix twin, a note
  outside, a path that does not exist, and a token nobody minted come back
  byte-identical, asserted by collecting the shapes into a set and requiring one.
- **An empty folder is served, not refused.** A subfolder whose every note is
  private lists nothing, and so does one that genuinely holds nothing. Refusing
  on emptiness would tell a reader that a folder they can see the name of has
  something inside they may not read.
- **`entryKind` is optional on the row and defaulted at the authorizer.** Every
  share written before this is a note, and a share's reach must never depend on
  a backfill having run. Defaulted in `authorizeShareRead`, the one place every
  reader passes, rather than at each call site — a call site that forgot would
  widen an old row from one note to a subtree.

**What it costs, stated rather than left to be rediscovered.** It is the same
cost the unlisted note link already carries, one step wider: an anonymous reader
has no name, so revocation stops *future* reads and cannot retrieve what was
already taken — and for a folder that is now a subtree rather than a note. The
owner is choosing that when they mint it, and the answer to somebody proposing
to "fix" it with an expiry or a view count is that neither un-publishes
anything.

**A folder link's card names the folder and nothing inside it**, and that is a
boundary rather than an omission. "A folder link may also name two or three
things inside it" above is about `/console/@slug?note=<folder>` — an address the
owner chose, answered with a live `members` row behind it — and it does **not**
carry over to `/s/<64 hex>`. The obvious tidy-up is to make the two cards match,
and it is refused: an unlisted link is pasted into channels and forwarded, this
file's own honest rule is that anything reaching a card is permanently public
(Discord and WhatsApp copy the image to their own CDNs, iMessage bakes it into
the sent message), and the names of somebody's notes are the most sensitive
string this product publishes. `previewTitleForToken` returns the owner-chosen
title and `openToAnyone`, and a test sabotages the title into carrying children
to prove it.

**The whole context is never the subject of one.** `checkFolderSharePath`
refuses the root. A link over `""` is not a folder share with a wide reach, it
is a different product, and every bound here is expressed relative to a prefix
that a root would make empty.

### A `@name` rule reaches an AI client through its grant, and that half is not built

The console half landed with "A `@name` rule grants somebody something" above.
This is the other half, written down before it is built because the shape is
not obvious and one attractive shortcut is actively unsafe.

**The requirement, which is already a decision.** `canSee`'s own docstring
states it: "a connection a person added at team tier cannot see, search or list
a note scoped to a group *even when that person is in the group*". So a client's
reach cannot be resolved from its person's memberships — it has to ride on the
**grant**, as `context:group:<name>` scopes clamped at approval time against the
groups that person is actually in, and intersected again with live membership
when the session resolves. Resolving from membership alone would hand every
connected client every group note its person can reach, which is the answer
somebody deliberately gave the narrower tier is entitled not to get.

**Today it fails closed**, and that is the only reason this is a gap rather than
a hole: nothing passes `grantedGroups` in the gateway, so a `@name` rule reaches
no AI client at all.

**The shortcut that looks safe and is not.** The gateway has ~31 `canSee` call
sites in `index.js`, which is plain JavaScript — so unlike the control plane,
where making the clearance one value let the compiler find every site, a missed
site here is silent. The tempting alternative is to leave every call site alone
and instead **rewrite the loaded rules** for a request, mapping each granted
`@name` to `team` before handing them to the engine. It is one place, it cannot
miss a site, and it fails closed if it does not run.

It is still wrong. `persistExactVisibility` takes `rules` as an argument and
uses it on the legacy branch — `visibilityOf(path, rules)` — to decide what to
write to the legacy ACL key. The rewritten array reaches a **write** path, where
`@leads` reading as `team` changes what is persisted. A read-time doctoring of
the manifest is only safe if the doctored copy can never reach a writer, and
here it can. Anybody reaching for this shortcut should stop at that call, not at
the idea.

**So the completeness guard has to be a structural test**, in the shape
`__tests__/privacyAccessors.test.ts` already uses: read the file, find every
`canSee(` call, assert each passes the caller's names, strip comments first, and
carry a self-test so a matcher that accepts everything fails. That is weaker
than a compiler and it is what this file has; it is worth saying plainly rather
than pretending the threading is as safe as the control plane's was.

**And one product question is open rather than answered.** Per-name scopes mean
an owner who points a folder at a *new* group has to re-consent every client
that should follow it — the grant records what it was issued with, which is the
property the tier rule wants, and it is also friction nobody has agreed to. The
alternative is a single `context:groups` scope meaning "the groups its person is
in, resolved live", which is one checkbox and re-widens silently as membership
changes. This file's existing rule favours the first; whether that is the right
trade for a person managing several clients is the owner's call, and it should
be made before the scopes are minted rather than after they are in grants.

### A note carried into another context lands at the narrower of the two ends

A cross-context move is the one operation that takes a note out from under one
`privacy.md` and puts it under a different one, written by a different owner,
naming a different set of people. What it lands at is `landingVisibility`, and
it is the **narrower** of two answers: what the note could be seen as where it
came from, and what the folder it is arriving in already publishes.

So `team` survives only when both ends already say `team`. A `team` note into a
private-default folder lands private — the destination's own default wins. A
`private` note into a team-default folder lands private too, with an exception
written for it, and the exception is written to the manifest **before** the body
is written to the bucket: a note put in place and narrowed a moment later is a
note the destination's whole team could read for as long as the second write
took, and forever if it never happened.

**Which is why there is no "are you sure this becomes visible to them?" step.**
There is nothing to confirm. The gateway's `move_note` refuses that second case
instead, behind `confirm_team_publish`, and that is right for a tool call —
an agent chose the destination and the person may never have seen it. It is
wrong for a folder of mixed notes that somebody dragged somewhere on purpose:
one checkbox cannot express per-note intent, and the safe reading of it is the
one this rule already takes. The two engines therefore differ here deliberately,
and the difference only ever runs in the safe direction.

**A group rule does not travel.** `@supa-leads` names a group in the *source*
workspace, resolved by the source's control plane; the destination resolves
names in its own. A note pointed at a group lands `private` — carrying the
string would write a rule the destination cannot resolve, which reaches nobody
today and reaches the wrong people the day somebody there mints that name.

**An encrypted note does not travel at all.** Its data key belongs to the
workspace it was written in (`functions/encryptionKeys.ts`) and does not move
with it, so its ciphertext in another context is a note nobody can ever open,
including the person who moved it. It stays where it can still be read, and the
move names it rather than swallowing it — "moved, except for three of them" is
what stops somebody going looking in the other context for notes that are not
there.

**The source manifest forgets what it said about an empty subtree.** A folder
rule whose folder is gone is not inert: the name comes back the day anything
recreates that path — an ingestion alias filing into `1-projects/acme`, a note
saved to the same place — carrying a visibility nobody chose for it. Rules
covering something that stayed behind are kept, which is why the cleanup takes
the survivors rather than assuming there are none.

**What a "simplification" of this would cost.** Carrying the source's tier
across unchanged publishes private notes to a set of people who were never
chosen. Writing the body before the exception opens a window in which they are
published anyway. Carrying a group name writes a rule that means something else
on the other side. Carrying an encrypted note destroys it while reporting
success. `apps/convex/__tests__/contextMove.test.ts` fails — "a private note
landing in a team folder is written private first", "the exception is in the
manifest before the body is in the bucket", "a note pointed at a group lands
private, because the name means nothing there", and "an encrypted note stays in
the context whose key can open it".

### A share follows the note, not the path it was minted on

`shares.entryPath` is a string, and a note is not a string. It gets renamed,
tidied into another folder, archived — and a link the owner already sent is one
nobody can rewrite. So `readSharedNote` resolves both the grant's entry path and
the requested path through the bucket's forwarding ledger before anything else
happens, and everything after works in live paths: the folder bound, the
traversal comparison, the reads. The ledger itself is argued in
[storage-and-credentials](../storage-and-credentials.md), "A moved note leaves a
forwarding address".

**Ledger first, live path second, and that order is the security half rather
than a preference.** A link minted on `1-projects/foo.md` names *that note*.
Checking the live path first would hand the link to whatever note happens to sit
there now — a different author's note inheriting an audience they never chose,
and the owner of the original with no way to see it had happened. Resolving
first means a share either reaches the note it was minted on or reaches nothing.
That is the opposite order from a deep link, which is `onMiss` because a path
somebody typed means what it says today, and the two cannot be one rule.

**It cannot widen, and the reason is unchanged.** Every read still goes through
`runFileOperation` at `team` scope with no granted names, re-derived from the
live `privacy.md` on every request. A note forwarded into a private folder is as
absent as it would be if the reader had asked for its current path; a folder
link still publishes a narrowing of what the folder already published. What
forwarding restores is the *locator*, never the tier.

**The requested path is the reader's own input, and resolving it discloses
nothing.** A link holder may ask about any path; the ledger answers the server,
never them. A note that has moved out of a shared folder forwards to somewhere
outside the bound and is refused with the same `SHARE_UNAVAILABLE` as a path
that never existed, so forwarding is not an oracle for where anything went.

**It costs one extra operation per share read**, and that is deliberate. The
folder bound is decided before a single byte of the customer's bucket is spent,
so a bound checked against a stale prefix while the read forwarded to a live one
would be two different answers to one question. Both paths are resolved together
in one `forward` operation instead.

**What a "simplification" of this would cost.** Trying the live path first
re-points a sent link at a stranger's note — `shareSurvivesMove.test.ts` fails
"a different note later created at the old path is not served", and nothing else
does, which is what makes that check worth its name. Resolving only the entry
path and not the requested one breaks a folder link the moment its reader
navigates. Storing the resolved path back onto the share row would put the
control plane's copy of a path in disagreement with the bucket, which is the
same mistake as storing visibility there. `shareSurvivesMove.test.ts` fails
throughout, and `folderLink.test.ts`'s prefix-trap checks are what keep the
resolution from widening a folder bound.
