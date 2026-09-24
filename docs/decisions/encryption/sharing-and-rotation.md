# Encryption — sharing and rotation

### Sharing: an unlisted link over an encrypted note is refused

The brief asks for a decision, and it is **refuse**, in both directions:
minting a link over an encrypted note is refused, and a live link stops
resolving the moment the note is encrypted.

An unlisted share is deliberately the one audience with no name and no session,
and its own decision states the cost it accepts: revocation "stops *future*
reads and cannot retrieve a copy already taken". Both features are defensible.
Their composition is not — it would make the single path in this product with
no identified reader also the path that opens the note the owner was told is
stored unreadable. The owner's model of "encrypted" and their model of "anyone
with this link" cannot both be true of one note, and the product does not get to
pick which one they meant.

The refusal reuses shapes that already exist rather than inventing any:

- Minting is refused at creation, in `createLinkShare`, beside the existing
  courtesy check that already refuses a link over a note the team cannot read —
  and for the same reason that check exists: a link that silently resolves to
  "not available" is indistinguishable, from the owner's side, from having
  published something.
- A note encrypted *after* a link was minted is refused at read, because the
  read path re-derives from the live bucket every time, exactly as it already
  re-derives visibility from live `privacy.md`. Nothing is stored on the share
  row, so nothing on the row can disagree.
- The refusal is the same `NOT_AUTHENTICATED` as every other, so a link holder
  cannot learn whether the note was encrypted, revoked, or never there.

**What a simplification would cost.** "Decrypt it like any other read" is one
line and it publishes the plaintext of an encrypted note to an anonymous URL
that survives every forward.

**What shipped, and the one edge it does not cover.** `createLinkShare` refuses
with its own code, `PATH_ENCRYPTED` — deliberately not `PATH_NOT_TEAM_VISIBLE`,
because the two send an owner to different places: one says "publish the note
first", the other says "this note is deliberately unreadable, and the audience
with no name is the one that cannot have it". `readThroughShare` refuses again
on every read, from the live object, narrowed to `openToAnyone` — so a note
encrypted *after* a link was pasted stops resolving, and the refusal is the
ordinary anonymous one rather than a new answer a holder could learn from.

A share addressed to a **named person or to a context's members** is not
refused, and today it renders the envelope rather than the note: the control
plane holds no note key and never decrypts, so it has nothing else to show.
That is a broken page and not a disclosure — an envelope is ciphertext — and it
is left rather than fixed here because the fix is a product decision about what
a named reader should see, not an engineering one. What is not left open is the
composition this section is about: the reader with no name gets nothing.

**The tests that fail if this is reversed.** Minting over an encrypted note is
refused; reading through a link minted before encryption is refused, including
for a note the entry note links to; and the refusal is byte-identical — on the
whole error payload, not on its code — to the one an invented token gets.

---

### Rotation: three different things, and they must not be confused

1. **The control plane's envelope key** (`STORAGE_SECRET_ENCRYPTION_KEY`). Already
   solved and not re-solved: `requireKeyset` reads current and previous,
   envelopes carry a key id, and the re-encrypt pass moves rows forward. The
   WDK envelope is another row of that shape and rides the same pass. **No note
   is touched, and no bucket is written.**
2. **The workspace data key.** Built in Phase 2a. A new WDK generation is
   minted and every encrypted note's `workspace` recipient is re-wrapped toward
   it. **The body is not re-encrypted** — only the recipient's `wrapped` field
   changes (`rewrapWorkspaceRecipient` in `apps/mcp/src/encryption.js`), which
   is a small write per note.
3. **A passphrase** (Phase 2, not this one). Re-wraps that one recipient and
   nothing else. This is precisely what the product note bought when it
   decided to "wrap the data key so a password change does not require
   re-encrypting note content and attachments", and it is why the recipient
   list is the format.

**What a simplification would cost.** Leaving the generation id out of the
envelope makes a WDK rotation a re-encrypt of every encrypted note in a
customer's bucket, with no way to tell which ones are already done.

**Two tables, one durable and one that lives in the customer's own bucket, and
which is which is a decision.**

- `workspaceDataKeys` (control plane) grew `retiredAt: v.optional(v.number())`.
  Undefined on the workspace's current generation, a timestamp on every one a
  rotation has moved past. **A retired row is never deleted by this codebase**
  — see "The grace period is a policy, not a sweep" below.
