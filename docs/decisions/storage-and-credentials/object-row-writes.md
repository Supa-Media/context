# Tree writes go to the workspace object first (2026-11-02)

Decided by the owner, 2026-11-02, choosing "Yes, all tree writes" on "Move saves to write straight to the workspace
object?". Asked "why the heck would we move reads but not writes?" after a save was measured at about 4 to 5 seconds,
most of it control-plane round trips: setting a row's access (median 2.1 s, mostly waiting for the object to catch
up) and recording the note's id (0.9 s), against 1.1 s to write the text itself (production `mcp_entry`, 2026-11-02,
read with the `MCP entry timings` workflow).

## What changes

[Every row write reaches the workspace object](./workspace-object-rows.md) made the object a copy that Convex keeps up
to date: Convex takes every write, and an outbox pushes it across afterwards. That copy step is where a save's
seconds went, and it jammed for a whole afternoon on 2026-11-02. For a workspace whose `home` is `object`, the
direction now flips:

- **The object is the writer of record** for its tree rows, its grant rows and its access rules. A write is one call
  to the object, decided and committed in one transaction there, with the permission check beside it.
- **Convex keeps a mirror, written behind.** The object queues each change it took (an outbox of its own, drained by
  its alarm) and sends it to the control plane (`POST /gateway/rows/mirror`, gateway secret only, the same shape as
  `/gateway/access/mirror`). Convex applies it without opening an outbox entry of its own, so a change never bounces
  back. The mirror is what Convex's remaining readers see until they move to the object, and the rollback.
- **Clocks belong to the object.** The object stamps each row it changes with `at = max(now, held.at + 1)`, and
  remembers that clock (`own_at`) and which fields it changed since Convex last caught up (`own_fields`). The mirror
  sets the Convex row's `objectAt` to that clock. A row Convex still pushes (a writer not moved yet) carries its
  `objectAt`: when it is at least the held `own_at`, Convex has seen the object's writes and the whole row is taken;
  when it is older, the pushed row is taken except for the fields the object owns, so a rename made in Convex still
  arrives while a save's version made in the object is kept. The mirror applies the object's change as an operation
  through Convex's own handlers (the same code the gateway's route ran), so Convex's log and facts stay as they were,
  and it opens no outbox entry, so nothing bounces back. A change Convex refuses is dropped and counted, never
  retried forever: one stuck entry must not hold every later one, which is how the push outbox jammed on 2026-11-02.
  Access versions are minted by the object the same way.
- **A narrowing waits for the mirror; nothing else does.** Taking access away, hiding, moving or deleting answers only
  once Convex has the change, so a reader still on Convex never shows what was taken away (the rule
  `/gateway/access/mirror` already follows). A save's version, size and time, a new note, and anything that only
  widens or keeps access mirror behind and never hold the answer.
- **The gateway's save path makes no control-plane call** for such a workspace: the row lookup, the version record, a
  new note's row and its tier are object calls, and the bucket backup is written behind (`store.defer`), as
  `store/workspaceRouting.js` already says it is.

## First steps that need none of it (2026-11-02)

- An existing note saved without asking for a visibility no longer writes its tier: the write only re-pinned what
  it had, and cost the 2.1 s above on every save (`tools/notes/write.js` `tierKept`; `test/writeKeepsTier.test.mjs`).
- The bucket's backup copy of a save is written behind the response, as `workspace-objects.md` always said: the
  session store never had the request's `waitUntil`, so it was awaited. One key's backup writes still land in the
  order they were made (`store/workspaceRouting.js`; `test/workspaceRouting.test.mjs`, `test/backupBehind.test.mjs`).

## Order of work

