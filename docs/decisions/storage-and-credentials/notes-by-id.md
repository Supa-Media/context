# Notes stored by id

## Names, folders and privacy live on tree rows; the bucket holds bodies by id

*Decided by the owner, 2026-10-15* ("I want like a clean migration. I don't
want there to be legacy ways things operate"; plan in the project file
`notes-by-id/plan.md`).

**Why.** With the bucket as the source of truth for names and folders, a
rename was a copy and a delete, and moving or archiving a folder was a copy
of every file beneath it. Phase 4 of the Convex tree hid that behind a queue,
but the queue, its overlay, reserved names and the five-hour catch-up
existed only to keep bucket keys equal to names. Auto-organizing a workspace
moves many notes, so the cost was paid constantly.

**What it is.**

- Every bucket, Context-managed or the customer's own, holds note bodies at
  `notes/<noteId>.md`, other files at `files/<noteId>.<ext>`, and plumbing
  under `.context/`. `noteId` is a UUIDv7 that never changes.
- Each workspace's tree rows (`nodes`) hold the name, the parent folder, the
  `storageKey` and the access. A path is derived from the rows. A move,
  rename, archive or trash is one row change and copies nothing.
- Privacy is native to the rows. A row's access is `private` (owners) or
  `team` (members), plus any mix of groups and named people, inside the
  workspace or not (by email until they have an account), each with view or
  edit. Absent means "as its parent"; the nearest setting wins, and a note's
  list replaces its folder's list rather than adding to it, which is the
  engine's old "longest prefix wins, exact note rule first". `privacy.md` is
  retired, and so are the note ACL files.
- Context may move and rewrite any key in a bucket it is connected to, a
  customer's own included. Files put into a bucket by other tools are not
  picked up. No compatibility with syncing a bucket to Obsidian is kept;
  Obsidian plugins that run inside Context are.
- Leaving is **Download as folders**: a decrypted zip with real names, free
  on every plan and after cancelling. Import runs the same copy pass as the
  migration.
- There is no gateway mode without a control plane.

## The migration is finished; its machinery is gone