- `workspaceKeyRotations` (control plane) holds exactly one fact per
  workspace at a time: whether a rotation is `in_progress`, and its
  `fromGeneration`/`toGeneration`. This is **the whole of what makes "refused
  while a walk is in progress" true**: `startWorkspaceKeyRotation` re-reads
  under its own mutation before minting a new generation — the identical
  race-safety shape `insertDataKeyIfAbsent` already uses for a workspace's
  very first key — so two concurrent callers converge on one target instead of
  minting a second generation each. Calling `rotate_encryption_keys` while a
  rotation is already active does not start a second one; it continues the
  one that exists, because there is only ever one shape a rotation can be in.
- **The re-wrap walk's own progress *is* persisted, and deliberately not in
  this table.** `ROTATION_PROGRESS_PATH` (`.context/rotation-progress.json`,
  `apps/mcp/src/index.js`) holds a `cursor` — every note key at or below it, in
  the bucket's own sort order, has been examined during the current pass — a
  `confirmedThrough` timestamp, a small `stuckKeys` list, the `wrote` keys the
  last call itself moved, and an authentication tag over all of it. It lives beside
  the notes it describes rather than in `workspaceKeyRotations`, for the same
  reason `EXPORT_RATE_LIMIT_PATH` does: the control plane holds the one fact
  that has to be authoritative everywhere — whether a rotation may be
  *started* — and the walk's own bookkeeping over the customer's content lives
  beside that content, disposable and best-effort, never the source of truth
  for whether a note is on the outgoing generation (a note's own frontmatter
  always is that). A lost write to this file — two overlapping calls, a
  corrupted read — costs a wider re-scan next call, never a wrong completion:
  every note a call actually rewraps is still written directly, conditionally
  on its own etag, whether or not the progress file's own write lands. This
  reverses the trade the previous paragraph's history made: a persisted cursor
  *is* a second piece of state that can go stale, and this design accepts that
  in exchange for a bound this section used to say a cursor was the fix for.

  **A call resumes from the cursor instead of re-listing and re-reading
  everything before it.** `listAllKeys` is still called every time — listing
  is cheap, a handful of subrequests per thousand keys, not one per note — but
  the *reads* (`store.get`, one per note actually examined) only touch the
  frontier past the cursor, plus a small correction described next. This is
  what bounds every call, **including the one that completes the rotation**,
  to about `ROTATION_BATCH_CAP` object reads rather than one read per note in
  the bucket.

  **A note created or moved to a key behind the cursor is not skipped.**
  `listAllKeys` already returns each object's `uploaded` timestamp — free,
  part of every backend's listing response — so a note whose key sorts at or
  before the cursor, but whose `uploaded` time is after `confirmedThrough`, is
  re-examined anyway: it arrived at that position after the cursor had already
  swept past it, and the sweep proves nothing about content that arrives
  later.

  **`confirmedThrough` is captured before a call's own listing, and this is
  the part adversarial review had to correct.** The first version of this
  change took it at the *end* of the call, after that call's writes landed, so
  that a call would never re-read its own output. That boundary is later than
  the listing the call worked from, and everything in between falls into a
  gap: a note moved behind the cursor *while a call was running* was invisible
  to that call (its listing predated the move) and looked older than the
  boundary to the next one. Measured on the branch that proposed it — a
  `move_note` into an earlier folder during a call left the note on the
  outgoing generation, and the walk retired the generation anyway. Taking the
  boundary before the listing closes it, and the re-reading it was meant to
  avoid is paid for separately, below.

  **Two smaller corrections in the same place, both measured.** The comparison
  is made at **whole-second resolution with a strict `<`**, because S3's
  `ListObjectsV2` and Dropbox's `server_modified` report whole seconds: a
  millisecond boundary against a truncated timestamp lost a note moved behind
  the cursor in four of eight runs on a second-granularity store stub. And the
  progress file carries `wrote`, the keys the last call itself re-wrapped,
  which the catch-up sweep skips — without it, a boundary taken before the
  writes puts every note the walk just moved back in front of the next call,
  and a caller looping the tool faster than the backend's timestamp resolution
  never converges (measured at 600 notes: calls four through twelve each
  re-read 252 objects, re-wrapped nothing, and the walk never reported
  complete). What `wrote` gives up, stated: a write somebody else lands on
  that exact key between our own write and the next call is not re-examined by
  this rotation. Through the gateway that write is already on the target
  generation — a rotation retires the outgoing generation the moment it
  *starts*, so `sealNoteContent` seals under the new one from then on — so the
  only shape left is a direct-to-bucket restore of pre-rotation ciphertext,
  which is the first of the three cases "The grace period is a policy, not a
  sweep" already exists for.

  All three are proven in `apps/mcp/test/encryptionRotationCursor.test.mjs`
  with a note moved behind the cursor mid-call, a second-granularity backend,
  and a sabotage row each, rather than argued.

  **The per-call budget counts object reads, not notes re-wrapped.** Counting
  what a call *moves* lets it read whatever it passes over for free, and a
  bucket whose notes are mostly not encrypted — a workspace with encryption on for
  one folder, which is the ordinary shape, not a corner case — is exactly that
  bucket. Measured on the first version of this change: 4,002 reads in a
  single call over a 4,000-note bucket with 200 encrypted notes, and 10,002
  over a 10,000-note one. That is the same ceiling this whole section exists
  to remove, relocated from the last call to the first. A read is what a
  Worker's subrequest budget spends, so a read is what the cap counts:
  `ROTATION_BATCH_CAP` for the forward sweep, the same again plus a little for
  the behind-the-cursor catch-up (it has to be able to get through its
  predecessor's whole batch, or a finished walk never gets to say so), and
  `ROTATION_RETRY_READ_CAP` for the known-stuck retry so a large stuck set can
  never starve the sweep that actually advances the cursor.

  **The progress file is authenticated, because it is the one bucket object
  that can make a rotation lie.** A `cursor` sorting after every key, in a
  file that otherwise parses and names the live generation pair, made the walk
  report "complete" having read no note at all — every note still wrapped
  under the outgoing generation, and that generation retired. The paragraph
  below then tells an operator it is safe to delete a retired generation's row
  once nothing names it, and that is the step at which those notes stop
  opening for good. "A leaked bucket credential" is the row this file's own
  threat table calls the one that matters, and a persisted cursor was the
  first thing it could write that the remediation reads back. So the file
  carries an HMAC-SHA-256 tag, derived in one step from the *target*
  generation's key material (which the gateway holds in-process and a bucket
  credential alone does not), and a file whose tag does not verify is treated
  exactly as a missing one: the walk starts fresh and re-reads, which is
  slower and always correct.

  **A note this pass cannot move does not block the cursor from advancing past
  it.** A conflicting write or an unopenable envelope goes into `stuckKeys`
  — small, retried every call independent of cursor position — rather than
  pinning the cursor at its own key. Without that, a single such note would
  make the cursor's persisted value stop advancing forever, and every call
  after it would re-walk everything past that point from scratch: the exact
  unbounded cost this design removes, just relocated to sit behind one bad
  note. This is the single guard the sabotage record below spends the most
  words on, because removing it reopens every other property this section
  claims at once.

  **The walk reports complete, and asks the control plane to retire the
  outgoing generation, only once a full pass finds the cursor at the end of
  the bucket's listing, nothing left behind it, and `stuckKeys` empty** — never
  on a partial pass, and never while a single note it could not open still
  exists. `workspaceKeyRotations` stays exactly what it was: the one fact that
  has to be authoritative everywhere, the walk's own progress unaffected.

  **What it costs, measured rather than asserted — the same table this section
  used to publish, plus the column a persisted cursor changes.** Driven to
  completion at a batch cap of 200, every note already encrypted before the
  walk starts, nothing else touching the bucket mid-walk:

  | notes | version | calls | total reads | reads in the completing call |
  | ---: | --- | ---: | ---: | ---: |
  | 600 | before | 3 | 1,205 | 601 |
  | 600 | **after** | 3 | **606** | **202** |
  | 4,000 | before | 20 | 42,039 | 4,001 |
  | 4,000 | **after** | 20 | **4,040** | **202** |
  | 10,000 | before | 50 | 255,099 | 10,001 |
  | 10,000 | **after** | 50 | **10,100** | **202** |
  | 20,000 | **after** | 100 | **20,200** | **202** |

  Re-measured independently in adversarial review at every size above plus
  20,000, and separately on the shape the first version of this change missed
  entirely — a bucket where only a fraction of the notes are encrypted:

  | notes | encrypted | version | reads in the largest call |
  | ---: | ---: | --- | ---: |
  | 4,000 | 200 | before the cursor | 4,001 |
  | 4,000 | 200 | first cursor version | 4,002 |
  | 4,000 | 200 | **after review** | **202** |
  | 10,000 | 200 | before the cursor | 10,001 |
  | 10,000 | 200 | first cursor version | 10,002 |
  | 10,000 | 200 | **after review** | **202** |
  | 20,000 | 200 | **after review** | **202** |

  Both tables are measured with calls spaced further apart than the backend's
  own listing resolution, which is what a caller does. **A caller that loops
  the tool as fast as it will answer pays extra calls, not extra reads per
  call**: several calls can land inside one second of a listing timestamp, the
  catch-up sweep stops being able to rule those batches out, and the walk
  spends bounded calls (452 reads, the worst case above) confirming rather
  than moving. Measured at 4,000 notes driven with no pause at all: 118 calls
  instead of 20, every one of them still bounded, still completing.

  Total reads used to grow as `notes x calls / 2`; after, they grow as
  `notes + calls x (batch cap + a small constant)` — linear in the bucket
  either way, but the constant that used to multiply by the number of calls
  is now added once per call instead. **The column that decides whether a
  rotation can run at all is the last one, and it no longer moves with the
  size of the bucket**: every call, including the one that reports "complete",
  reads on the order of the batch cap — measured at 202, never more, at every
  size this table covers, where the "before" column's own last column is the
  ceiling this whole change exists to remove: a 4,000-note context used to end
  its rotation with a single invocation issuing 4,001 reads, and above
  whatever the deployment's real subrequest budget is, that call could not run
  at all — not a slow rotation, but a walk that re-wraps every note and then
  never reports itself complete, leaving `workspaceKeyRotations` `in_progress`
  forever and the *next* rotation unable to start. Nothing was ever lost when
  that happened (every note opens under both generations throughout), but the
  operation did not finish. The 10,000-note "before" row is included precisely
  because it makes that failure mode concrete rather than extrapolated: it
  still completes in this benchmark (an in-memory bucket has no subrequest
  budget to exceed), but 10,001 reads in one invocation is not a number a real
  Workers deployment gets to attempt.

  **So: the ceiling this section used to report is gone, and the new bound is
  the batch cap, not the bucket.** `apps/mcp/test/encryptionRotation.test.mjs`
  pins the completing call's read cost to a small constant rather than to
  `noteCount`, fails if the cursor stops advancing past a note it cannot move,
  and fails if a note that arrives behind the cursor mid-walk is not picked
  up — three separate, sabotage-tested claims rather than one measured
  estimate.

  **What this does not solve, said the same way the previous paragraph named
  its own limit.** The batch cap itself — 200 notes, two subrequests each —
  is still optimistic against a real Worker's subrequest budget in exactly the
  way `FOLDER_MOVE_CAP` already is (`storage-and-credentials.md`); this change
  does not touch that number, only the number of calls that pay the *bucket's*
  cost instead of the *batch's*. And the progress file's own conditional write
  can still lose a race between two truly concurrent calls against the same
  rotation — harmless (the next call re-derives a superset of the work, never
  a false "done"), but not free: a workspace whose owner mashes the tool from
  two clients at once pays some redundant reads, not correctness. **A lost
  race must not be a lost cursor, though**, and that is a consequence of
  counting reads rather than re-wraps: a call that cannot persist its position
  re-reads the same first batch next time, and a bucket larger than the cap
  would never finish. So the conditional write is politeness rather than
  safety — `cursor` means "every key at or below this has been examined",
  which is true of whichever overlapping call wrote it — and a lost race is
  retried once unconditionally.

  And one the margin cannot close: `uploaded` is the storage backend's clock,
  and `confirmedThrough` is the Worker's. A backend running more than a second
  behind can under-report an arrival into the swept range, and that note stays
  on the outgoing generation — readable, under a generation this codebase
  never deletes, and moved by the next rotation. Closing it properly needs a
  per-key record of when the walk last examined each note, which is more state
  to keep consistent than the case is worth.

  One more edge, named rather than found later: a note could in principle
  move to an earlier key in the exact instant between the last confirming
  read a call makes and the moment it asks the control plane to retire the
  generation. This is not a new risk — the previous, cursor-less walk had the
  identical window between its own last check and its own completion call —
  and it is not a new kind of harm either: the grace period below already
  exists because a rotation can only promise the walk found nothing naming a
  generation, never that nothing ever will again. A note that raced the exact
  completion instant opens exactly as any other note wrapped under a retired
  generation does, for as long as that generation is kept, which this
  codebase never purges on its own.