The object's write ops, its outbox and the Convex mirror route land first, with saves on them. Access and sharing
writes, file operations (create, move, rename, copy, archive, trash, restore, delete) and the background writers
(trash emptying, purge, old copies, id copies, facts, Tex group homes) then move onto the same ops. Readers move off
Convex's tables in parallel (the app's listing and change feed, the gateway's manifest, names, jobs, id lookups and
binding rules), because each already has the object's rows to read. When nothing reads Convex's node tables for a
workspace on its object, the mirror stops and the tables go, as the switch already plans for its rollback copies.

## What a simplification would cost

Writing the object and Convex side by side from the gateway, both awaited, keeps every save's control-plane round
trip, which is the cost this removes. Letting a narrowing answer before the mirror lands lets the app's Convex listing
show a note its owner just made private. Letting Convex's older push overwrite the object's newer row silently undoes
saves. Tests: added with each step, named in this file as they land.

## The object renders its own rules (2026-11-03)

The first step of moving access writes: the object holds the grant rows and renders the member and guest rules
itself, before anything is judged by them. Every push that carries rules (`lib/rowWatch/drain.ts`) also carries the
**access set** they were rendered from, read beside them (`nodesPrivacy.accessSet`,
`lib/nodes/accessSet.ts`): each row that carries a setting, keyed by its token id (`@#<id>`) and kind, with its base
and its grantees in the `nodeAccess` shape (`{kind, id, role}`), the access version, the private paths still pending
their row, and whether `accounts` grants are honoured and the chat homes sealed here. It rides the round's last
call, once every row of the round is held. The object keeps it in `ws_access` (`workspaceStore/accessRows.js`),
whole, unless it holds a later version, places each record at its own live row's path (the sent path only for a
row it no longer holds), applies the same overlays as `accessRowsOf` with the same `renderAccess`, and records
whether the result equals the rules it holds (`ws.access.state`; `ws.access.check` compares without keeping
anything, for the read-only production run, `Workspace object access parity`). A chunked move part way through is
skipped: its rules name both paths.

Nothing reads the rendered rules yet, and a set the object refuses never fails the push it rides on: the pushed rules
stay the only thing reads are judged by until the access writers move onto `ws.write.access` and the parity report has
stayed equal. A grant taken back is gone from the next set, and an older set never replaces a newer one, so a
replayed push cannot bring it back (`apps/mcp/test/workspaceAccessRows.test.mjs`,
`apps/convex/__tests__/nodes/objectAccessParity.test.ts`).

## Landed: the Convex mirror (`objectAt`)

Convex keeps `nodes.objectAt`, the object's clock of the last change it made to the row. `POST /gateway/rows/mirror` (`functions/lib/gatewayRoutes/rowsMirror.ts`) takes a batch in order and calls `functions/objectRowsMirror.ts` `wrote` per change, built with `internalMutationMirrored` (no outbox entry, no push). A refused or missing row is `{ applied: false, reason }`, never a throw. Tests: `__tests__/objectRowsMirror.test.ts` (keyed write opens no outbox entry; `objectAt` never goes backwards; missing and refused rows; route order, bad body, transient stop). Sabotage: building `wrote` with the watched `internalMutation` fails the outbox case. `objectAt` is outside the object digest (`__tests__/workspaceObjects.test.ts`).

## File operations in the object (2026-11-03)

`apps/mcp/src/workspaceStore/treeOps.js` holds create folder, move and rename, trash, restore and delete over the
object's rows, with the refusals Convex's row move gives (`rowMove.ts`, `rowTrash.ts`, `archiveTwins.ts`,
`sealedChats.ts`), each one synchronous run of SQL so the object commits it whole. A folder move rewrites every path
under it in that one transaction: nothing is chunked, because a workspace's rows fit in its object. A note outside the
trash is never deleted in one step; it goes to the trash, as Convex refuses a keyed delete. Each answer names the rows
it wrote and the ids it removed with their clocks, for the outbox. Rows the object makes take ids `o_` and 32 hex
characters. Whether the caller may see what it moves is the caller's `judge`, built from the rules it holds. Tests:
`apps/mcp/test/treeOpsMove.test.mjs`, `apps/mcp/test/treeOpsTrash.test.mjs`.

