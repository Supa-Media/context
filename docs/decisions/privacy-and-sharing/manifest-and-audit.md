# Privacy and sharing — manifest and audit

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
  [storage-and-credentials](../storage-and-credentials.md).

It declares the bucket's **real** top-level folders, not the five PARA names,
because the case this exists for is a workspace that arrived with a hand-edited
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

### The audit trail's `details` are allow-listed

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
- **An exception flag that turns a same-shape detail into a note-level
  existence signal, once `paths` no longer rides beside it.**
  `visibility.note`'s `{ visibility, exception }` was harmless while every
  row's `paths` was published: `exception` was redundant with the path
  attached to the same row. It stopped being harmless the moment `paths` was
  gated (below) — paired with `visibility: "private"` on a row whose path a
  member can no longer resolve, `exception: true` still says this note's
  classification differs from its *folder's* default, which counts a private
  note inside a folder whose default the member can read. Found by adversarial
  review of the `paths` fix itself, applying the exact criterion
  `workspace.structure_applied` was already struck from this list for.
  `visibility.note` came off with it; `visibility.folder` stayed, because it
  carries no `exception` field and its subject — a folder's own default — is
  something a member watching that folder already learns first-hand the
  instant their own listing of it changes. Both setters are `owner`-only, so a
  member is never either row's actor and loses nothing about their own work
  either way.

The count is withheld rather than dropped at the call site, so the owner's
record keeps it. `workspace.structure_applied` was on the list only because its
`folderCount` equals `paths.length` exactly, with a note to revisit it in the
commit that ever withheld `paths`. That commit came, and it came off: withhold
the five scaffolded folder names and publish "5" beside them, and the census is
back under another name, over a scaffold whose manifest is
`default_visibility: private`.

**And `paths` was an open leak that gate did not touch.** It is closed now, but
the leak is written down rather than quietly deleted, because a draft of the
code comment once *defended* it — "the folder is one a member can list" — which
is false in general and was the most dangerous line in that change. Measured
through the real actions and the real privacy engine: a read-only member whose
`listFiles` on a private folder correctly returns **zero entries** got a hidden
note's full path out of `listEvents` three times over — from `file.create`,
from `visibility.note` (labelled `visibility: "private"`, so they learned it
was withheld from them), and from `file.delete`, which records `keysUnder(...)`
expanded at the owner's clearance and therefore names every private sibling.
That was `audit.ts`'s own module-header example handed to a member.

### A row's paths are the reader's own clearance, or the reader's own hands

**The rule.** `listEvents` releases a row's `paths` on exactly two grounds: the
reader holds `private` clearance — which is `role === "owner"`, the boundary
`scopeForRole` already draws — or the reader is that row's own actor.
Everything else comes back with `paths: []` and `pathsWithheld: true`.

**Why identity and not visibility.** The honest gate is
`canSee(path, scopeForRole(role), …)`, the one `listFiles` runs, and it is not
reachable from a Convex `query`. `canSee` needs the parsed `privacy.md`,
`privacy.md` lives in the customer's bucket, and reaching the bucket needs the
decrypted storage credential — `runFileOperation` is the sole member of
`CREDENTIAL_BARRIERS` precisely to keep that decrypt in one place, and a query
cannot call an action at all. The control plane also holds no shadow copy of a
note's visibility to consult instead, by non-negotiable #1. This is the same
constraint that makes `previewForNote` snapshot a folder's children at link
time.

So the gate is the strongest **sound under-approximation** of `canSee` a query
can make: a path is released only where the reader demonstrably already had it.
The owner had it by clearance. The actor had it by having supplied it — and a
row's `paths` are expanded by `keysUnder` at the *actor's* clearance, so a
member's own row can only ever name what that member could already list. Being
sound in that direction is the whole point: the failure mode of getting this
wrong is a member seeing less than they might have, never a member seeing a
note they were never shown.

**The actor leg is past-tense clearance, not current — worth saying plainly
rather than folding into "sound".** An editor who wrote `1-projects/plan.md`
keeps reading their own `file.write` row's path after the owner later marks
that note `private`; they had it when they wrote it, and the gate does not
revoke it retroactively. The exposure is mild and self-limiting: it is a path
the editor already possessed outside the trail (they wrote it), it never
grows (no later *owner* action on that path re-exposes it to them — the
owner's own rows on it, the eventual `file.delete` included, are gated by
clearance and stay closed), and it is symmetric with the honest `canSee` this
approximates, which would have shown the same row at write time and only
stops matching once the manifest changes underneath it. The owner leg has no
such gap: `role === "owner"` is evaluated fresh on every call, never cached
from when a row was written.

The three alternatives, and what each costs:

- **Make `listEvents` an action.** Exact filtering, at the price of the
  console's reactivity plus a bucket read and a credential decrypt on every
  trail load. Worth reopening if the trail moves behind an action for other
  reasons; not worth widening the credential surface for a settings panel.
- **Stamp each row's visibility at write time.** Cheap, and wrong in the unsafe
  direction: a note written at `team` and later made `private` keeps its `team`
  stamp, so the leak survives exactly the act — hiding something — that makes
  it matter.
- **Withhold `paths` from every non-owner, own rows included.** Marginally
  simpler and strictly worse. It takes away "what did my own client just do in
  my name", which is a member's main reason to open the trail, and buys
  nothing: the reader supplied those paths.

**What a legitimate member loses, and why it is the right trade.** A member no
longer sees which note somebody else touched — including `team` notes they can
read perfectly well, because nothing here can tell those apart from private
ones. "Who changed my shared note" now stops at "who, and when". That is a real
loss, and it is the reason this needed a decision rather than a line. It is
taken because the alternative is a boundary that holds in `listFiles` and leaks
in the settings panel next to it, and because the loss is recoverable later
(the action variant above) while a path once shown is not.

**A trail with holes, never one that lies.** The row survives, and
`pathsWithheld: true` sits beside the empty `paths`. Returning `paths: []`
alone would claim the event touched nothing, which is false; the flag makes the
hole legible, so a console can render "a note you cannot see" instead of
silently nothing — **for actions that carry paths at all.** `pathsWithheld` is
`true` on rows like `member.joined` or `storage.rekeyed` too, and it cannot
tell "a path exists and is hidden" apart from "there was never a path on this
row" any more than it can tell one hidden path from three — it is computed
from the reader alone, never the row. A renderer has to gate that sentence on
the row's own `action` being one that carries paths before reading the flag
that way; `action` is public on every row, so branching on it publishes
nothing a member could not already see.

**The flag is computed from the reader, never from the row.** It is a function
of the reader's role and whether they are the actor — two facts they already
know about themselves — and consults neither `paths` nor `action`. So a
withheld row that named two private notes and a withheld row that named nothing
come back byte-identical. Raising it only where `paths` was non-empty would
have been the obvious implementation and would have rebuilt the private-note
census out of booleans: rows-that-touched-something minus notes-I-can-list.
`files.test.ts` pins the indistinguishability with two rows inserted at an
identical `at` and action, one with paths and one without.

**What survives, stated rather than hidden.** A row's *incidence* is still
visible to every member: action, actor, and timestamp are ungated, so a member
can still see that the owner created a note at 14:02 and count how many such
rows there are. That is a weaker signal than the path — it names nothing and
joins to nothing — but it is genuinely the same family as the counts the detail
gate withholds, and it is left open on purpose: removing the row is the one
thing that would make the trail stop answering the question it exists for, and
"the row vanished" is itself a disclosure with none of the honesty of a marked
hole. Closing it means gating incidence, which is a separate decision with a
separate cost, and the same one that `grant.created`'s ungated
`actorUserId`/`actorClientId`/`at` columns are waiting on.

A fourth column rides beside those three: **`details`**, on whichever actions
`MEMBER_VISIBLE_DETAIL_ACTIONS` allow-lists, per the section above. That gate
is where `visibility.note`'s `{ visibility, exception }` lived until it was
struck for being an existence oracle over exactly the notes `paths` now
protects — the two gates are read separately for a reason (`readsEveryDetail`
and `readsEveryPath` agree today only because both currently mean `owner`;
folding them into one boolean is how a later change to either would silently
move the other), but a leak that survives `paths` being closed can still live
in `details`, and did until this review found it.

**A "simplification" of this costs**: folding `readsEveryPath` into the
`details` boolean (they agree today and are different rules, so a change to
either would silently move the other); keying the gate on write access rather
than clearance, which hands every editor the whole trail although
`scopeForRole` gives an editor `team`; or making the redaction marker depend on
what the row holds.

**The tests that fail if it is reversed**: in `apps/convex/__tests__`,
`files.test.ts` → "a member cannot recover a hidden path out of the audit
trail" builds attacker and victim in **one** database and one workspace — a
fixture that separates them proves nothing, because the refusal would then come
from the row not existing — and drives the real actions against a real bucket
and the real privacy engine; `audit.test.ts` → "a row's paths are the reader's
clearance or the reader's own hands" covers the control-plane edges, including
a row with no actor at all, and pins `scopeForRole("owner") === "private"` so
that a change to the role/clearance mapping fails here rather than silently
widening the trail. `audit.test.ts` → "the allow-list's own criteria are
applied to the allow-list" additionally builds the exact `visibility: private,
exception: true` row inside a folder a member can list, and asserts its
`details` come back `undefined` for a non-owner — re-adding `visibility.note`
to `MEMBER_VISIBLE_DETAIL_ACTIONS` fails it.