**The grace period is a policy, not a sweep.** A retired generation is kept —
not deleted, not archived elsewhere, simply left as a row with `retiredAt` set
— indefinitely, by this codebase, on purpose. Three reasons a note can still
name a generation the workspace has moved past: a note restored from the
bucket's own object versioning, a client (Obsidian's sync plugin, `rclone`)
that writes the bucket directly and raced the rotation, or a walk that has not
yet reached that note. All three are real and none of them is bounded by a
timer this control plane can see. So there is **no automatic purge** — nothing
in this codebase ever deletes a `workspaceDataKeys` row — and the operator
sequence for actually discarding a retired generation's material is,
deliberately, not automated: confirm (by re-running the walk to completion, or
by a bucket-wide search for the retired generation's id in `context_encryption_key`
frontmatter) that nothing still names it, wait long enough that every client
that syncs the bucket directly has had a chance to, and only then delete the
row by hand. **A generation is safe to keep forever and unsafe to delete
speculatively**, which is the direction every default in this section leans:
an envelope wrapped under a retired generation opens exactly as it did before
the rotation, today and after any amount of time has passed, because nothing
here is watching a clock to decide when to make it stop.

**What a simplification would cost.** An automatic purge on a timer is one
`internalMutation` and a cron trigger, and it is exactly the feature that
turns "a restored note from three months ago" into "a restored note this
control plane can no longer open" — silently, on a schedule nobody watching
that one note would think to check.