## Rows the object makes keep the object's id (2026-11-03)

A row the object makes (a folder a move stands up, a new note) has the object's id, `o_` and 32 hex characters, and
Convex takes it behind under its own `_id`. Convex keeps the object's id as `nodes.objectId` (index
`by_workspace_objectId`), every push names such a row by it (`lib/workspaceObjects/rows.ts` `objectIdOf`, the push's
rows and removals and the whole-copy pages), and a mirrored change finds the row through `lib/nodes/objectIds.ts`
`nodeByObjectId`. A row deleted outright no longer has its `objectId` to read, so the row watch keeps it on the outbox
entry (`goneObjectIds`) and the push removes it under that id. Without the column, a Convex insert would come back to
the object as a second row at the same path. Tests: `apps/convex/__tests__/objectRowIds.test.ts` (sabotage: naming the
row by `_id` fails two cases, dropping `goneObjectIds` fails one).

## Access writes in the object (2026-11-03)

`ws.write.access` (`apps/mcp/src/workspaceStore/accessWrite.js`) decides a row's access in the object: its base
(`private` | `team` | `inherit`), its grantee list replaced or added to, or both, with `setAccessRow`'s refusals
(`CONFLICT` on a stale `expectedVersion`, `FORBIDDEN` for a list change by anyone but an owner, any change by a
`member`, or the sealed chat homes by any client but theirs, `NOT_FOUND` for `accounts` outside the pinned workspace
or at edit). It mints the access version (`max(now, held + 1)`), writes the row's record in `ws_access`, renders the
member and guest rules and keeps them as the rules reads are judged by, in one transaction with the mirror's entry.
It answers `NOT_READY` until the object's own rendering has been shown equal to Convex's at the version it holds
(the parity recorded on each push) and `NO_ROW` where no row stands yet; the gateway takes either as "ask the
control plane" and nothing else (`apps/mcp/src/store/objectAccess.js`). The gateway's tier-only changes go there
first; grantee lists and handle resolution stay on the control plane for now.

The mirror (`functions/objectAccessMirror.ts`, op `access` on `/gateway/rows/mirror`) applies the object's change,
not its whole row: the base only when the object changed it, and the grantees it added and took off, onto the list
as Convex holds it. A writer still on Convex can change the same row before the mirror lands; replacing with the
object's list would bring back a grant that writer took away. Convex's version goes to the object's when Convex had
seen nothing the object had not (`baseVersion`), else one above it with an access push queued, so the object takes
the merged set. The object never takes rules or a set at or below a version it minted, so a push read before its
own write landed cannot undo it.