*Decided by the owner, 2026-10-22* ("remove all code that does not operate on
notes by id and every fallback"). Production was 29 of 31 workspaces keyed, with
none of their notes off their id keys; the other two have no storage or are
archived with no rows.

What was removed: the switch (`noteIds.setMode`, `setPaused`, `startAll`,
`start`, `restart`), the workflow that started every workspace and verified its
rows, the cron's copy starts (`keepCurrent` now only re-checks keyed rows),
the copy-pass counts in the admin report, and the cleanup's pause gate. Still
to go: the gateway's unlayered session arm and the `keyed` flag on the lookup
answer. What stays is the keyed row, the old-copy cleanup, the diagnosis and
the shared-id repair.

The keyed predicate went on 2026-10-26 (Dev2's go to delete the not-keyed
branches): `keyedWorkspace` and the queries asking it (`nodes.isKeyed`,
`noteIds.keyedFor`, `nodeRowMoves.keyedNow`) are gone, and every caller acts
as it did for a keyed workspace. `keyedAt` on the copy row is still written
at birth and is history, never a question. The wire still says `keyed: true`
on the binding, the ingest binding and the lookup, because a gateway or email
worker deployed a step behind refuses an answer without it. Nothing is
`not_keyed` any more: a storage move keeps the rows, the trash empties on
time, old copies are hidden, a share's entry follows its note id, and a
verification counts from the tree. The vault replacement's clear, which
deleted the bucket by key, refuses in every workspace (it always did once
every workspace was keyed) and needs rebuilding on rows before it can come
back. Reintroducing the predicate as a branch fails, among others,
`noteIds/keyedStorageMove.test.ts` ("a workspace whose copy row was never
flipped") and `trash/emptying.test.ts`.

The copy pass itself (`beginCopyPass`, `noteIdsCopy.run`, `copyPage`, `flip`)
is kept only because the test fixture keys a test workspace through it. No
production path starts it. Removing it means rewriting that fixture to write
keyed rows directly.

**The migration** (owner, 2026-10-15). Every row gets its `noteId`. The
mover copies each object to its id key, and the row records the version of the
source it copied; a copy counts only while the note's current version still
equals that one, so an edit landing during or after a copy makes it stale and
the next pass copies it again. Staff watch the share copied, restart and
diagnose it in the admin console. One global switch moves readers to the id
keys, and from the switch on every write goes to both keys, so a switch back
loses nothing. A read at the id key falls back to the path while that row's
copy is stale. Old keys are deleted seven days after the owner confirms the
switch.

**What this supersedes.** The bucket as canonical for names
([convex-tree](../app-and-console/convex-tree.md): sweeps, parity, the phase 3
privacy authority and phase 4 queued moves), folder moves in
[storage-move-engine](../app-and-console/storage-move-engine.md),
[queued-trash](../app-and-console/queued-trash.md), and the stable on-bucket
layout with `index.md` and `privacy.md` at root. Those records stay as
history until the code they describe is deleted.

What a "simplification" would cost: reading a name, a folder or a rule from
the bucket again brings back a second answer that disagrees with the rows,
and keying bytes by path brings back copies on every move.

## A workspace made after the switch is keyed by the cron

*Found 2026-10-22: five workspaces made that morning showed "Differs" in the
console.* `startAll` and the switch to `keys` reach only the workspaces that
exist when they run, and the 15-minute `noteIds.keepCurrent` used to continue
only passes that had already started. A workspace made later had no copy row,
so nothing ever copied or flipped it: it stayed on path keys, and the console
fell back to the old bucket check. Now, with the switch at `ids` or `keys`,
the cron starts the first pass of any live workspace with no copy row (or an
idle one) once its tree is ready, at most `FIRST_COPIES_PER_TICK` a tick, and
that pass's end flips it. A finished, complete pass that is still unkeyed in
keys mode (its flip ran before the tree was ready) is flipped again. Removing
either fails `__tests__/noteIds/firstCopy.test.ts`.

## A new workspace is born keyed

*Decided by the owner, 2026-10-22* ("make sure that new and current workspaces
are all notes by id"). A workspace bound to its own new managed bucket, with no
tree rows, tree state or copy row yet, is keyed at that binding
(`lib/noteIds/born.ts`, from `storage.applyBinding`): its copy row is written
done and keyed, and its tree ready (a keyed workspace is never swept, so
nothing else would make it serve). Its first notes are written at their id
keys. The born-keyed call no longer checks a switch, since there is none.
Removing it fails `__tests__/noteIds/bornKeyed.test.ts`.

## A storage move keeps a keyed workspace's tree

*Found 2026-10-22.* `applyBinding` forgot the whole tree when a workspace's
storage moved to another bucket, because the rows used to be copies of the old
bucket's names. In a keyed workspace the rows are the only names there are, and
the keys (`notes/<noteId>.md`) move as they are, so forgetting them left the
workspace empty with nothing able to rebuild it. A keyed workspace now keeps
its rows, links, grants and log (`keepKeyedTreeForStorage`); only queued byte
moves and the small-data sync state go, and a diagnosis checks every key in the
new bucket so rows take its versions (a move may seal or unseal them).
Forgetting the rows again fails `__tests__/noteIds/keyedStorageMove.test.ts`.

## Moves in a keyed workspace are row changes

*Built on the keyed rows (PR A), 2026-10-15.* In a keyed workspace (every workspace, since
2026-10-22) a move, rename or
archive of a file or folder rewrites `nodes` rows and copies nothing:
`lib/nodes/rowMove.ts` (`applyRowMove`), entered from `startQueuedMove`
(`lib/nodes/moveStart.ts`), which is the one place every move is decided.

- **Refused, nothing written:** a queued byte move still pending; a
  destination, or a path a moved row would take, held by a live row; a file
  under the name with no key yet; a stale expected etag; a name another keyed
  move is still carrying (`CONFLICT`, one move per subtree at a time). There is
  **no** queued byte fallback: the queue would move the frozen path copies the
  bucket still holds, which are not the notes.
- **A folder of any size moves** (built 2026-10-18,
  `lib/nodes/rowMoveChunks.ts`). Within `ROW_MOVE_MAX` (500) live rows a move is
  one mutation. Above it the first mutation makes every whole-move check, moves
  the folder's own row and records the move in `rowMoves`; the rows beneath
  follow in pages of `ROW_MOVE_MAX`, in path order, so a folder always moves
  before what is in it, and row ids are kept. While the record says `moving`,
  the half-moved folder reads as one: listings fold the rows still at the old
  name to the new one (`drawnMoves`), the id layer's lookup finds a note at
  whichever name its row holds now (`throughRowMoves`), and in rows mode each
  access row under either name is read at the other too (`withMovingAccess`),
  so every note is found once and judged by the same rules wherever it sits.
  In file mode the rules are carried before the first mutation and released
  after the last; a page that finds them changed since moves nothing until they
  are carried again. The request pages the move to the end; if it stops, a
  scheduled watchdog (`continueRowMove`) finishes the rows after a lease, and
  asking for the same move again does the bucket's side (the old name's rules,
  forwarding, icons, search) and drops the record. A page is idempotent. A row
  that cannot move (taken meanwhile, unkeyed, or not the mover's to see) stays
  at the old name in a folder of that name, private in rows mode, with what is
  in it. Pins, settings and the folder's job follow once, at the start; the
  emptied folder is retired at the end. **Open gap:** the gateway carries the
  collaboration history of at most `COLLABORATION_RENAME_MAX` (500) moved notes
  in the request (`keyedCollaboration.js`), so in a bigger folder the rest are
  in the known gap below until something retries them.
- **Refused, not moved, when the caller cannot see the whole name:** a folder
  holding a note the caller may not see cannot move in one step.
- **Carried:** the change log (gone at the old path, present at the new one),
  `nodeLinks` sources, and what a queued move already carried (pins, website
  routes, meaning search). Privacy is carried before the rows move and released
  after it, exactly as a queued move does.
- **Collaboration history is carried** (`renameDocument`, `packages/collaboration`).
  After a row move the gateway renames each moved note's heads and state to
  the new name, without reading or writing its bytes: the state's path moves,
  the new name's head is claimed and activated, and the old name's head is
  fenced `moved` with its destination, so an offline editor's commits follow
  it. A note with no history costs one read. The old name's live room is told
  with `moved`; the new name is sent to that room only where the team tier may
  see it, so a move that narrows a note discloses nothing to its members.
  Recovery is journaled: once the new name is claimed, any read of it finishes
  an interrupted rename. A failure before the claim needs a retry of
  `renameDocument`, which nothing makes yet.
- **Body links are rewritten for moves an AI client makes** (`move_note`,
  `move_many`, `move_folder`, `archive`, decided 2026-10-18 when Dev2 asked a
  keyed folder move to keep its links): once the rows and the collaboration
  history have moved, the gateway points every link to a moved note, and every
  relative link inside one, at the new name (`tools/moves/queuedFolder.js`,
  `rewriteRowedLinks`), over the notes the link facts name. A rewrite that
  cannot run is reported as not done and the forwarding record covers it.
  `keyedFolderMove.test.mjs` fails if it is dropped.
- **Not carried yet:** a move made in the console does not rewrite body links
  (forwarding covers them); routines are not re-keyed. The console's path-move
  link rewrite and its test (`linkRewrite.test.ts`) went with the path moves
  (2026-10-22); carrying links on a console rename, as the gateway does with
  `rewriteRowedLinks`, is the open follow-up to the owner's ask that renames
  update links on both sides. Shares need no carrying: they follow the note by
  its id (below).

**Known gap.** A rename can fail before the new name is claimed (the journal
and the state freeze come first). Then the row has moved, the old head is still
active, and nothing names the new one, so a reader of the new name before any
retry starts a new document over the note. The old history stays in the bucket, but the
editors on it are stranded. Nothing retries it yet, and no reconcile rebinds
the new name to the old identity from the forwarding record. Until one does,
staff should not switch a workspace with live collaborative notes to `keys`.
- **Archive** of a note is a move into the archive root, so it is a row change
  too.
- **A batch `move_notes`** (apply, not dry run) is one control-plane call,
  `POST /gateway/moves/batch` (`lib/nodes/rowMoveBatch.ts`), and lands whole or
  not at all. Every move's rules are carried before the rows move, once for the
  batch; the rows move in one mutation (`nodeRowMoves.rowMoveBatch`), whose
  refused move throws, which takes back every move before it. A refusal says
  which move failed and why, as a single move's would. The batch's rows are
  capped together at `ROW_MOVE_MAX`, so two folders each within the cap can
  still be refused. Sequential moves with partial reporting were the
  alternative: a part-applied batch is worse than a refused one, and an agent
  cannot tell from a partial answer what is now in the tree.
- **Trash** in a keyed workspace is a row move too (`lib/nodes/rowTrash.ts`,
  built on 2026-10-15). A note or folder's rows move to
  `.context/trash/<stamp>/<path>`, the destination the queued trash names, so
  the bytes stay at their keys. A second trash in the same millisecond takes
  `<stamp>-2`, `-3`, and so on. The rows carry no privacy rule: the note keeps
  its rules at its own name for Restore. Its links and pins stay where they
  were, as a trash made in one go leaves them. Restore moves the rows back: a
  note, one note out of a trashed folder, or the whole folder, with each row's
  id, key and bytes. A folder over the row cap goes in pages, and comes back in
  pages, as a move does; there is no byte fallback. The `trash` flag on `rowMove` is refused unless one end of the
  move is under `.context/trash`.
- **Trash, Restore and the history.** A trash carries each moved note's heads
  to its trash location, and a Restore carries them back (`renameDocument` with
  `internalTrash`, called from `lib/nodes/rowHistory.ts`), so the trashed note's
  history follows it. A head records the note id of the row it was made for. A
  note opened at a name whose head names another id starts a document of its
  own and leaves the old state untouched (`load.js`, `noteIdAt` from the keyed
  store). So a note created at a trashed note's name never inherits its live
  history, even when the carry failed. The carry is best-effort and never fails
  the row change. A failure before the claim leaves the head at the old name, and
  nothing retries it; a Restore then finds the history where it was. A Restore
  whose carry fails leaves the note with a fresh document.
- **Undo of a new folder, and a plugin's delete,** in a keyed workspace trash the
  rows (`trashKeyedRows`) instead of being refused. Undo still checks that the
  folder holds only its about note, but in a keyed workspace it cannot read that
  note's text (the path holds a frozen copy), so the "edited about note keeps the
  folder" check is not made there: the folder goes to the trash, and Restore
  brings back whatever was typed.
- **The cap counts the name.** `ROW_MOVE_MAX` (500) is the live rows a move
  renames in one transaction, the folder or note itself included. A folder of
  501 rows moves in pages; a batch of 501 rows is refused, since it must land
  whole.

What a "simplification" would cost: a byte move in a keyed workspace moves
frozen copies and leaves the live note where it was, and a trash that moves
bytes leaves the note in place. `keyedTrash.test.ts` (the trash, restore, cap
and name-collision cases) and the cap cases in `keyedRowMove.test.ts` fail if
either is reversed. Refusing big folders again, or reading through a moving one
without its fold, lookup or access copies, fails `keyedChunkedMove.test.ts`.

**A head made before heads recorded ids** (built 2026-10-17, `adoptUnstampedHead`
in `packages/collaboration/src/load.js`). An active head with no note id, at a
name whose row has one, takes the row's id when what it last accepted is the
note's Markdown now (or, before any state, the text it was seeded from). Anything
else is not proven to be the note's history: loading it would write that
history's text over the note, which is what happened to a note created at a
trashed note's name when the trash left the head behind. So the note starts a
document of its own over its Markdown, and the old state is left in the bucket.
The cost is that a note changed outside collaboration while its head had no id
starts a new generation once, and an offline editor on the old one cannot
reattach; the Markdown is never overwritten. `test/rename.mjs` fails if the
check is skipped or stamps without comparing.

**Superseded 2026-10-25:** heads are filed by note id
([paths-on-read](./paths-on-read.md#editing-history-is-filed-by-note-id)), so
a move no longer carries them, and the rename gap and the
`COLLABORATION_RENAME_MAX` gap above apply only to heads the backfill has not
filed yet.

## A move into another workspace, when either end is keyed

*Built 2026-10-17, after a move from @seyi into @supa failed with "this
operation works on paths".* A keyed workspace used to refuse the cross-workspace
move outright, which left no way to move a note between two keyed workspaces.
It runs through the same batches (`functions/contextMoves.ts`), and each end
does its keyed half through its own credential barrier:

- **Out of a keyed workspace,** what moves is listed from the tree's rows
  (`namesListing`), never the bucket, whose paths are frozen copies. Each note
  is read at its key through the store's id layer, its accepted collaborative
  text included. It leaves by the trash (`trashKeyedRows`, only if its key still
  holds the version that was copied; an edit since is a conflict), so it stays
  restorable there with its history, and its rules travel with the row. A moved
  folder's emptied folders follow it into the trash at the end.
- **The version is the key's, never the row's** (2026-10-20, after every move
  of a note out of one workspace stopped with "a note changed while it was being
  moved"). A row's etag is what the tree last heard, and a key can be
  rewritten with no row told (the managed encryption walk seals keys in the
  bare bucket); reading a collaborative note can also finish its Markdown,
  writing the key after it was read. So the version carried is the key's
  after that read, and the trash is checked against the key. A real edit met
  mid-move (an open editor saving) takes the copy back and carries the batch
  again, up to `CONTEXT_MOVE_CONFLICT_RETRIES` times, before the move stops.
  The same holds for every row move that takes a caller's version (a move,
  an archive, a trash, an offline delete, a batch): when the caller holds
  the key's version and the row is behind it, the row catches up to the key
  first (`lib/nodes/rowCatchUp.ts`), and a version that is neither still
  refuses. Workspaces keyed before the walks told rows get one diagnosis
  from the cron (`lib/noteIds/keyedRecheck.ts`). Reverse it and
  `__tests__/nodes/keyedStaleRow.test.ts` fails.
- **Into a keyed workspace,** each note lands as a new note under a new id
  (`keyedCreate`), never at its path; a name already taken stops the move.
- **The gateway's mover is not used** when either end is keyed: it carries
  bucket keys, and a keyed note is not at its path. Production runs rows mode,
  which requires every workspace keyed, so moves there go through the batches.
- **Access in rows mode.** A note that lands narrower than its new folder (a
  private note into a team folder) is asked to be private before it is written,
  and its row is born private (`lib/nodes/arrivalAccess.ts`, pending access). An
  exception written to the rules file would be read by nobody in rows mode, and
  the note would land readable by the destination's team. A full pending list
  stops the move before anything lands.
- **From an AI client,** `move_note` into another workspace asks the same
  engine (`POST /gateway/moves/across`, `tools/moves/acrossKeyed.js`), and
  the gateway writes no bytes itself. The route serves only an owner of the
  source with private access and an editor or owner of the destination, and
  answers every other caller alike. Since 2026-10-26 (Dev2's go to delete the
  not-keyed branches) this is the only cross-workspace move: the gateway's
  path-based copy-then-delete, with its own `confirm_team_publish` and
  rollback, is gone, and a store with no engine refuses before reading
  anything (`test/keyedMoveAcross.test.mjs`). The engine's `contextMoves` row
  is the move's record, so the `POST /gateway/moves` report
  (`recordAgentMove`) has no caller left.

What a "simplification" would cost: listing the bucket in a keyed source plans
the frozen copies, and narrowing through the rules file in rows mode publishes
private notes to a shared workspace's members. `contextMoveKeyed.test.ts` fails
for each (the folder case loops on frozen copies; the rows case lists the notes
to a member). Checking the row's etag again, or reading the version before
the collaboration read, stops a move nobody edited; failing on the first
conflict stops one somebody did. `contextMoveKeyedRace.test.ts` fails for each.

## Emptying the trash

Decided by the owner, 2026-10-17: "30 days, Trash page first". Something in a
keyed workspace's trash is erased for good 30 days after it was trashed. It was
never automatic before; the 7 days elsewhere in this file are for old copies.

- **Never silent.** The Trash page (`?trash=1`, design A in project file
  `trash-page/`) lists what is in the trash, soonest erased first, with "Erased
  this week" in bold red, and Restore on every row. An open trashed note says
  "Erased for good on <day> unless you restore it." There is no Delete forever
  (the owner, 2026-10-14). `trash.listTrash` shows each item only to someone who
  could see it at its own name before it was trashed: with privacy on rows, a
  row trash takes the note's own setting with its row, so the rules under the
  stamp folder are put back at their names before judging
  (`rulesAsTrashed`, `lib/trash/bin.ts`). `trashedNotes.trashedNote` judges the
  same way; it used the live rules alone, which read a note private by its own
  row as its folder's.
- **One stamp folder is one trash.** Each trash takes its own
  `.context/trash/<stamp>` folder, so its age is the stamp, and what was trashed
  comes from the audit trail (`file.archive`, `trash: true`), or from its rows
  when there is no trail.
- **Rows first, in one transaction** (`trash.claimErasure`): it re-asks that the
  workspace is keyed and the trash is past its date, deletes the rows and their
  grants, drops links a trashed note left at a name nothing lives at now, writes
  `file.delete` with `erasedFromTrash` to the audit, and records the notes' id
  keys and trash names in `trashErasures`. From then nothing can restore a note
  whose bytes are going.
- **The bucket after** (`functions/trashEmptying.ts`, `lib/trash/erase.ts`):
  the id keys, then each Markdown note's collaboration history
  (`eraseDocument` in `packages/collaboration/src/erase.js`: document state,
  revisions, journals and the head at the trash name; the old name's fence keeps
  ids only). A failure keeps the erasure with a fixed label for the next day's
  pass (`crons.ts`, "empty the trash"), so no bytes are left that nothing
  remembers.
- **Only keyed workspaces.** A trash made as bytes moved into `.context/trash/`
  is never erased by this, and the page lists nothing there.

What a "simplification" would cost: erasing bytes before rows lets a Restore
bring back a note with no body; erasing without the date check takes a fresh
trash; judging by the live rules shows a member a note that was private to its
owner. `apps/convex/__tests__/trash/emptying.test.ts` and
`packages/collaboration/test/erase.mjs` fail if any is reversed.

**Open:** a trash made the old way (bytes in the bucket) is not listed or
erased. A trashed note's rules at its old name, in file mode, stay after it is
erased, as they did after a trash.

## The gateway refuses every request without a control plane

*Decided by the owner, 2026-10-15.*

The gateway is a control-plane client and nothing else. With
`CONTROL_PLANE_URL` missing, not https (loopback excepted), or with no
`GATEWAY_SECRET`, `fetch` answers `503` JSON naming the setting that is wrong,
never its value, before any route runs. The check sits inside the top-level
catch, so an `env` that throws on first read still answers `500`.

The single-deployment ingestion went with it: the Granola webhook and the
calendar cron wrote through a bucket bound straight to the Worker
(`LOCAL_CONTEXT_BUCKET`), which only a one-person install without a control
plane had. They are removed, with their settings.

What a "simplification" would cost: a request that reaches a route without a
control plane has no tenant to check it against, so it is served on the
gateway's own say-so, and the tenant boundary is a comment. The guard is `test/controlPlaneRequired.test.mjs`, which fails if the entry check is
removed (sabotaged on the commit that added it).

## Old copies are counted, then deleted, by staff

*Built 2026-10-16 (`functions/noteIdsCleanup.ts`, `lib/cleanup/`,
`apps/mcp/src/moves/cleanupPage.js`).* The owner's rule: old keys are deleted
seven days after the owner confirms the switch to keys.

- **Count** is a dry run. It pages the bucket through the mover, counts the
  keys a delete would remove, and how many no row's path or key names. It also
  counts live notes still keyed at something other than their id key. Nothing
  is deleted. A count is fresh for one day.
- **Delete** is refused by name unless: the workspace is keyed, seven days have
  passed since the flip (`keyedAt`), a fresh count finished, and no live note
  still reads from a path. It is also refused while paused or while a run is
  going. The refusal says why in plain words (`lib/cleanup/gate.ts`).
- **What may go:** every key outside `notes/` and `files/`, plus, under
  `.context/`, only `trash/`, `moves/` and `access/`. `.context/collaboration/`
  is customer-owned history and is never deleted, and every other dot-prefixed
  root (`.obsidian/` plugins, `.audit/`, `.history/`) is kept. The gateway repeats this rule
  (`cleanupKeys.js`) before it deletes.
- **Each key is checked again** against the rows as its page is spent. A key
  that a live row is keyed at, or a live unkeyed row sits at, is kept. The page
  plan does the same check, so a row that starts to read a key after the count
  keeps it.
- **A page** lists from a stored cursor, keeps what may go, deletes, and records
  it. A page recorded at a cursor the run has moved past counts nothing. Deleting
  an absent key is a no-op, so a page that failed is simply repeated.
- **Liveness of "reads a path".** A row counts as keyed at its id key when its
  storage key is `notes/<noteId>` or `files/<noteId>.<ext>` for its own note
  id, whatever the extension. A rename that changes the extension does not make
  the note look like it reads its path.

What a "simplification" would cost: deleting without the row re-check deletes a
key a note reads, which loses the note's bytes. That is the failure the
re-check guards. Dropping the wait or the fresh-count gate lets a delete run
before the flip has settled or on a stale view of the rows. Both are guarded by
`__tests__/cleanup/cleanupGate.test.ts` and `cleanupPass.test.ts`, and the
gateway's key rule by `apps/mcp/test/cleanupPage.test.mjs`.

## Two live rows never share an id: the repair

*Built 2026-10-16 on the id copy (staff: Notes by id, "Check for shared ids").*

Before the stop in PR #1731, two live rows could hold one `noteId`. They share one
key, so one would read the other's body once keys are read. `noteIds.sharedIdReport`
pages through a workspace's live file rows by `noteId` and lists each group with its
copy state. `noteIds.repairSharedIds` schedules `repairSharedIdsPage`, which runs
page by page and, per group:

- keeps the id on the row whose copy is fresh under that id's key, else the oldest row;
- gives every other row a new UUIDv7 and clears its copy record, so the next copy
  pass copies its own bytes to its own key;
- carries the id change into `nodeAccessState.snapshot`, the derived copy of each
  row's id that the access derivation keeps (grants are keyed by the row's `_id`, not its id).

In a keyed workspace, a group whose re-id'd row has `storageKey` equal to the shared
key is left untouched and reported `needsLook`: its bytes may be the other row's.

Two rows sharing an id also meant one row's access tokens (`@#<noteId>`) held for the
other, so the repair closes that too. A copy page still in flight when the id changes
records its copy only under the key it was handed (`CopyResult.key`), never under the
row's new key.

What a "simplification" would cost: keeping the newest row, or re-id'ing without the
fresh-copy rule, leaves a note reading another's body; a repair that clears no copy
record leaves the old copy marked fresh under a key that is no longer the row's.
`sharedIds.test.ts` fails for each (the keeper sabotage, and the in-flight copy case).

## A share link follows its note by id

*Built on 2026-10-17.* A share row records the `noteId` of the row it was
minted on (`noteShares.entryNoteId`), stamped at every mint and re-mint. The
read path (`lib/shares/entryNote.ts`, `liveEntryOf`) resolves the share's note by
that id when exactly one live row of the share's kind holds it, and then does
not forward the path again: forwarding a live path could hand the link to
whatever moved away from it. A link therefore reaches its note after any number
of row moves, and a different note later created at the old path never borrows
it.

Where the id cannot answer, the minted path goes through the forwarding ledger
exactly as before: a row minted before the field, a move in a workspace whose
rows are not keyed yet (a byte move that does not carry the id gives the moved
note a new one), and an id two live rows hold. A daily cron
(`shares.stampEntryNoteIds`) fills the id on older rows, resolving each through
the ledger first. Links stay share rows, never a value of a row's access, and
nothing about who may read changes: the path reached is read at `team` scope
through the live access rows, so a link followed into a private folder is
absent.

What a "simplification" would cost. Going back to the path loses links once the
ledger forgets a move, and serves a new note at an old path. Forwarding the
id-resolved path again lets a note that moved away lend its old address's
ledger entry to the link of the note now there. `shareFollowsNoteId.test.ts`
fails on each ("a renamed note opens with no forwarding left", "a note that
moved away does not lend its old path's ledger entry to the note now there").

## The id layout is a constant, not a row

*Decided 2026-10-26.* `/gateway/binding` answers `idLayout: "keys"` on every
deployment. It used to read the retired `noteIdLayout` row, which only a
deployment that ran the migration from the staff console holds. Staging and any
new self-hosted deployment had none, so the gateway, told `keyed: true` with no
id layer, refused every one of their workspaces as having no reachable storage
(the staging Tex check failed this way from 2026-10-22). A staging fixture made
before notes by id has no tree rows, so `stagingPersonas.prepare` keys it the
way a new workspace is born (`lib/noteIds/born.ts`) and the seed writes its
notes again.

What a "simplification" would cost. Reading the row again breaks every
deployment that never held it. `controlPlane/binding.test.ts` fails ("a context
that has never encrypted anything has no encryptionKey key at all" checks the
answer on a deployment with no row).