**The tests that fail if this is reversed.** Two concurrent
`startWorkspaceKeyRotation` calls mint exactly one new generation between
them, sabotage-tested by removing the mutation's re-read
(`apps/convex/__tests__/encryptionKeys.test.ts`); a re-wrap walk interrupted by
a simulated write conflict leaves every note openable and a later call
finishes exactly what was left, sabotage-tested by miscounting a conflict as
done (`apps/mcp/test/encryptionRotation.test.mjs`); a note wrapped under a
generation retired long enough ago that a real deployment would consider
purging it still opens, because nothing purges it; the completing call's read
cost is pinned to a small constant rather than to the bucket's size,
sabotage-tested by disabling the persisted cursor; a note moved to a key the
cursor already swept past is still picked up, sabotage-tested by disabling
the `uploaded`-timestamp catch-up; and a single note the walk cannot move
does not stop the cursor from advancing past it, sabotage-tested by letting
one such note halt the whole sweep — the last two of which fail several
separate checks at once, because nearly everything else this section claims
depends on those two lines (all in `apps/mcp/test/encryptionRotation.test.mjs`;
re-measured in review at 5 and 2 failures respectively, on the file as it
stands, because a sabotage count is only true of the file it was taken on).

And four the adversarial review of that change added, in
`apps/mcp/test/encryptionRotationCursor.test.mjs`, each one measured failing
on the version that was proposed: a note moved behind the cursor **while a
call is running** is still re-wrapped (sabotage: take the boundary at the end
of the call — 2 failures); the same holds on a backend whose listing carries
only whole seconds (sabotage: compare raw milliseconds — 1); a progress file
this gateway did not sign cannot make the walk report complete without reading
a note (sabotage: skip the tag check — 2); and one call over a bucket whose
notes are mostly *not* encrypted still reads about the batch cap rather than
the bucket (sabotage: count re-wraps instead of reads — 1). A fifth guards the
fix for the first: the walk recognising its own previous output, without which
a fast caller never converges (sabotage: stop carrying `wrote` — 1).

And one more, which belongs to the *other* rotation in this file's list of
three: `STORAGE_SECRET_ENCRYPTION_KEY`'s pass must move **every** generation
forward, not only the current one. A retired row left behind on the outgoing
envelope key becomes unreadable the moment an operator completes step 4 of
that sequence and unsets the PREVIOUS variables — and the notes it strands are
exactly the ones the grace period above exists to protect. `workspaceDataKeys`
held one row per workspace until this shipped, so nothing had ever asked;
`storage.test.ts` asks now, with a rotated workspace, both rows, and the old
envelope key gone from the environment.