**A narrowing answers before the mirror lands** (`WAIT_FOR_MIRROR` false), for the owner's bar of 0.1 s for every
read and write (2026-11-03; asked on the thread's card, recommended, reversible by the constant). Every gateway read
is judged by the object, which has the change at once. What it costs: for about the mirror's round trip a reader
still on Convex (the app's Convex listing) may show what was just taken away; that window closes as those readers
move to the object. Tests: `apps/mcp/test/accessWrite.test.mjs`, `apps/mcp/test/objectAccessWrite.test.mjs`,
`apps/convex/__tests__/objectAccessMirror.test.ts` ("a tier change from an object behind Convex keeps the list as
Convex holds it").

## Trash and restore are object writes; the tree mirror (2026-11-03)

`ws.write.trash` and `ws.write.restore` (`apps/mcp/src/workspaceStore/treeWrites.js`) run `treeOps` in one object
transaction and answer with one `tree` change: the moved root, any folders stood up, and any rows retired. Convex
takes it through `objectRowsMirror.tree` (`lib/nodes/mirrorTree.ts`), which plans the whole change before writing,
revives or adopts folders by `objectId`, patches the moved root (and, on stored paths, every descendant, refused
past 500), and runs the same follow-ups a Convex-side move runs. Trash narrows and waits for the mirror; restore
does not widen, because **a restore only returns a note to the name it came from**: `from` must be
`.context/trash/<stamp>/<to>`. Letting the caller pick the name would let a member who can see a trashed private
note put it somewhere the team can see. The test is `treeWrites.test.mjs` ("a restore to another name").

While the mirror is in flight, Convex may still push rows the move just changed. Each row the object changes claims
the fields it changed (`own_at`, `own_fields`); a push that disagrees with a claim is skipped, a push that agrees
releases it, a row the object retired stays retired, and a snapshot never drops a row with a live claim
(`rows.js`, tested in `workspaceRowsOwnership.test.mjs`). Dropping any of these lets a stale push undo a move.

## The app trashes and restores through the object (2026-11-03)

For a workspace its object serves, the app sends trash and restore to the gateway (`POST /files/trash`,
`/files/restore`, `apps/mcp/src/live/fileOpsRoute.js`) instead of Convex's `files.trashEntry` /
`files.restoreTrashEntry`. The gateway judges the caller by the scope, groups and user id its session resolved and
nothing in the body; the object answers; Convex follows through the tree mirror, which also writes the person's audit
line (`record.audit`). Any other workspace answers `409 not_object`, and the app falls back to the Convex action, as
it does on a network failure. A refusal is never sent to Convex as well, and neither is `mirror_pending` (the trash
is in the object and lands in Convex on its own).

Trash does not wait for the mirror (decided by the owner, 2026-11-03, for the 0.1 s bar), though the contract above
lists it with the narrowings. Share links, websites, "shared with me" and the console's search resolve a path through
Convex's rows and read the body by key, so for up to the mirror's lag they may still serve a note the person just
trashed, only to people who could open it a moment earlier. Nobody gains access. Moves, which can change who sees a
note, still wait.

## Every object write tells the live tree (2026-11-04)

While the object serves a workspace's tree, the app's tree listens to the object's socket and to nothing else: the
Convex queries are off. A write the object makes itself (`ws.write.*`) therefore has to tell the socket's watchers
what it changed, as a row pushed in from Convex does (`serve.js`). Before this, only a push did, so a trash from the
web landed in the object and the note stayed drawn: "Move to trash" did nothing (reported by the owner,
2026-11-04). The notice is made in one place, `serveWrites.js` `runWriteOp`, after the transaction commits, from the
paths each queued change names (`pathsOfChange`: both ends of a move, folders stood up, a note adopted or written,
and the folders above any rows removed); new rules re-judge everything. A write op added later is covered without
being asked. Moving the notice into each op instead, or dropping it, is what `writesTellTree.test.mjs` fails on.

## New notes and missing paths in the object (2026-11-03)

The owner's bar, 2026-11-03: every read and every write answers in under 0.1 s in production, so nothing on a save's
path waits on Convex.

- **A new note's row is made in the object** (`ws.write.adopt`, `workspaceStore/writeOps.js`), with an `o_` id, and
  Convex takes it behind through the mirror's `adopt` op (`objectRowsMirror.adopt`, which keeps `nodes.objectId`).
  Only the plain case is taken: the note's own id key, a live parent folder, nothing live at the path or holding the
  note id. Everything else answers `DEFER` and the control plane adopts it as before.
- **A new note's bytes and row go in one call** (`ws.create`, `workspaceStore/createNote.js`, added 2026-11-03). The
  bytes are written with the same `absent` condition the put carries, and then the same `adopt` op runs in a
  transaction with its mirror entry. Before this, a create took three trips to the object, about 126 ms of a 195 ms
  save. A held key, an object not holding the notes, or any failure writes nothing there, and the gateway puts as
  before. A `DEFER` keeps the bytes and asks the control plane to adopt them, as after the gateway's own put. The
  bucket's backup copy is written after the response. `apps/mcp/test/createInObject.test.mjs` fails if the id layer
  skips that adoption, or if a held key is overwritten.
- **A new private note can leave its find and name checks to that call** (`checks: true`, 2026-11-03). The save
  skips its row lookup and its name-twin check, which cost about 25 to 38 ms side by side, and the object makes the
  checks before writing anything. This applies only when nothing the save does before its put needs those answers:
  a private connection, no etag, no link or images, outside `tex/`, and a note its folders already make private.
  The object declines, writing nothing, if there is a live row at the path, a file on its way, or a case-only twin
  at any depth. It also declines for a top-level name with no row. Because these checks are wider than the gateway's,
  a decline never stands as an answer: the save runs the long way from the start. A served note that is not adopted
  is discarded, and that is treated as a decline. The cost is one extra trip for an overwrite of an existing private
  note without an etag. `apps/mcp/test/checkedCreate.test.mjs` fails in these cases: a team connection leaves its
  checks, a decline is not rerun, a twin is compared case-sensitively, or an unadopted key is left behind.
- **A note meant to be private is adopted only where the object's rules already make it private.** The writer names
  the tier it wrote for (`tier` on the put, `tools/notes/write.js`). The narrowing it persisted first may not have
  reached the object yet, and without that check a member reading the object could see the note before its rule
  lands. A `team` note may be adopted under narrower rules, since its own `team` rule is written right after.
- **A lookup miss is answered by the object** (`absent: true`, `workspaceStore/lookupMiss.js`) when nothing live is
  at the path and nothing reroutes it: no built-in folder's default name standing for another folder, and no Tex folder
  or group chat home, whose new notes are kept in Tex's store under a key only the control plane names. A row the
  reader may not see is never "absent".
- **Known gap:** if Convex makes a row at the same path before the object's adoption reaches it, the mirror answers
  `taken` and drops the change. Both rows then live in the object until the owner of the clash is settled by hand.
  This needs a row made in Convex, not yet pushed, within the same second.

Reversing the tier check fails `writeOps.test.mjs` "a private tier where the held rules make the path team is DEFER". Reversing
the folder-job or Tex check fails `lookupMiss.test.mjs`.

### A new note's tier, before its row (2026-11-03)

A note saved private is given its tier before its bytes are put, so its row does not exist yet when the tier is
asked for. For an object-home workspace the object now keeps that ask itself, as the control plane's
`setPendingAccess` does: `ws.write.access` on a path with no row records a pending base in the access set, mints a
version, and re-renders the rules, so the path is closed to members before the note exists. The change goes to the
mirror as `accessPending` (`objectAccessMirror.pending`), ahead of the adoption that follows it. `ws.write.adopt` then
finds the path private in the rules it holds and takes the note in the object instead of deferring it to the
control plane, and in the same transaction the pending entry becomes the note's own access record
(`accessRows.js` `takePending`). The version does not move on adoption, because the rules already said so. Only a
base can wait: a list change at a path with no row is `NO_ROW`, and the control plane answers it `NOT_FOUND` as
before. A team entry is kept but not rendered, so the path inherits. That is the narrower answer under a private
folder, as `withPendingPrivate` has it. Reversing this costs a new private note one control-plane round trip for its
tier and another for its adoption; `apps/mcp/test/accessPending.test.mjs` fails if it is reversed.

### A member's grants taken out in the object (2026-11-03)

`ws.write.dropGrantee` (`accessDrop.js`) takes one account's own `user` grants out of every row of an object-home
workspace in one minted version, with the rules re-rendered once. An owner may do it, and so may the account itself
when it leaves. It mirrors to `objectAccessMirror.dropGrantee`, which calls the same `removeUserGrantsIn` the control
plane uses, so the audit row is the same. There is no cap: a grant left behind would reach an outsider. Email grants
stay, as in `removeUserGrants.ts`. `apps/mcp/test/accessDrop.test.mjs` fails if a held grant survives the drop.

### A move's narrowing in the object (2026-11-03)

`ws.write.narrowMoves` (`accessMove.js`) does what `narrowRowsForMoves` does in the control plane, but in the object.
For each move it computes carry = the narrower of the effective tier at `from` and the folder tier at `to`. When the
move would widen the row, the moved row is pinned to that base on its own record, before the move, so the move
carries it. A batch is judged move by move. Each move uses the rules left by the moves before it, so the whole batch
gets one minted version and one `narrowBases` mirror change. A tree op that moves rows calls `narrowForMoves` inside
its own transaction and hands both changes to the mirror in order as `changes` (`serveWrites.js`).
`apps/mcp/test/accessMove.test.mjs` fails if a widening move is left unpinned.

## Moves and renames in the object (2026-11-03)

`ws.write.move` (`apps/mcp/src/workspaceStore/moveWrites.js`) moves or renames a note or folder in one object
transaction: `treeOps.move` decides every refusal first without writing (`check`), then the access narrowing the move
needs (`accessMove.js` `narrowForMoves`) is written, then the rows move, and the mirror gets the narrowing before the
tree change. The app sends a move there through `POST /files/move` when the object serves the workspace, except a
rename that also rewrites the note's first heading, which edits text and stays with the control plane.

The object takes only the plain case and answers `DEFER` for the rest, which the app sends to `files.moveEntry`: a
folder with a job or holding one, a folder inside a job's folder (the Inbox's and Tex's own folders), a folder moved to
the top level (its name can give it a job), a destination twinned by case, and any workspace whose access set the
object may not yet decide by. Moving those here would skip the control plane's refusals for them. Like access writes,
a move does not wait for the mirror (`WAIT_FOR_MIRROR`). `trash: true` is accepted only into `.context/old-copies/`, for
hiding old copies. Removing the check-first order would let a refused move keep its narrowing; the test is
`moveWrites.test.mjs` ("a move that would narrow to a taken name").

AI clients' `move_note` and `move_folder` take the same path (`apps/mcp/src/tools/moves/objectMove.js`, called first by
`queuedFolder.js`). The object judges the caller by this request's session (`store.objectReading`: its scope, groups,
user id, and whether it may write), never by the tool call, and a caller that names its own scope (a system sweep) goes
to the control plane. `DEFER`, `UNKEYED`, an unreachable object or an unknown answer fall back to
`/gateway/moves/start` unchanged; nothing moved in any of them. What the control plane's row move did beside the rows is
done in the gateway: open editors are told, the change is recorded, and the forwarding ledger and folder icons follow
behind the answer; links follow when the mirror takes the move. The tests are `apps/mcp/test/objectMove.test.mjs`.

A move into Archive, `archive_note` included, is taken in the object too (2026-11-03): the tree mirror marks the
Archive twins of the built-in folders on its way (`markArchiveTwins` in `lib/nodes/mirrorTree.ts`), as a row move into
Archive does, and a trash marks nothing. Carrying a built-in folder's twin after it is still the control plane's: a
folder with a job defers. Before this, an archive asked of the control plane took about 10 s in production and the
gateway gave up at the 8-second lookup timeout, so every one answered "could not start the move right now" though it
had moved. A move asked of the control plane now waits `CONTROL_PLANE_MOVE_TIMEOUT_MS` (30 s), and one it gives up on
is told as one that may still finish. Removing the mark fails `objectRowsMirrorTree.test.ts` ("a move into Archive").

`archive_note` asks the object before it reads anything else (`tools/moves/archive.js`): not the note's text, its
editing history or the tree's names. Since 2026-11-04 it is one trip: the gateway sends `archive: {root, roots}` (the
rules' archive) in place of a destination, and the object finds the folder doing the Archive's job as the caller sees
it, refuses a note already under it or under a rules root (`ARCHIVED`) or with no archive at all (`NO_ARCHIVE`), and
names the first free numbered destination itself (`moveWrites.js` `archiveTo`), so no `jobs` ask goes first (about
25 ms). An absent or hidden note is `NOT_FOUND` before anything about the archive. A `DEFER` falls through to the
control plane without asking the object a second time. With those reads, an archive in the object still took
2.45 s in production (2026-11-03). A folder move the control plane times out on is told as one that may still finish,
never "Nothing was changed", and is not moved the old way on top: 93 notes took 9.2 s and all moved while the answer
said nothing had (`keyedNoteMove.test.mjs`, "a keyed folder move the gateway gave up on").

A move answers only once its writes are durable (decided by the owner, 2026-11-04). The object's wait for that,
about 45 ms in production (`inside:move_commit`), is the floor of every move and archive, and answering before it
(`allowUnconfirmed`, or a reply before `storage.sync()`) would confirm a move a crash could still lose. Moves get faster
by cutting the trip to the object instead. Every write the object makes for a move, the mirror's flush alarm included,
lands before that one wait (`serveWrites.js`), so the output gate never holds the answer for a second flush that
`commit` does not see (`moveWrites.test.mjs`, "a move sets its flush alarm before waiting for durable writes").

## Copies in the object (2026-11-03)

The app's Copy and Duplicate of one Markdown note go to the gateway (`POST /files/copy`, `/files/duplicate`,
`apps/mcp/src/live/fileCopy.js`) when the object serves the workspace. The gateway reads the note's current text (its
shared-editing document where it has one, as `copyPath` reads it), puts it at the new name with `onlyIf: absent`, and
the object adopts it as a new note (`ws.write.adopt`); the bucket's backup copy and Convex's row follow behind. The
copy is not one object transaction: the text goes to the object's body store and the row to its rows, which is the
same order every new note's save takes.

