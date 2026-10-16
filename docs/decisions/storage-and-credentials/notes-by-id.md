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
- There is no gateway mode without a control plane, and no Dropbox store.

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

## Moves in a keyed workspace are row changes

*Built on the keyed rows (PR A), 2026-10-15.* In a keyed workspace (switch at
`keys` and the flip started, `lib/noteIds/keyedState.ts`) a move, rename or
archive of a file or folder rewrites `nodes` rows and copies nothing:
`lib/nodes/rowMove.ts` (`applyRowMove`), entered from `startQueuedMove`
(`lib/nodes/moveStart.ts`), which is the one place every move is decided.

- **Refused, nothing written:** a queued byte move still pending; a
  destination, or a path a moved row would take, held by a live row; a file
  under the name with no key yet; a stale expected etag; more than
  `ROW_MOVE_MAX` (500) live rows, answered `FOLDER_TOO_LARGE`. Above the cap
  there is **no** queued byte fallback: the queue would move the frozen path
  copies the bucket still holds, which are not the notes.
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
- **Not carried yet:** body links are not rewritten (forwarding covers them);
  shares and routines are not re-keyed.

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
  id, key and bytes. The row cap applies (`FOLDER_TOO_LARGE`, nothing moved): no
  byte fallback. The `trash` flag on `rowMove` is refused unless one end of the
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
  renames, the folder or note itself included. A folder of 501 rows is refused.

What a "simplification" would cost: a byte move in a keyed workspace moves
frozen copies and leaves the live note where it was, and a trash that moves
bytes leaves the note in place. `keyedTrash.test.ts` (the trash, restore, cap
and name-collision cases) and the cap cases in `keyedRowMove.test.ts` fail if
either is reversed.

**Open:** collaboration heads are still path-keyed. They now record the note id
they were made for, so a name cannot pass one note's history to another, but
keying the heads by note id would remove the carry entirely. A head created
before this change has no id and is not checked: a trashed note whose head was
left at its name before this change can still pass its history to a note later
created there. The rename gap in the section above is the other open item for a
workspace with live collaborative notes.

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
