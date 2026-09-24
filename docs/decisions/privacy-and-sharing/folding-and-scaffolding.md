# Privacy and sharing — folding and scaffolding

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
public, but a workspace created five seconds ago has granted nobody anything, so
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
  else's workspace open to everyone they later invite.
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

**A workspace gets nothing here, deliberately.** Its `index.md` is its owner's own
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
workspace's and a repaired manifest's roots stay shut. Sabotage in all three
directions — no override, a `team` default, an override on a workspace — fails a
different set.

### Restricting a folder to *some* of a workspace, and the shape it took

_Written while this was unbuilt, and kept because the three conditions are what
it was eventually built to. Where it says a thing does not exist, read the note
under each point. See "A `@name` rule grants somebody something" below for what
landed and what it cost._

The obvious next ask — "this folder has an owner and they want it seen by four of
the eleven people here" — is real. `private` in a workspace answers a
two-member version of it (owners, and nobody else) and nothing answered the
general one. Three things would have to be true before it could be, and they
are written down here so the next attempt starts from them rather than from a
`visibility: "some"`:

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
   not exist yet. **Built**: `workspaceGroups`, and the manifest carries the
   reference while the control plane holds the fact. The owner later admitted
   one more subject beside a group — a **handle**, `@kola` — on the ground that
   a handle is not a user id: it is legible, it is what the addressing scheme
   already writes, and requiring a group of one to share a folder with one
   colleague was the friction that made the whole feature unusable.
3. **The scope has to reach the grant.** Tier is carried by the scope list and
   nothing else, on purpose ("The privacy tier is a scope on the grant, never an
   inference from a role"). A per-folder subset is not a tier, so it is either a
   fourth clamp dimension or it is enforced only at read time — and a read-time
   check that no grant records is the shape that eventually disagrees with what
   the console shows. **Half-built, and the halves are deliberately separate.**
   The console path resolves names from live membership, which is sound because
   the caller *is* the person and the audit records them. The gateway path —
   where a delegated AI client must reach a name only through a scope its grant
   was issued with, never through its person's memberships — is the other half
   and is not built; until it is, a connected client reaches no `@name` rule at
   all, which is the failing-closed end of the gap.

The answer while this was unbuilt — and it is left here because it is what every
surface still said long after the pieces existed — was: a folder is readable by
the workspace or held back to its owners, and a single note can be shared with
one named person through a revocable link.