What travels is `copyPrivacy`'s inherited case: a note private only because of its folder gets an exact private rule
before its text lands in a team folder; otherwise the copy takes its new folder's tier. Anything else is left to the
control plane (`defer`, which the app sends to `files.copyEntry` / `files.duplicateEntry`): a folder, a file that is
not a note, a source or destination with its own rule, a source seen through a group or a person, or a chat's sealed
home. The caller is judged by the session, source first, so a source they cannot see is `not_found` whatever the
destination holds. Duplicate tries the control plane's "… copy", "… copy 2" names in order against every live name,
seen or not, and leaves the choice to the control plane after 20. The tests are `apps/mcp/test/fileCopy.test.mjs`.

## People added by name in the object (2026-11-04)

Adding people to one row's list (`addRowPeople`, `set_visibility`'s `people`) is written in the workspace object
first when it serves the workspace (`objectFirstAddGrantees`, `apps/mcp/src/store/objectAccess.js`): `ws.write.access`
with `mode: "add"`, an email as an `email` grantee and a `@name` from the object's own cache of resolved handles
(`ws_handles`, `apps/mcp/src/workspaceStore/handleCache.js`). A name the object has not been told answers `RESOLVE`
with nothing written; the gateway asks the control plane once (`/gateway/privacy` `resolveHandles`, read only, owner
only, `apps/convex/functions/gatewayHandles.ts`) and sends the answer back with the same write, which keeps it. A name
nobody holds is `GRANTEE_NOT_FOUND`, as before. Owner only, as the control plane's list is; anything the object cannot
decide alone goes to the control plane's `addGrantees` (decided by the owner, 2026-11-04: names cached in the gateway
so a repeat add skips Convex).

Why a cache is safe: a username or group name is released only when its account or group is deleted, so a stale
entry points at someone who no longer exists and grants nobody. Entries are kept an hour (`HANDLE_TTL_MS`), so a name
re-claimed by someone new is resolved afresh within it, and a group resolves only within its own workspace. The
tests are `accessHandles.test.mjs`, `objectAddGrantees.test.mjs` and `apps/convex/__tests__/gatewayHandles.test.ts`.
